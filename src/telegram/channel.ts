// Posts and edits the channel ticket + discussion thread messages.
//
// Telegram behavior we rely on:
//   • When a channel has a linked discussion group, every channel post is
//     automatically forwarded into that group as a message. That mirrored
//     message's message_thread_id IS the thread id we reply into.
//   • We can watch for that mirror via the `channel_post` update fanning into
//     `message` in the discussion chat, but the simpler and race-free approach
//     used here is: after sending the channel post, poll getUpdates-independent
//     copyMessage/sendMessage into the discussion chat with reply_to_message_id
//     set to the auto-forwarded mirror. We discover that mirror by sending our
//     first thread message with `reply_to_message_id = <mirror>` — Telegram
//     forbids that until the mirror exists, so we retry briefly.
//
// A more robust approach: forwardMessage from the channel to ourselves is not
// permitted for bots; instead, we listen to `message` updates on the discussion
// chat for `is_automatic_forward === true` and record the mapping. That listener
// lives in webhook.ts (handleDiscussionMirror). We store the discovered thread
// id back on the bug row so subsequent status updates & attachments post into
// the correct thread.

import type { Env } from "../config";
import { channelId, discussionChatId } from "../config";
import type { BugRow } from "../db/types";
import {
  sendMessage,
  editMessageText,
  editMessageReplyMarkup,
  sendPhoto,
  sendDocument,
  sendVideo,
  copyMessage,
  tgCall,
  tgCallMultipart,
  type TelegramMessage,
} from "./api";
import { adminActionsKeyboard } from "./keyboards";
import {
  renderChannelTicket,
  renderReportBody,
  renderStatusUpdate,
} from "../bugs/formatting";
import { setBugTelegramLinkage } from "../db/queries";
import { log } from "../util/log";

