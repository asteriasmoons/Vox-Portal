// Feature Idea end-to-end orchestrator.
//
// Structurally mirrors src/bugs/service.ts createBug(): identical call
// sequence, identical error semantics, identical helper shape. Only the
// data types and destinations differ (idea table + Rich Message layout +
// GitHub Discussion instead of Issue).
//
// Steps:
//   1. Reserve IDEA-#### atomically.
//   2. insertIdea → row with id.
//   3. postIdeaChannelTicket (sendMessage HTML, disable_web_page_preview true).
//   4. waitForDiscussionMirror; throw if missing (bug flow throws too).
//   5. setIdeaTelegramLinkage(channel_message_id, mirror, thread).
//   6. postIdeaReportToThread → Rich Message via sendRichMessage with
//      message_thread_id + reply_parameters (same params bugs use).
//   7. Attachments loop with 1100ms pacing + Bot API 429 retry.
//   8. GitHub Discussion comment (best-effort, does not affect Telegram).
//   9. Reporter confirmation DM.

import type { Env } from "../config";
import { discussionChatId } from "../config";
import {
  insertIdea, nextIdeaNumber, setIdeaTelegramLinkage, saveIdeaGitHubMeta,
  insertIdeaAttachment, setIdeaAttachmentPostedMessage, getIdea,
  listIdeaAttachments,
  updateIdeaStatus as dbUpdateIdeaStatus,
} from "../db/queries";
import type { IdeaRow, NewIdeaInput, IdeaAttachmentRow } from "../db/types";
import {
  sendMessage, TelegramError, type TelegramMessage,
} from "../telegram/api";
import {
  postIdeaChannelTicket,
  postIdeaReportToThread,
  postIdeaTelegramAttachmentToThread,
  postIdeaR2AttachmentToThread,
  refreshIdeaRichReport,
  waitForIdeaDiscussionMirror,
} from "../telegram/channel";
import {
  renderIdeaReporterDm, renderIdeaSubmissionConfirmation, ideaPublicId,
} from "./formatting";
import {
  resolveIdeaDiscussion, ideaStatusMeta, type IdeaStatusId,
} from "./constants";
import { addDiscussionComment } from "../github/discussions";
import { esc } from "../util/html";
import { log } from "../util/log";

export type IncomingIdeaAttachment =
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

// Single entry point. Mirrors createBug's shape and error semantics — any
// step that must succeed for the Telegram record to exist throws, so the
// Mini App API surfaces a 500 instead of a silent partial success.
export async function createIdea(
  env: Env,
  input: NewIdeaInput,
  attachments: IncomingIdeaAttachment[],
): Promise<IdeaRow> {
  const publicNumber = await nextIdeaNumber(env);
  let row = await insertIdea(env, input, publicNumber);
  log.info("idea_created", { ideaId: row.id, publicNumber });

  // 1) Channel ticket — throws on failure (bug flow does too).
  let channelMessageId: number;
  try {
    channelMessageId = await postIdeaChannelTicket(env, row);
  } catch (e) {
    log.error("idea_channel_post_failed", e, { ideaId: row.id });
    throw e;
  }
  row = { ...row, channel_message_id: channelMessageId };

  // 2) Discussion mirror + Rich Message report.
  const mirrorMessageId = await waitForIdeaDiscussionMirror(env, channelMessageId);
  if (!mirrorMessageId) {
    for (const att of attachments) await persistAttachment(env, row.id, att);
    log.error("idea_discussion_mirror_missing", new Error("mirror not received"), {
      ideaId: row.id, channelMessageId,
    });
    throw new Error("telegram_comment_mirror_missing");
  }

  await setIdeaTelegramLinkage(env, row.id, channelMessageId, mirrorMessageId, mirrorMessageId);
  row = { ...row, discussion_message_id: mirrorMessageId, discussion_thread_id: mirrorMessageId };

  const reportMessage = await postIdeaReportToThread(env, row, mirrorMessageId);
  if (!reportMessage) {
    log.error("idea_report_post_missing", new Error("no report message"), { ideaId: row.id });
    throw new Error("telegram_comment_post_failed");
  }
  row = { ...row, report_message_id: reportMessage.message_id };

  // 3) Attachments — same 1100ms pacing + 429 retry pattern as bugs.
  for (const att of attachments) {
    try {
      await sleep(1100);
      await persistAndPostAttachment(env, row, att);
    } catch (e) {
      log.error("idea_attachment_post_failed_nonfatal", e, {
        ideaId: row.id,
        source: att.source,
        kind: att.kind,
        mime: att.source === "r2" ? att.mime : att.mime ?? null,
        fileName: att.source === "r2" ? att.file_name : att.file_name ?? null,
        sizeBytes: att.size_bytes ?? null,
      });
    }
  }

  // 4) GitHub Discussion comment (independent destination — Telegram is
  // already committed, so GitHub failure is logged and does not throw).
  await maybePostGitHubDiscussion(env, row, attachments);

  // 5) Reporter confirmation DM.
  try {
    await sendMessage(env, input.reporter_tg_id, renderIdeaSubmissionConfirmation(row), { parse_mode: "HTML" });
  } catch (e) { log.warn("idea_confirmation_failed", { ideaId: row.id, err: String(e) }); }

  return (await getIdea(env, row.id)) ?? row;
}

