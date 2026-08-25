// High-level bug lifecycle: create, add attachments, publish to Telegram,
// notify reporter. This layer is called by BOTH the /bug conversation flow
// and the Mini App API, so both submission paths converge here.

import type { Env } from "../config";
import { discussionChatId } from "../config";
import {
  insertBug,
  nextBugNumber,
  setBugTelegramLinkage,
  insertAttachment,
  setAttachmentPostedMessage,
  getBug,
  updateBugStatus as dbUpdateStatus,
} from "../db/queries";
import type { NewBugInput, NewAttachmentInput, BugRow } from "../db/types";
import {
  postChannelTicket,
  postReportToThread,
  postStatusUpdateToThread,
  postTelegramAttachmentToThread,
  postR2AttachmentToThread,
  refreshChannelTicket,
  refreshRichReport,
  waitForDiscussionMirror,
} from "../telegram/channel";
import { sendMessage, TelegramError } from "../telegram/api";
import { renderReporterDm, renderSubmissionConfirmation } from "./formatting";
import { NOTIFY_ON_STATUS, type StatusId } from "./constants";
import { log } from "../util/log";
import { createIssueForBug, type GitHubOutcome } from "../github/service";
import { discussionChatId as _discussionChatId } from "../config";

// Attachment payload accepted by createBug.
export type IncomingAttachment =
  | {
      source: "telegram";
      kind: "photo" | "video" | "document" | "animation";
      telegram_file_id: string;
      mime?: string;
      file_name?: string;
      size_bytes?: number;
      width?: number;
      height?: number;
    }
  | {
      source: "r2";
      kind: "photo" | "video" | "document" | "animation";
      r2_key: string;
      bytes: ArrayBuffer;
      mime: string;
      file_name: string;
      size_bytes?: number;
    };

// Single entry point for creating a bug end-to-end.
// Steps:
//   1. Reserve a public number (atomic).
//   2. Persist the bug row (status = 'new').
//   3. Post the concise ticket into the channel.
//   4. Wait briefly for Telegram's discussion mirror; if it arrives, post the
//      detailed report + attachments into the correct thread.
//   5. DM the reporter with a confirmation.
//   6. Return the created row.
//
// If step 4 fails (e.g. Telegram outage or mirror not received), the record
// remains and can be retried by the admin — nothing is silently lost.
export async function createBug(
  env: Env,
  input: NewBugInput,
  attachments: IncomingAttachment[],
): Promise<BugRow> {
  const publicNumber = await nextBugNumber(env);
  let row = await insertBug(env, input, publicNumber);
  log.info("bug_created", { bugId: row.id, publicNumber });

  // 1) Channel ticket
  let channelMessageId: number;
  try {
    channelMessageId = await postChannelTicket(env, row);
  } catch (e) {
    log.error("channel_post_failed", e, { bugId: row.id });
    throw e; // let caller retry — DB row remains
  }
  row = { ...row, channel_message_id: channelMessageId };

  // 2) Wait for the auto-forwarded discussion mirror, then create the channel comment.
  // The core submission succeeds once the report body is posted. Attachments are
  // retried and tracked, but a media relay failure should not strand the channel
  // ticket or cause users to resubmit duplicate bugs.
  const mirrorMessageId = await waitForDiscussionMirror(env, channelMessageId);
  if (!mirrorMessageId) {
    for (const att of attachments) await persistAttachment(env, row.id, att);
    log.error("discussion_mirror_missing", new Error("Telegram discussion mirror was not received"), {
      bugId: row.id,
      channelMessageId,
    });
    throw new Error("telegram_comment_mirror_missing");
  }

  await setBugTelegramLinkage(env, row.id, channelMessageId, mirrorMessageId, mirrorMessageId);
  row = { ...row, discussion_message_id: mirrorMessageId, discussion_thread_id: mirrorMessageId };

  const reportMessage = await postReportToThread(env, row, mirrorMessageId);
  if (!reportMessage) {
    log.error("report_post_missing", new Error("Telegram did not return a report comment"), { bugId: row.id });
    throw new Error("telegram_comment_post_failed");
  }

  // Telegram documents a per-chat pacing limit of about one bot message per second.
  // The report comment and its attachments all land in the same linked discussion chat,
  // so space them out instead of firing the media upload immediately after sendMessage.
  for (const att of attachments) {
    try {
      await sleep(1100);
      await persistAndPostAttachment(env, row, att);
    } catch (e) {
      log.error("attachment_post_failed_nonfatal", e, {
        bugId: row.id,
        source: att.source,
        kind: att.kind,
        mime: att.source === "r2" ? att.mime : att.mime ?? null,
        fileName: att.source === "r2" ? att.file_name : att.file_name ?? null,
        sizeBytes: att.size_bytes ?? null,
      });
    }
  }

  // 3) Confirm to reporter
  try {
    await sendMessage(env, input.reporter_tg_id, renderSubmissionConfirmation(row), {
      parse_mode: "HTML",
    });
  } catch (e) {
    log.warn("reporter_confirmation_failed", { bugId: row.id, err: String(e) });
  }

  // 4) GitHub Issue — a SECOND, independent destination.
  // Isolated in its own try/catch so nothing here can retro-invalidate the
  // Telegram submission that already landed. createIssueForBug() itself
  // never throws (it returns structured GitHubOutcome), but we still wrap
  // defensively. On success we post an unobtrusive cross-reference into the
  // discussion thread linking back to the Issue.
  let githubOutcome: GitHubOutcome | null = null;
  try {
    githubOutcome = await createIssueForBug(env, row.id);
    if (githubOutcome.ok && "number" in githubOutcome && !("skipped" in githubOutcome && githubOutcome.skipped === "already_exists")) {
      await postGitHubCrossReference(env, row.id, githubOutcome.repo, githubOutcome.number, githubOutcome.url);
    }
  } catch (e) {
    // This branch is defensive — createIssueForBug is contracted not to
    // throw. Anything that lands here is a bug on our side.
    log.error("github_outcome_unexpected_throw", e, { bugId: row.id });
  }

  // Re-read to pick up any freshly-persisted github_* metadata so the caller
  // (Mini App API / conversation flow) can build a partial-success response.
  return (await getBug(env, row.id)) ?? row;
}