// Sends the ticket message into the Bug Reports channel.
// Returns the channel message id. The discussion-thread linkage is filled in
// later by handleDiscussionMirror when Telegram auto-forwards the post.
export async function postChannelTicket(env: Env, row: BugRow): Promise<number> {
  const msg = await sendMessage(env, channelId(env), renderChannelTicket(row), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  await setBugTelegramLinkage(env, row.id, msg.message_id, null, null);
  return msg.message_id;
}

// Edit the channel ticket in place after any status/severity/category change.
export async function refreshChannelTicket(env: Env, row: BugRow): Promise<void> {
  if (!row.channel_message_id) return;
  try {
    await editMessageText(env, channelId(env), row.channel_message_id, renderChannelTicket(row), {
      parse_mode: "HTML",
    });
  } catch (e) {
    log.warn("channel_ticket_refresh_failed", { bugId: row.id, err: String(e) });
  }
}

// Post the detailed report body into the discussion thread of a given bug.
// If we don't yet know the thread id (mirror hasn't arrived), we wait briefly.
export async function postReportToThread(
  env: Env,
  row: BugRow,
  threadIdMaybe: number | null,
): Promise<TelegramMessage | null> {
  const threadId = threadIdMaybe ?? (await waitForThreadId(env, row.channel_message_id!));
  if (!threadId) {
    log.warn("thread_id_unresolved_for_report", { bugId: row.id });
    return null;
  }
  const msg = await sendMessage(env, discussionChatId(env), renderReportBody(row), {
    parse_mode: "HTML",
    message_thread_id: threadId,
    reply_markup: adminActionsKeyboard(row.id),
  });
  return msg;
}

// Post a status-update message into the bug's thread.
export async function postStatusUpdateToThread(
  env: Env,
  row: BugRow,
  fromStatus: string | null,
): Promise<void> {
  if (!row.discussion_thread_id) return;
  await sendMessage(env, discussionChatId(env), renderStatusUpdate(fromStatus, row.status), {
    parse_mode: "HTML",
    message_thread_id: row.discussion_thread_id,
  });
}

// Post an admin note into the bug's thread.
export async function postAdminNoteToThread(env: Env, row: BugRow, note: string, byUsername: string) {
  if (!row.discussion_thread_id) return;
  const { esc } = await import("../util/html");
  const body = `<b>NOTE</b> · ${esc(byUsername)}\n${esc(note)}`;
  await sendMessage(env, discussionChatId(env), body, {
    parse_mode: "HTML",
    message_thread_id: row.discussion_thread_id,
  });
}

// Send a Telegram-native attachment (file_id) into the bug's thread.
export async function postTelegramAttachmentToThread(
  env: Env,
  row: BugRow,
  kind: "photo" | "video" | "document" | "animation",
  fileId: string,
  caption?: string,
): Promise<number | null> {
  if (!row.discussion_thread_id) return null;
  const chat = discussionChatId(env);
  const opts = { message_thread_id: row.discussion_thread_id, caption, parse_mode: "HTML" as const };
  let msg: TelegramMessage;
  switch (kind) {
    case "photo":
      msg = await sendPhoto(env, chat, fileId, opts);
      break;
    case "video":
      msg = await sendVideo(env, chat, fileId, opts);
      break;
    case "animation":
      msg = await tgCall<TelegramMessage>(env, "sendAnimation", {
        chat_id: chat,
        animation: fileId,
        ...opts,
      });
      break;
    case "document":
    default:
      msg = await sendDocument(env, chat, fileId, opts);
      break;
  }
  return msg.message_id;
}

// Upload raw bytes (originally from R2 via Mini App) into the bug's thread.
export async function postR2AttachmentToThread(
  env: Env,
  row: BugRow,
  bytes: ArrayBuffer,
  mime: string,
  fileName: string,
): Promise<number | null> {
  if (!row.discussion_thread_id) return null;
  const chat = discussionChatId(env);
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("message_thread_id", String(row.discussion_thread_id));

  const blob = new Blob([bytes], { type: mime });
  let method = "sendDocument";
  let field = "document";
  if (mime.startsWith("image/") && mime !== "image/gif") {
    method = "sendPhoto";
    field = "photo";
  } else if (mime.startsWith("video/")) {
    method = "sendVideo";
    field = "video";
  } else if (mime === "image/gif") {
    method = "sendAnimation";
    field = "animation";
  }
  form.append(field, blob, fileName);
  const msg = await tgCallMultipart<TelegramMessage>(env, method, form);
  return msg.message_id;
}

// Attach an updated inline keyboard to the report message (or the ticket, if
// the report failed to post). Used when the admin keyboard needs refreshing.
export async function refreshAdminKeyboard(env: Env, row: BugRow) {
  if (!row.discussion_thread_id || !row.channel_message_id) return;
  try {
    // The report message is the first bot-authored message inside the thread.
    // Telegram does not give us its id from webhook mirror data, so we tolerate
    // failures here — the keyboard on the ORIGINAL /report message is still valid.
  } catch (e) {
    log.warn("refresh_admin_keyboard_failed", { err: String(e) });
  }
}

// Simple wait for the discussion mirror; used only for the first report post.
// We store thread ids in KV under key `mirror:<channel_message_id>` as they arrive.
export async function waitForThreadId(
  env: Env,
  channelMessageId: number,
  timeoutMs = 8000,
): Promise<number | null> {
  const key = `mirror:${channelMessageId}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cached = await env.SESSIONS.get(key);
    if (cached) {
      const n = Number(cached);
      if (Number.isFinite(n)) return n;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// Called from webhook.ts when Telegram delivers an auto-forwarded mirror message.
export async function recordDiscussionMirror(
  env: Env,
  channelMessageId: number,
  discussionMessageId: number,
  threadId: number,
) {
  await env.SESSIONS.put(`mirror:${channelMessageId}`, String(threadId), {
    expirationTtl: 60 * 60 * 24,
  });
  // Update DB best-effort; the bug row may have been created in this same request.
  await env.DB.prepare(
    `UPDATE bugs SET discussion_message_id = ?, discussion_thread_id = ?, updated_at = ?
     WHERE channel_message_id = ?`,
  )
    .bind(discussionMessageId, threadId, Math.floor(Date.now() / 1000), channelMessageId)
    .run();
}

// Explicit re-export so index.ts stays clean.
export { editMessageReplyMarkup, copyMessage };