async function maybePostGitHubDiscussion(
  env: Env,
  row: IdeaRow,
  attachments: IncomingIdeaAttachment[],
): Promise<void> {
  const target = resolveIdeaDiscussion(row.app);
  if (!target) {
    const reason = `No Ideas discussion configured for "${row.app}"`;
    log.info("idea_github_no_mapping", { ideaId: row.id, app: row.app });
    await saveIdeaGitHubMeta(env, row.id, { github_status: "skipped_no_mapping", github_error: reason });
    return;
  }
  if (!env.GITHUB_TOKEN) {
    log.warn("idea_github_disabled", { ideaId: row.id });
    await saveIdeaGitHubMeta(env, row.id, { github_status: "skipped_disabled", github_error: "GITHUB_TOKEN not configured" });
    return;
  }
  const { renderIdeaGitHubComment } = await import("./formatting");
  const attNotes = attachments.map((a) => a.source === "r2" ? a.file_name : (a.file_name ?? `${a.kind} attachment`));
  const body = renderIdeaGitHubComment(row, attNotes);
  const res = await addDiscussionComment(env, target, body);
  if (res.ok && res.comment_id && res.comment_url) {
    await saveIdeaGitHubMeta(env, row.id, {
      github_repo: `${target.owner}/${target.repo}`,
      github_discussion_id: target.discussion_node_id,
      github_discussion_url: target.discussion_url,
      github_comment_id: res.comment_id,
      github_comment_url: res.comment_url,
      github_status: "created",
      github_error: null,
      github_created_at: Math.floor(Date.now() / 1000),
    });
    const fresh = await getIdea(env, row.id);
    if (fresh) await refreshIdeaRichReport(env, fresh);
    await postIdeaGitHubPreviewToThread(env, fresh ?? row, res.comment_url);
  } else {
    const reason = res.error ?? "unknown";
    log.warn("idea_github_failed", { ideaId: row.id, reason });
    await saveIdeaGitHubMeta(env, row.id, { github_status: "failed", github_error: reason.slice(0, 200) });
  }
}

export async function postIdeaGitHubPreviewToThread(
  env: Env,
  row: IdeaRow,
  url = row.github_comment_url,
): Promise<void> {
  if (!url || !row.discussion_thread_id) return;
  const replyToMessageId = row.report_message_id ?? row.discussion_message_id ?? row.discussion_thread_id;
  try {
    await sendMessage(env, discussionChatId(env),
      `<b>GitHub Discussion</b>\n${esc(url)}`,
      {
        parse_mode: "HTML",
        message_thread_id: row.discussion_thread_id,
        reply_parameters: { message_id: replyToMessageId },
        disable_web_page_preview: false,
        link_preview_options: {
          is_disabled: false,
          url,
          prefer_large_media: true,
          show_above_text: false,
        },
      });
  } catch (e) {
    log.warn("idea_crossref_failed", { ideaId: row.id, err: String(e) });
  }
}

