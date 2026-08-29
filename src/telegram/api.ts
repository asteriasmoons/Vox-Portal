// Thin Telegram Bot API client. Uses fetch; no external deps.
import type { Env } from "../config";
import { log } from "../util/log";

const API_ROOT = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(
    public method: string,
    public description: string,
    public error_code?: number,
    public parameters?: unknown,
  ) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

export interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: unknown;
}

export async function tgCall<T = unknown>(
  env: Env,
  method: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const url = `${API_ROOT}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as TelegramResponse<T>;
  if (!data.ok) {
    log.warn("telegram_api_error", {
      method,
      code: data.error_code,
      description: data.description,
      parameters: data.parameters,
    });
    throw new TelegramError(method, data.description ?? "unknown", data.error_code, data.parameters);
  }
  return data.result as T;
}

// Multipart form call — used for uploading a file (photo/video/document) directly.
export async function tgCallMultipart<T = unknown>(
  env: Env,
  method: string,
  form: FormData,
): Promise<T> {
  const url = `${API_ROOT}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, { method: "POST", body: form });
  const data = (await res.json()) as TelegramResponse<T>;
  if (!data.ok) {
    log.warn("telegram_api_error", {
      method,
      code: data.error_code,
      description: data.description,
      parameters: data.parameters,
    });
    throw new TelegramError(method, data.description ?? "unknown", data.error_code, data.parameters);
  }
  return data.result as T;
}

// Download a file that was uploaded to Telegram (given its file_id).
// Returns the raw bytes and inferred mime type.
export async function tgDownloadFile(
  env: Env,
  fileId: string,
): Promise<{ bytes: ArrayBuffer; file_path: string; mime?: string }> {
  const info = await tgCall<{ file_path: string }>(env, "getFile", { file_id: fileId });
  const url = `${API_ROOT}/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getFile download failed: ${res.status}`);
  const bytes = await res.arrayBuffer();
  return { bytes, file_path: info.file_path, mime: res.headers.get("content-type") ?? undefined };
}

// ── Convenience helpers ────────────────────────────────────
export interface SendMessageOptions {
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: unknown;
  message_thread_id?: number;
  disable_web_page_preview?: boolean;
  reply_parameters?: { message_id: number; chat_id?: number | string };
  link_preview_options?: {
    is_disabled?: boolean;
    url?: string;
    prefer_small_media?: boolean;
    prefer_large_media?: boolean;
    show_above_text?: boolean;
  };
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  sender_chat?: { id: number; type: string; title?: string; username?: string };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_automatic_forward?: true;
  forward_origin?:
    | { type: "channel"; date: number; chat: { id: number; type: string }; message_id: number; author_signature?: string }
    | { type: string; [key: string]: unknown };
  reply_to_message?: TelegramMessage;
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
  video?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number; width?: number; height?: number };
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  animation?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number; width?: number; height?: number };
  entities?: { type: string; offset: number; length: number }[];
  // Bot API 10.2+ — set when this Message represents an ephemeral message.
  // The regular `message_id` on ephemerals is often 0/absent; use this id
  // with editEphemeralMessage* and deleteEphemeralMessage.
  ephemeral_message_id?: number;
}

export interface TelegramChatJoinRequest {
  chat: { id: number; type: string; title?: string; username?: string };
  from: { id: number; is_bot?: boolean; first_name: string; last_name?: string; username?: string };
  user_chat_id: number;
  date: number;
  bio?: string;
  invite_link?: {
    invite_link: string;
    name?: string;
    creates_join_request?: boolean;
    is_primary?: boolean;
    is_revoked?: boolean;
    pending_join_request_count?: number;
  };
  query_id?: string;
}

// ── Bot API 10.3 Rich Messages + Ephemeral Messages ───────
// Sources verified against https://core.telegram.org/bots/api-changelog
// (Bot API 10.1 Rich Messages foundation, 10.2 Ephemeral Messages,
// 10.3 RichBlockButtons + DisabledButton + button styles + ephemeral
// replace_callback_query_message).

export interface EphemeralMessageParameters {
  receiver_user_id: number;
  callback_query_id?: string;
  replace_callback_query_message?: boolean;
}