// Posts a small "GitHub Issue: #147" message into the bug's discussion thread.
// Unobtrusive; does NOT modify the ticket message or the report body.
async function postGitHubCrossReference(
  env: Env,
  bugId: number,
  repoFullName: string,
  issueNumber: number,
  issueUrl: string,
): Promise<void> {
  try {
    const row = await getBug(env, bugId);
    if (!row || !row.discussion_thread_id) return;
    const text = `🔗 <b>GitHub Issue:</b> <a href="${issueUrl}">#${issueNumber}</a> · ${repoFullName}`;
    await sendMessage(env, _discussionChatId(env), text, {
      parse_mode: "HTML",
      message_thread_id: row.discussion_thread_id,
    });
  } catch (e) {
    log.warn("github_crossref_post_failed", { bugId, err: String(e) });
  }
}

async function persistAndPostAttachment(env: Env, row: BugRow, att: IncomingAttachment) {
  const inserted = await persistAttachment(env, row.id, att);
  const posted = await postAttachmentWithRetry(env, row, att);

  if (!posted) {
    log.error("attachment_post_missing", new Error("Telegram did not return an attachment comment"), {
      bugId: row.id,
      attachmentId: inserted.id,
    });
    throw new Error("telegram_attachment_post_failed");
  }
  await setAttachmentPostedMessage(env, inserted.id, posted);
}

async function postAttachmentWithRetry(env: Env, row: BugRow, att: IncomingAttachment): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return att.source === "telegram"
        ? await postTelegramAttachmentToThread(env, row, att.kind, att.telegram_file_id)
        : await postR2AttachmentToThread(env, row, att.bytes, att.mime, att.file_name);
    } catch (e) {
      if (!(e instanceof TelegramError) || e.error_code !== 429 || attempt === 2) throw e;
      const retryAfter = Number((e.parameters as { retry_after?: number } | undefined)?.retry_after ?? 1);
      await sleep(Math.max(1100, (retryAfter + 0.1) * 1000));
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistAttachment(env: Env, bugId: number, att: IncomingAttachment) {
  const shared: NewAttachmentInput = {
    bug_id: bugId,
    kind: att.kind,
    mime_type: att.source === "telegram" ? att.mime ?? null : att.mime,
    file_name: att.source === "telegram" ? att.file_name ?? null : att.file_name,
    size_bytes: att.size_bytes ?? null,
  };
  if (att.source === "telegram") {
    return await insertAttachment(env, {
      ...shared,
      telegram_file_id: att.telegram_file_id,
      width: att.width ?? null,
      height: att.height ?? null,
    });
  }
  return await insertAttachment(env, { ...shared, r2_key: att.r2_key });
}

// ── Status changes ──────────────────────────────────────────
export async function changeStatus(
  env: Env,
  bugId: number,
  toStatus: StatusId,
  adminTgId: number,
): Promise<BugRow | null> {
  const change = await dbUpdateStatus(env, bugId, toStatus, adminTgId, null);
  if (!change) return null;
  const row = await getBug(env, bugId);
  if (!row) return null;

  await refreshChannelTicket(env, row);
  // Bot API 10.3 — live-update the Rich Message so Status / Severity /
  // Category and the disabled button set match the new state.
  await refreshRichReport(env, row);
  await postStatusUpdateToThread(env, row, change.from);

  if (NOTIFY_ON_STATUS.includes(toStatus) && change.from !== toStatus) {
    try {
      await sendMessage(env, row.reporter_tg_id, renderReporterDm(row, change.from), {
        parse_mode: "HTML",
      });
    } catch (e) {
      log.warn("reporter_dm_failed", { bugId, err: String(e) });
    }
  }

  return row;
}
