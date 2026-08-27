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
  sendRichMessage,
  editRichMessage,
  type TelegramMessage,
} from "./api";
import { buildBugReportRichMessage, managementButtonBlocks } from "./richmessage";
import { setReportMessageId } from "../db/queries";
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

// Post the bug report as a Bot API 10.3 Rich Message into the discussion
// thread. Persists the returned message_id so future state changes can
// editMessageText(rich_message) it in place — the report block always shows
// live Status / Severity / Category and the correct disabled button set.
export async function postRichReportToThread(env: Env, row: BugRow): Promise<TelegramMessage | null> {
  if (!row.discussion_thread_id) return null;
  const richMessage = buildBugReportRichMessage(row);
  try {
    // Target the exact same comment thread the working attachment path
    // uses: chat_id = discussion group, message_thread_id = mirror id, AND
    // reply_parameters.message_id = mirror id. The last piece is what
    // makes sendRichMessage land as a comment on the channel post instead
    // of a standalone group message. `discussion_thread_id` is set to the
    // auto-forwarded mirror's id in bugs/service.ts createBug().
    const mirrorId = row.discussion_thread_id;
    const msg = await sendRichMessage(env, discussionChatId(env), richMessage, {
      message_thread_id: mirrorId,
      reply_parameters: { message_id: mirrorId, allow_sending_without_reply: true },
    });
    await setReportMessageId(env, row.id, msg.message_id);
    return msg;
  } catch (e) {
    log.error("rich_report_post_failed", e, { bugId: row.id });
    return null;
  }
}

// Live-update the Rich Message report after any state change.
export async function refreshRichReport(env: Env, row: BugRow): Promise<void> {
  if (!row.report_message_id) return;
  try {
    await editRichMessage(
      env,
      discussionChatId(env),
      row.report_message_id,
      buildBugReportRichMessage(row),
    );
  } catch (e) {
    // Telegram returns 400 "message is not modified" if nothing changed —
    // safe to ignore.
    log.warn("rich_report_refresh_failed", { bugId: row.id, err: String(e) });
  }
}

// Post the detailed report as a Bot API 10.3 Rich Message inside the bug's
// discussion thread. This is the single "live" management surface — its
// message_id is persisted so state changes can editMessageText(rich_message)
// it in place. Kept named postReportToThread so existing callers still work.
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
  // Make sure the row has the thread id set so postRichReportToThread can post.
  const withThread: BugRow = row.discussion_thread_id
    ? row
    : { ...row, discussion_thread_id: mirrorMessageId };
  return await postRichReportToThread(env, withThread);
}

// ── Legacy plain-HTML report (unused now, kept for reference/rollback) ──
async function _legacyPostHtmlReport(
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
    const persisted = await env.DB.prepare(
      `SELECT discussion_message_id FROM bugs
       WHERE channel_message_id = ? AND discussion_message_id IS NOT NULL
       LIMIT 1`,
    )
      .bind(channelMessageId)
      .first<{ discussion_message_id: number }>();
    if (persisted?.discussion_message_id) return persisted.discussion_message_id;
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
  log.info("discussion_mirror_recorded", { channelMessageId, discussionMessageId });
}

function commentThreadId(row: BugRow): number {
  return row.discussion_thread_id ?? row.discussion_message_id!;
}

// Explicit re-export so index.ts stays clean.
export { editMessageReplyMarkup, copyMessage };

// ──────────────────────────────────────────────────────────
// Feature Idea equivalents. Structurally identical to the bug helpers
// above so ideas take exactly the working code path — different data
// only. If this file's bug helpers change, mirror the change here.
// ──────────────────────────────────────────────────────────
import type { IdeaRow } from "../db/types";
import { setIdeaTelegramLinkage, setIdeaReportMessageId } from "../db/queries";
import { renderIdeaChannelTicket } from "../ideas/formatting";
import { buildIdeaReportRichMessage } from "./richmessage";