// Any structured InputRichMessage body accepted by sendRichMessage /
// editMessageText. We do not exhaustively type every block variant here;
// each block is `{ type: "...", ... }` per the Bot API 10.1/10.2/10.3 spec.
export interface InputRichMessage {
  blocks?: unknown[];
  html?: string;
  markdown?: string;
  media?: unknown[];
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

export async function sendRichMessage(
  env: Env,
  chatId: number | string,
  richMessage: InputRichMessage,
  opts: {
    message_thread_id?: number;
    reply_markup?: unknown;
    ephemeral_message_parameters?: EphemeralMessageParameters;
    disable_notification?: boolean;
    // Bot API `ReplyParameters` — required for Rich Messages to land inside
    // a linked-discussion comment thread. Setting reply_parameters.message_id
    // to the auto-forwarded mirror's id makes the Rich Message a REPLY TO
    // the mirror, i.e. a comment on the original channel post. Without this
    // sendRichMessage posts as a standalone group message even when
    // message_thread_id is set.
    reply_parameters?: { message_id: number; chat_id?: number | string; allow_sending_without_reply?: boolean };
  } = {},
): Promise<TelegramMessage> {
  // Debug log — dumps only the button-carrying blocks so we can compare the
  // exact wire JSON against the RichMessageButton schema. Truncated to stay
  // out of the way of noise. Remove once callback wiring is verified.
  try {
    const blocks = (richMessage.blocks ?? []) as { type?: string; buttons?: unknown[] }[];
    const buttonBlocks = blocks.filter((b) => b?.type === "buttons");
    if (buttonBlocks.length) {
      console.log("sendRichMessage.buttons_out", JSON.stringify(buttonBlocks));
    }
  } catch { /* noop */ }

  console.log("sendRichMessage.out", JSON.stringify({
    chat_id: chatId,
    message_thread_id: opts.message_thread_id ?? null,
    reply_parameters: opts.reply_parameters ?? null,
    has_ephemeral: !!opts.ephemeral_message_parameters,
  }));

  return await tgCall<TelegramMessage>(env, "sendRichMessage", {
    chat_id: chatId,
    rich_message: richMessage,
    message_thread_id: opts.message_thread_id,
    reply_markup: opts.reply_markup,
    reply_parameters: opts.reply_parameters,
    ephemeral_message_parameters: opts.ephemeral_message_parameters,
    disable_notification: opts.disable_notification,
  });
}

// Bot API 10.1+ — editMessageText accepts a `rich_message` parameter.
export async function editRichMessage(
  env: Env,
  chatId: number | string,
  messageId: number,
  richMessage: InputRichMessage,
  opts: { reply_markup?: unknown } = {},
): Promise<TelegramMessage | true> {
  return await tgCall<TelegramMessage | true>(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    rich_message: richMessage,
    reply_markup: opts.reply_markup,
  });
}

// Ephemeral message helpers. Ephemeral messages are visible ONLY to a
// specific receiver_user_id inside a group; with `replace_callback_query_message:
// true` they appear IN PLACE OF the message that carried the tapped button —
// perfect for temporary Status/Severity/Category selectors.
export async function sendEphemeralRichMessage(
  env: Env,
  chatId: number | string,
  ephemeral: EphemeralMessageParameters,
  richMessage: InputRichMessage,
  opts: { message_thread_id?: number; reply_markup?: unknown } = {},
): Promise<TelegramMessage> {
  return await sendRichMessage(env, chatId, richMessage, { ...opts, ephemeral_message_parameters: ephemeral });
}

// editEphemeralMessageText — Bot API 10.2/10.3.
// All three of chat_id / receiver_user_id / ephemeral_message_id are REQUIRED
// per the spec; omitting receiver_user_id gets "Bad Request: invalid
// receiver_user_id specified".
export async function editEphemeralRichMessage(
  env: Env,
  chatId: number | string,
  receiverUserId: number,
  ephemeralMessageId: number,
  richMessage: InputRichMessage,
  opts: { reply_markup?: unknown } = {},
): Promise<true | TelegramMessage> {
  return await tgCall<true | TelegramMessage>(env, "editEphemeralMessageText", {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
    rich_message: richMessage,
    reply_markup: opts.reply_markup,
  });
}

