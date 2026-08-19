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
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
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
}

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

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
  show_alert = false,
) {
  return await tgCall(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert });
}

export async function setMyCommands(env: Env, commands: { command: string; description: string }[]) {
  return await tgCall(env, "setMyCommands", { commands });
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