export async function postIdeaChannelTicket(env: Env, row: IdeaRow): Promise<number> {
  const msg = await sendMessage(env, channelId(env), renderIdeaChannelTicket(row), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  await setIdeaTelegramLinkage(env, row.id, msg.message_id, null, null);
  return msg.message_id;
}

export async function postIdeaRichReportToThread(env: Env, row: IdeaRow): Promise<TelegramMessage | null> {
  if (!row.discussion_thread_id) return null;
  const richMessage = buildIdeaReportRichMessage(row);
  try {
    const mirrorId = row.discussion_thread_id;
    const msg = await sendRichMessage(env, discussionChatId(env), richMessage, {
      message_thread_id: mirrorId,
      reply_parameters: { message_id: mirrorId, allow_sending_without_reply: true },
    });
    await setIdeaReportMessageId(env, row.id, msg.message_id);
    return msg;
  } catch (e) {
    log.error("idea_rich_report_post_failed", e, { ideaId: row.id });
    return null;
  }
}

export async function postIdeaReportToThread(
  env: Env,
  row: IdeaRow,
  mirrorMessageIdMaybe: number | null,
): Promise<TelegramMessage | null> {
  const mirrorMessageId = mirrorMessageIdMaybe ?? (await waitForIdeaDiscussionMirror(env, row.channel_message_id!));
  if (!mirrorMessageId) {
    log.warn("idea_discussion_mirror_unresolved_for_report", { ideaId: row.id });
    return null;
  }
  const withThread: IdeaRow = row.discussion_thread_id
    ? row
    : { ...row, discussion_thread_id: mirrorMessageId };
  return await postIdeaRichReportToThread(env, withThread);
}

export async function refreshIdeaRichReport(env: Env, row: IdeaRow): Promise<void> {
  if (!row.report_message_id) return;
  try {
    await editRichMessage(env, discussionChatId(env), row.report_message_id, buildIdeaReportRichMessage(row));
  } catch (e) {
    log.warn("idea_rich_report_refresh_failed", { ideaId: row.id, err: String(e) });
  }
}

export async function postIdeaTelegramAttachmentToThread(
  env: Env,
  row: IdeaRow,
  kind: "photo" | "video" | "document" | "animation",
  fileId: string,
  caption?: string,
): Promise<number | null> {
  if (!row.discussion_message_id) return null;
  const chat = discussionChatId(env);
  const threadId = row.discussion_thread_id ?? row.discussion_message_id;
  const opts = {
    message_thread_id: threadId,
    reply_parameters: { message_id: row.discussion_message_id },
    caption,
    parse_mode: "HTML" as const,
  };
  let msg: TelegramMessage;
  switch (kind) {
    case "photo":     msg = await sendPhoto(env, chat, fileId, opts); break;
    case "video":     msg = await sendVideo(env, chat, fileId, opts); break;
    case "animation": msg = await tgCall<TelegramMessage>(env, "sendAnimation", { chat_id: chat, animation: fileId, ...opts }); break;
    case "document":
    default:          msg = await sendDocument(env, chat, fileId, opts);
  }
  return msg.message_id;
}

export async function postIdeaR2AttachmentToThread(
  env: Env,
  row: IdeaRow,
  bytes: ArrayBuffer,
  mime: string,
  fileName: string,
): Promise<number | null> {
  if (!row.discussion_message_id) return null;
  const chat = discussionChatId(env);
  const threadId = row.discussion_thread_id ?? row.discussion_message_id;
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("message_thread_id", String(threadId));
  form.append("reply_parameters", JSON.stringify({ message_id: row.discussion_message_id }));
  const blob = new Blob([bytes], { type: mime });
  let method = "sendDocument"; let field = "document";
  if (mime.startsWith("image/") && mime !== "image/gif") { method = "sendPhoto"; field = "photo"; }
  else if (mime.startsWith("video/")) { method = "sendVideo"; field = "video"; }
  else if (mime === "image/gif")      { method = "sendAnimation"; field = "animation"; }
  form.append(field, blob, fileName);
  try {
    const msg = await tgCallMultipart<TelegramMessage>(env, method, form);
    return msg.message_id;
  } catch (e) {
    if (!(e instanceof TelegramError) || method === "sendDocument" || e.error_code !== 400) throw e;
    log.warn("idea_attachment_media_fallback_to_document", { ideaId: row.id, fileName, mime, method, reason: e.description });
    const fallback = new FormData();
    fallback.append("chat_id", String(chat));
    fallback.append("message_thread_id", String(threadId));
    fallback.append("reply_parameters", JSON.stringify({ message_id: row.discussion_message_id }));
    fallback.append("document", blob, fileName);
    const msg = await tgCallMultipart<TelegramMessage>(env, "sendDocument", fallback);
    return msg.message_id;
  }
}

// Idea-specific mirror lookup. It uses the same webhook-populated KV mapping as bugs,
// but its SQL fallback reads the ideas table rather than accidentally querying bugs.
export async function waitForIdeaDiscussionMirror(
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
    const persisted = await env.DB.prepare(
      `SELECT discussion_message_id FROM ideas
       WHERE channel_message_id = ? AND discussion_message_id IS NOT NULL
       LIMIT 1`,
    )
      .bind(channelMessageId)
      .first<{ discussion_message_id: number }>();
    if (persisted?.discussion_message_id) return persisted.discussion_message_id;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// Persist Telegram's auto-forwarded channel mirror onto the matching idea row.
// This is deliberately separate from recordDiscussionMirror(), which remains the
// existing bug implementation unchanged. The webhook calls both; only the table
// containing the matching channel_message_id is affected.
export async function recordIdeaDiscussionMirror(
  env: Env,
  channelMessageId: number,
  discussionMessageId: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ideas SET discussion_message_id = ?, discussion_thread_id = ?, updated_at = ?
     WHERE channel_message_id = ?`,
  )
    .bind(discussionMessageId, discussionMessageId, Math.floor(Date.now() / 1000), channelMessageId)
    .run();
}

// ──────────────────────────────────────────────────────────
// Beta Feedback equivalents. Mirrors the Feature Idea helpers: separate D1
// table lookups, same channel/discussion posting mechanics.
// ──────────────────────────────────────────────────────────
import type { BetaFeedbackRow } from "../db/types";
import {
  setBetaFeedbackReportMessageId,
  setBetaFeedbackTelegramLinkage,
} from "../db/queries";
import { renderBetaFeedbackChannelTicket } from "../beta/formatting";
import { buildBetaFeedbackRichMessage } from "./richmessage";

export async function postBetaFeedbackChannelTicket(env: Env, row: BetaFeedbackRow): Promise<number> {
  const msg = await sendMessage(env, channelId(env), renderBetaFeedbackChannelTicket(row), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  await setBetaFeedbackTelegramLinkage(env, row.id, msg.message_id, null, null);
  return msg.message_id;
}

export async function refreshBetaFeedbackChannelTicket(env: Env, row: BetaFeedbackRow): Promise<void> {
  if (!row.channel_message_id) return;
  try {
    await editMessageText(env, channelId(env), row.channel_message_id, renderBetaFeedbackChannelTicket(row), {
      parse_mode: "HTML",
    });
  } catch (e) {
    log.warn("beta_feedback_channel_ticket_refresh_failed", { betaFeedbackId: row.id, err: String(e) });
  }
}

export async function postBetaFeedbackRichReportToThread(
  env: Env,
  row: BetaFeedbackRow,
): Promise<TelegramMessage | null> {
  if (!row.discussion_thread_id) return null;
  const richMessage = buildBetaFeedbackRichMessage(row);
  try {
    const mirrorId = row.discussion_thread_id;
    const msg = await sendRichMessage(env, discussionChatId(env), richMessage, {
      message_thread_id: mirrorId,
      reply_parameters: { message_id: mirrorId, allow_sending_without_reply: true },
    });
    await setBetaFeedbackReportMessageId(env, row.id, msg.message_id);
    return msg;
  } catch (e) {
    log.error("beta_feedback_rich_report_post_failed", e, { betaFeedbackId: row.id });
    return null;
  }
}

export async function postBetaFeedbackReportToThread(
  env: Env,
  row: BetaFeedbackRow,
  mirrorMessageIdMaybe: number | null,
): Promise<TelegramMessage | null> {
  const mirrorMessageId = mirrorMessageIdMaybe ?? (await waitForBetaFeedbackDiscussionMirror(env, row.channel_message_id!));
  if (!mirrorMessageId) {
    log.warn("beta_feedback_discussion_mirror_unresolved_for_report", { betaFeedbackId: row.id });
    return null;
  }
  const withThread: BetaFeedbackRow = row.discussion_thread_id
    ? row
    : { ...row, discussion_thread_id: mirrorMessageId };
  return await postBetaFeedbackRichReportToThread(env, withThread);
}

export async function refreshBetaFeedbackRichReport(env: Env, row: BetaFeedbackRow): Promise<void> {
  if (!row.report_message_id) return;
  try {
    await editRichMessage(env, discussionChatId(env), row.report_message_id, buildBetaFeedbackRichMessage(row));
  } catch (e) {
    log.warn("beta_feedback_rich_report_refresh_failed", { betaFeedbackId: row.id, err: String(e) });
  }
}

export async function postBetaFeedbackTelegramAttachmentToThread(
  env: Env,
  row: BetaFeedbackRow,
  kind: "photo" | "video" | "document" | "animation",
  fileId: string,
  caption?: string,
): Promise<number | null> {
  if (!row.discussion_message_id) return null;
  const chat = discussionChatId(env);
  const threadId = row.discussion_thread_id ?? row.discussion_message_id;
  const opts = {
    message_thread_id: threadId,
    reply_parameters: { message_id: row.discussion_message_id },
    caption,
    parse_mode: "HTML" as const,
  };
  let msg: TelegramMessage;
  switch (kind) {
    case "photo":     msg = await sendPhoto(env, chat, fileId, opts); break;
    case "video":     msg = await sendVideo(env, chat, fileId, opts); break;
    case "animation": msg = await tgCall<TelegramMessage>(env, "sendAnimation", { chat_id: chat, animation: fileId, ...opts }); break;
    case "document":
    default:          msg = await sendDocument(env, chat, fileId, opts);
  }
  return msg.message_id;
}

export async function postBetaFeedbackR2AttachmentToThread(
  env: Env,
  row: BetaFeedbackRow,
  bytes: ArrayBuffer,
  mime: string,
  fileName: string,
): Promise<number | null> {
  if (!row.discussion_message_id) return null;
  const chat = discussionChatId(env);
  const threadId = row.discussion_thread_id ?? row.discussion_message_id;
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("message_thread_id", String(threadId));
  form.append("reply_parameters", JSON.stringify({ message_id: row.discussion_message_id }));
  const blob = new Blob([bytes], { type: mime });
  let method = "sendDocument"; let field = "document";
  if (mime.startsWith("image/") && mime !== "image/gif") { method = "sendPhoto"; field = "photo"; }
  else if (mime.startsWith("video/")) { method = "sendVideo"; field = "video"; }
  else if (mime === "image/gif")      { method = "sendAnimation"; field = "animation"; }
  form.append(field, blob, fileName);
  try {
    const msg = await tgCallMultipart<TelegramMessage>(env, method, form);
    return msg.message_id;
  } catch (e) {
    if (!(e instanceof TelegramError) || method === "sendDocument" || e.error_code !== 400) throw e;
    log.warn("beta_feedback_attachment_media_fallback_to_document", {
      betaFeedbackId: row.id,
      fileName,
      mime,
      method,
      reason: e.description,
    });
    const fallback = new FormData();
    fallback.append("chat_id", String(chat));
    fallback.append("message_thread_id", String(threadId));
    fallback.append("reply_parameters", JSON.stringify({ message_id: row.discussion_message_id }));
    fallback.append("document", blob, fileName);
    const msg = await tgCallMultipart<TelegramMessage>(env, "sendDocument", fallback);
    return msg.message_id;
  }
}

export async function waitForBetaFeedbackDiscussionMirror(
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
    const persisted = await env.DB.prepare(
      `SELECT discussion_message_id FROM beta_feedback
       WHERE channel_message_id = ? AND discussion_message_id IS NOT NULL
       LIMIT 1`,
    )
      .bind(channelMessageId)
      .first<{ discussion_message_id: number }>();
    if (persisted?.discussion_message_id) return persisted.discussion_message_id;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export async function recordBetaFeedbackDiscussionMirror(
  env: Env,
  channelMessageId: number,
  discussionMessageId: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE beta_feedback SET discussion_message_id = ?, discussion_thread_id = ?, updated_at = ?
     WHERE channel_message_id = ?`,
  )
    .bind(discussionMessageId, discussionMessageId, Math.floor(Date.now() / 1000), channelMessageId)
    .run();
}