// deleteEphemeralMessage — three required params per spec.
export async function deleteEphemeralMessage(
  env: Env,
  chatId: number | string,
  receiverUserId: number,
  ephemeralMessageId: number,
): Promise<true> {
  return await tgCall<true>(env, "deleteEphemeralMessage", {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
  });
}

// Original plain-message helper.
export async function sendMessage(
  env: Env,
  chatId: number | string,
  text: string,
  opts: SendMessageOptions = {},
): Promise<TelegramMessage> {
  return await tgCall<TelegramMessage>(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode ?? "HTML",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    link_preview_options: opts.link_preview_options,
    reply_markup: opts.reply_markup,
    message_thread_id: opts.message_thread_id,
    reply_parameters: opts.reply_parameters,
  });
}

export async function editMessageText(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  opts: Omit<SendMessageOptions, "reply_parameters" | "message_thread_id"> = {},
): Promise<TelegramMessage | true> {
  return await tgCall<TelegramMessage | true>(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parse_mode ?? "HTML",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    reply_markup: opts.reply_markup,
  });
}

export async function editMessageReplyMarkup(
  env: Env,
  chatId: number | string,
  messageId: number,
  reply_markup: unknown,
) {
  return await tgCall(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup });
}

export async function deleteMessage(
  env: Env,
  chatId: number | string,
  messageId: number,
): Promise<true> {
  return await tgCall<true>(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
  show_alert = false,
) {
  return await tgCall(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert });
}

export async function approveChatJoinRequest(
  env: Env,
  chatId: number | string,
  userId: number,
): Promise<true> {
  return await tgCall<true>(env, "approveChatJoinRequest", {
    chat_id: chatId,
    user_id: userId,
  });
}

export async function declineChatJoinRequest(
  env: Env,
  chatId: number | string,
  userId: number,
): Promise<true> {
  return await tgCall<true>(env, "declineChatJoinRequest", {
    chat_id: chatId,
    user_id: userId,
  });
}

export async function setMyCommands(
  env: Env,
  commands: { command: string; description: string }[],
  scope?: { type: string; chat_id?: number | string; user_id?: number },
) {
  return await tgCall(env, "setMyCommands", { commands, scope });
}

export async function copyMessage(
  env: Env,
  chatId: number | string,
  fromChatId: number | string,
  messageId: number,
  opts: { message_thread_id?: number; caption?: string; parse_mode?: string } = {},
): Promise<{ message_id: number }> {
  return await tgCall(env, "copyMessage", {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    message_thread_id: opts.message_thread_id,
    caption: opts.caption,
    parse_mode: opts.parse_mode,
  });
}

export async function sendPhoto(
  env: Env,
  chatId: number | string,
  photo: string,
  opts: { caption?: string; message_thread_id?: number; reply_parameters?: { message_id: number; chat_id?: number | string }; parse_mode?: string } = {},
) {
  return await tgCall<TelegramMessage>(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    caption: opts.caption,
    parse_mode: opts.parse_mode ?? "HTML",
    message_thread_id: opts.message_thread_id,
    reply_parameters: opts.reply_parameters,
  });
}

export async function sendDocument(
  env: Env,
  chatId: number | string,
  document: string,
  opts: { caption?: string; message_thread_id?: number; reply_parameters?: { message_id: number; chat_id?: number | string }; parse_mode?: string } = {},
) {
  return await tgCall<TelegramMessage>(env, "sendDocument", {
    chat_id: chatId,
    document,
    caption: opts.caption,
    parse_mode: opts.parse_mode ?? "HTML",
    message_thread_id: opts.message_thread_id,
    reply_parameters: opts.reply_parameters,
  });
}

export async function sendVideo(
  env: Env,
  chatId: number | string,
  video: string,
  opts: { caption?: string; message_thread_id?: number; reply_parameters?: { message_id: number; chat_id?: number | string }; parse_mode?: string } = {},
) {
  return await tgCall<TelegramMessage>(env, "sendVideo", {
    chat_id: chatId,
    video,
    caption: opts.caption,
    parse_mode: opts.parse_mode ?? "HTML",
    message_thread_id: opts.message_thread_id,
    reply_parameters: opts.reply_parameters,
  });
}
