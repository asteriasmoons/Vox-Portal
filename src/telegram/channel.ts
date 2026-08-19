// Posts and edits the channel ticket + discussion thread messages.
//
// Telegram behavior we rely on:
//   • A channel post is automatically forwarded into its linked discussion group.
//   • That auto-forwarded group message is the root of the channel post's comment section.
//   • The Bot API exposes it as `is_automatic_forward` with a channel `forward_origin`.
//   • To create a channel comment, send into the linked discussion group with
//     `message_thread_id` and `reply_parameters.message_id` targeting that
//     auto-forwarded root message.
//
// webhook.ts records the channel-post message id → discussion-root message id mapping.
// We reuse that root for the detailed report, attachments, notes, and status comments.

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
  TelegramError,
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
  mirrorMessageIdMaybe: number | null,
): Promise<TelegramMessage | null> {
  const mirrorMessageId = mirrorMessageIdMaybe ?? (await waitForDiscussionMirror(env, row.channel_message_id!));
  if (!mirrorMessageId) {
    log.warn("discussion_mirror_unresolved_for_report", { bugId: row.id });
    return null;
  }
  return await sendMessage(env, discussionChatId(env), renderReportBody(row), {
    parse_mode: "HTML",
    message_thread_id: mirrorMessageId,
    reply_parameters: { message_id: mirrorMessageId },
    reply_markup: adminActionsKeyboard(row.id),
  });
}

// Post a status-update message into the bug's thread.
export async function postStatusUpdateToThread(
  env: Env,
  row: BugRow,
  fromStatus: string | null,
): Promise<void> {
  if (!row.discussion_message_id) return;
  const threadId = commentThreadId(row);
  await sendMessage(env, discussionChatId(env), renderStatusUpdate(fromStatus, row.status), {
    parse_mode: "HTML",
    message_thread_id: threadId,
    reply_parameters: { message_id: row.discussion_message_id },
  });
}

// Post an admin note into the bug's linked discussion comments.
export async function postAdminNoteToThread(env: Env, row: BugRow, note: string, byUsername: string) {
  if (!row.discussion_message_id) return;
  const threadId = commentThreadId(row);
  const { esc } = await import("../util/html");
  const body = `<b>NOTE</b> · ${esc(byUsername)}\n${esc(note)}`;
  await sendMessage(env, discussionChatId(env), body, {
    parse_mode: "HTML",
    message_thread_id: threadId,
    reply_parameters: { message_id: row.discussion_message_id },
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
  if (!row.discussion_message_id) return null;
  const chat = discussionChatId(env);
  const threadId = commentThreadId(row);
  const opts = {
    message_thread_id: threadId,
    reply_parameters: { message_id: row.discussion_message_id },
    caption,
    parse_mode: "HTML" as const,
  };
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
  if (!row.discussion_message_id) return null;
  const chat = discussionChatId(env);
  const threadId = commentThreadId(row);
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("message_thread_id", String(threadId));
  form.append("reply_parameters", JSON.stringify({ message_id: row.discussion_message_id }));

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
  try {
    const msg = await tgCallMultipart<TelegramMessage>(env, method, form);
    return msg.message_id;
  } catch (e) {
    // Telegram's photo/video processors reject some otherwise-valid files
    // (for example 16-bit PNG screenshots). Preserve the original attachment
    // by falling back to sendDocument instead of failing the whole bug report.
    if (!(e instanceof TelegramError) || method === "sendDocument" || e.error_code !== 400) throw e;
    log.warn("attachment_media_fallback_to_document", { bugId: row.id, fileName, mime, method, reason: e.description });
    const fallback = new FormData();
    fallback.append("chat_id", String(chat));
    fallback.append("message_thread_id", String(threadId));
    fallback.append("reply_parameters", JSON.stringify({ message_id: row.discussion_message_id }));
    fallback.append("document", blob, fileName);
    const msg = await tgCallMultipart<TelegramMessage>(env, "sendDocument", fallback);
    return msg.message_id;
  }
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
// We store the auto-forwarded discussion message id in KV under `mirror:<channel_message_id>`.
export async function waitForDiscussionMirror(
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

// Called when Telegram delivers the auto-forwarded copy in the linked discussion group.
// The auto-forwarded message itself is the root of the channel post's comment thread.
export async function recordDiscussionMirror(
  env: Env,
  channelMessageId: number,
  discussionMessageId: number,
) {
  await env.SESSIONS.put(`mirror:${channelMessageId}`, String(discussionMessageId), {
    expirationTtl: 60 * 60 * 24,
  });
  await env.DB.prepare(
    `UPDATE bugs SET discussion_message_id = ?, discussion_thread_id = ?, updated_at = ?
     WHERE channel_message_id = ?`,
  )
    .bind(discussionMessageId, discussionMessageId, Math.floor(Date.now() / 1000), channelMessageId)
    .run();
}

function commentThreadId(row: BugRow): number {
  return row.discussion_thread_id ?? row.discussion_message_id!;
}

// Explicit re-export so index.ts stays clean.
export { editMessageReplyMarkup, copyMessage };
