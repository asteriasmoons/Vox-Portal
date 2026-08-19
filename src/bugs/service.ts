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
  waitForDiscussionMirror,
} from "../telegram/channel";
import { sendMessage } from "../telegram/api";
import { renderReporterDm, renderSubmissionConfirmation } from "./formatting";
import { NOTIFY_ON_STATUS, type StatusId } from "./constants";
import { log } from "../util/log";

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

  // 2) Wait for the auto-forwarded discussion mirror, then reply with details + attachments.
  const mirrorMessageId = await waitForDiscussionMirror(env, channelMessageId);
  if (mirrorMessageId) {
    await setBugTelegramLinkage(env, row.id, channelMessageId, mirrorMessageId, null);
    row = { ...row, discussion_message_id: mirrorMessageId, discussion_thread_id: null };
    try {
      await postReportToThread(env, row, mirrorMessageId);
    } catch (e) {
      log.error("report_post_failed", e, { bugId: row.id });
    }
    for (const att of attachments) {
      try {
        await persistAndPostAttachment(env, row, att);
      } catch (e) {
        log.error("attachment_post_failed", e, { bugId: row.id });
      }
    }
  } else {
    // Still persist attachment metadata even if we couldn't post them yet;
    // an admin retry later can pick them up.
    for (const att of attachments) {
      try {
        await persistAttachment(env, row.id, att);
      } catch (e) {
        log.error("attachment_persist_failed", e, { bugId: row.id });
      }
    }
    log.warn("discussion_thread_missing", { bugId: row.id, channelMessageId });
  }

  // 3) Confirm to reporter
  try {
    await sendMessage(env, input.reporter_tg_id, renderSubmissionConfirmation(row), {
      parse_mode: "HTML",
    });
  } catch (e) {
    log.warn("reporter_confirmation_failed", { bugId: row.id, err: String(e) });
  }

  return row;
}

async function persistAndPostAttachment(env: Env, row: BugRow, att: IncomingAttachment) {
  const inserted = await persistAttachment(env, row.id, att);
  let posted: number | null = null;
  if (att.source === "telegram") {
    posted = await postTelegramAttachmentToThread(env, row, att.kind, att.telegram_file_id);
  } else {
    posted = await postR2AttachmentToThread(env, row, att.bytes, att.mime, att.file_name);
  }
  if (posted) await setAttachmentPostedMessage(env, inserted.id, posted);
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