// Attachment posting with 429-aware retries, matching bug flow.
async function persistAndPostAttachment(env: Env, row: IdeaRow, att: IncomingIdeaAttachment) {
  const inserted = await persistAttachment(env, row.id, att);
  const posted = await postAttachmentWithRetry(env, row, att);
  if (!posted) {
    log.error("idea_attachment_post_missing", new Error("no attachment message"), {
      ideaId: row.id, attachmentId: inserted.id,
    });
    throw new Error("telegram_idea_attachment_post_failed");
  }
  await setIdeaAttachmentPostedMessage(env, inserted.id, posted);
}

async function postAttachmentWithRetry(env: Env, row: IdeaRow, att: IncomingIdeaAttachment): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return att.source === "telegram"
        ? await postIdeaTelegramAttachmentToThread(env, row, att.kind, att.telegram_file_id)
        : await postIdeaR2AttachmentToThread(env, row, att.bytes, att.mime, att.file_name);
    } catch (e) {
      if (!(e instanceof TelegramError) || e.error_code !== 429 || attempt === 2) throw e;
      const retryAfter = Number((e.parameters as { retry_after?: number } | undefined)?.retry_after ?? 1);
      await sleep(Math.max(1100, (retryAfter + 0.1) * 1000));
    }
  }
  return null;
}

async function persistAttachment(env: Env, ideaId: number, att: IncomingIdeaAttachment): Promise<IdeaAttachmentRow> {
  const shared = {
    idea_id: ideaId,
    kind: att.kind,
    mime_type: att.source === "telegram" ? att.mime ?? null : att.mime,
    file_name: att.source === "telegram" ? att.file_name ?? null : att.file_name,
    size_bytes: att.size_bytes ?? null,
  };
  if (att.source === "telegram") {
    return await insertIdeaAttachment(env, {
      ...shared,
      telegram_file_id: att.telegram_file_id,
      width: att.width ?? null,
      height: att.height ?? null,
    });
  }
  return await insertIdeaAttachment(env, { ...shared, r2_key: att.r2_key });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Resend to Telegram ─────────────────────────────────
// Idea-specific equivalent of resendBugToTelegram. It never calls bug endpoints
// or reads bug rows, so IDEA-0001 can never accidentally resend BUG-0001.
export async function resendIdeaToTelegram(
  env: Env,
  ideaId: number,
  opts: { force?: boolean } = {},
): Promise<{ row: IdeaRow; telegram: "posted" | "already_posted" | "failed" }> {
  let row = await getIdea(env, ideaId);
  if (!row) throw new Error("idea_not_found");

  // A manual resubmit is intentionally allowed even when the original Rich
  // Message already posted. Reuse the existing channel ticket/discussion
  // mirror and post a fresh copy of the Idea report into the same comments,
  // matching the bug-report resubmit behavior.

  // If there is no usable channel ticket, create a fresh one.
  let channelMessageId = row.channel_message_id;
  if (!channelMessageId) {
    try {
      channelMessageId = await postIdeaChannelTicket(env, row);
    } catch (e) {
      log.error("idea_resend_channel_post_failed", e, { ideaId });
      return { row, telegram: "failed" };
    }
    row = { ...row, channel_message_id: channelMessageId };
  }

  // Resolve the exact auto-forwarded channel mirror, then persist it on the idea row.
  let mirrorMessageId = row.discussion_message_id
    ?? await waitForIdeaDiscussionMirror(env, channelMessageId, 8000);
  if (!mirrorMessageId) {
    // A stale/legacy channel post cannot be recovered reliably: create a new
    // channel ticket for the SAME idea and wait for its fresh mirror.
    channelMessageId = await postIdeaChannelTicket(env, row);
    mirrorMessageId = await waitForIdeaDiscussionMirror(env, channelMessageId, 8000);
    if (!mirrorMessageId) {
      log.error("idea_resend_mirror_missing", new Error("no discussion mirror"), { ideaId, channelMessageId });
      return { row, telegram: "failed" };
    }
  }

  await setIdeaTelegramLinkage(env, row.id, channelMessageId, mirrorMessageId, mirrorMessageId);
  row = { ...row, channel_message_id: channelMessageId, discussion_message_id: mirrorMessageId, discussion_thread_id: mirrorMessageId };

  const reportMessage = await postIdeaReportToThread(env, row, mirrorMessageId);
  if (!reportMessage) {
    row = (await getIdea(env, ideaId)) ?? row;
    return { row, telegram: "failed" };
  }
  row = { ...row, report_message_id: reportMessage.message_id };

  if (row.github_comment_url) {
    await postIdeaGitHubPreviewToThread(env, row);
  }

  const stored = await listIdeaAttachments(env, row.id);
  for (const a of stored) {
    if (a.posted_message_id) continue;
    try {
      await sleep(1100);
      let posted: number | null = null;
      if (a.telegram_file_id) {
        posted = await postIdeaTelegramAttachmentToThread(env, row, a.kind, a.telegram_file_id);
      } else if (a.r2_key) {
        const obj = await env.ATTACHMENTS.get(a.r2_key);
        if (obj) {
          posted = await postIdeaR2AttachmentToThread(
            env, row, await obj.arrayBuffer(),
            a.mime_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream",
            a.file_name ?? "attachment",
          );
        }
      }
      if (posted) await setIdeaAttachmentPostedMessage(env, a.id, posted);
    } catch (e) {
      log.warn("idea_resend_attachment_failed", { ideaId, attachmentId: a.id, err: String(e) });
    }
  }

  // GitHub is independent and idempotent from the user's perspective: only
  // retry it when no Discussion comment exists yet.
  row = (await getIdea(env, ideaId)) ?? row;
  if (!row.github_comment_id) {
    try { await maybePostGitHubDiscussion(env, row, []); }
    catch (e) { log.warn("idea_resend_github_retry_failed", { ideaId, err: String(e) }); }
  }

  return { row: (await getIdea(env, ideaId)) ?? row, telegram: "posted" };
}

// ── Status changes ─────────────────────────────────────
export async function changeIdeaStatus(
  env: Env,
  ideaId: number,
  toStatus: IdeaStatusId,
  adminTgId: number,
  reason: string | null,
): Promise<IdeaRow | null> {
  const change = await dbUpdateIdeaStatus(env, ideaId, toStatus, adminTgId, reason);
  if (!change) return null;
  const row = await getIdea(env, ideaId);
  if (!row) return null;

  await refreshIdeaRichReport(env, row);

  if (row.discussion_thread_id) {
    const from = change.from ? ideaStatusMeta(change.from) : null;
    const to = ideaStatusMeta(change.to);
    const line = from
      ? `${from.emoji} ${from.label} → ${to.emoji} ${to.label}`
      : `→ ${to.emoji} ${to.label}`;
    const replyToMessageId = row.report_message_id ?? row.discussion_message_id ?? row.discussion_thread_id;
    try {
      await sendMessage(env, discussionChatId(env),
        `<b>IDEA STATUS UPDATE</b>\n${esc(line)}${reason ? `\n\n<i>${esc(reason)}</i>` : ""}`,
        {
          parse_mode: "HTML",
          message_thread_id: row.discussion_thread_id,
          reply_parameters: { message_id: replyToMessageId },
        });
    } catch (e) { log.warn("idea_history_post_failed", { ideaId, err: String(e) }); }
  }

  if (change.from !== toStatus) {
    try {
      await sendMessage(env, row.reporter_tg_id, renderIdeaReporterDm(row, change.from), { parse_mode: "HTML" });
    } catch (e) { log.warn("idea_reporter_dm_failed", { ideaId, err: String(e) }); }
  }

  return row;
}
