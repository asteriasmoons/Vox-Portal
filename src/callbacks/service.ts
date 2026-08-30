import type { Env } from "../config";
import { discussionChatId } from "../config";
import type { BugRow, BetaFeedbackRow, IdeaRow } from "../db/types";
import { betaFeedbackPublicId } from "../beta/formatting";
import { publicIdOf } from "../bugs/formatting";
import { ideaPublicId } from "../ideas/formatting";
import { sendMessage, type InputRichMessage, type TelegramMessage } from "../telegram/api";
import { buildBetaFeedbackRichMessage, buildBugReportRichMessage, buildIdeaReportRichMessage } from "../telegram/richmessage";
import { addDiscussionComment, type DiscussionTarget } from "../github/discussions";
import { postIssueComment } from "../github/service";
import { esc, trunc } from "../util/html";
import { log } from "../util/log";

export type CallbackDestination = "channel" | "dm";
export type ManualCallbackDestination = CallbackDestination | "github";
type CallbackSourceKind = "bug" | "idea" | "beta" | "unknown";

export interface CallbackRecord {
  id: number;
  callback_data: string;
  button_label: string;
  source_kind: CallbackSourceKind;
  source_id: number | null;
  source_public_id: string | null;
  source_title: string | null;
  app: string | null;
  source_chat_id: number | null;
  source_message_id: number | null;
  source_thread_id: number | null;
  followup_destination: CallbackDestination;
  followup_message: string;
  followup_message_html: string | null;
  followup_message_doc: string | null;
  followup_enabled: number;
  active: number;
  tap_count: number;
  last_tapped_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CallbackInteraction {
  id: number;
  callback_id: number;
  interaction_type: "tap" | "manual";
  callback_query_id: string | null;
  telegram_user_id: number | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  private_chat_id: number | null;
  source_chat_id: number | null;
  source_message_id: number | null;
  source_thread_id: number | null;
  response_destination: ManualCallbackDestination | null;
  response_message: string | null;
  response_message_html: string | null;
  response_message_doc: string | null;
  response_chat_id: number | null;
  response_message_id: number | null;
  delivery_status: string;
  delivery_error: string | null;
  sent_by_tg_id: number | null;
  created_at: number;
}

export interface CallbackSourceContext {
  source_kind: CallbackSourceKind;
  source_id: number | null;
  source_public_id: string | null;
  source_title: string | null;
  app?: string | null;
  source_chat_id: number | null;
  source_message_id: number | null;
  source_thread_id: number | null;
}

export interface CallbackTapContext {
  callback_query_id: string;
  callback_data: string;
  from: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  message?: TelegramMessage;
}

interface ExtractedButton {
  label: string;
  callback_data: string;
}

interface StatusHistoryRow {
  id: number;
  from_status: string | null;
  to_status: string;
  changed_by: number | null;
  created_at: number;
}

export async function registerPublishedRichMessageCallbacks(
  env: Env,
  richMessage: InputRichMessage,
  context: CallbackSourceContext,
): Promise<void> {
  const buttons = extractCallbackButtons(richMessage);
  if (!buttons.length) return;
  for (const button of buttons) {
    await upsertCallbackRecord(env, button, context);
  }
}

export async function backfillPublishedCallbacks(env: Env): Promise<void> {
  const bugs = await env.DB.prepare(
    `SELECT * FROM bugs WHERE report_message_id IS NOT NULL ORDER BY id DESC`,
  ).all<BugRow>();
  for (const row of bugs.results ?? []) {
    await registerPublishedRichMessageCallbacks(env, buildBugReportRichMessage(row), sourceForBug(env, row));
  }

  const ideas = await env.DB.prepare(
    `SELECT * FROM ideas WHERE report_message_id IS NOT NULL ORDER BY id DESC`,
  ).all<IdeaRow>();
  for (const row of ideas.results ?? []) {
    await registerPublishedRichMessageCallbacks(env, buildIdeaReportRichMessage(row), sourceForIdea(env, row));
  }

  const beta = await env.DB.prepare(
    `SELECT * FROM beta_feedback WHERE report_message_id IS NOT NULL ORDER BY id DESC`,
  ).all<BetaFeedbackRow>();
  for (const row of beta.results ?? []) {
    await registerPublishedRichMessageCallbacks(env, buildBetaFeedbackRichMessage(row), sourceForBeta(env, row));
  }
}

export async function listCallbackRecords(env: Env): Promise<CallbackRecord[]> {
  await backfillPublishedCallbacks(env);
  await backfillHistoricalCallbackInteractions(env);
  const res = await env.DB.prepare(
    `SELECT
       r.id,
       r.callback_data,
       r.button_label,
       r.source_kind,
       r.source_id,
       r.source_public_id,
       r.source_title,
       r.app,
       r.source_chat_id,
       r.source_message_id,
       r.source_thread_id,
       r.followup_destination,
       r.followup_message,
       r.followup_message_html,
       r.followup_message_doc,
       r.followup_enabled,
       r.active,
       (
         SELECT COUNT(*)
         FROM callback_interactions i
         WHERE i.callback_id = r.id
           AND i.interaction_type = 'tap'
       ) AS tap_count,
       (
         SELECT MAX(i.created_at)
         FROM callback_interactions i
         WHERE i.callback_id = r.id
           AND i.interaction_type = 'tap'
       ) AS last_tapped_at,
       r.created_at,
       r.updated_at
     FROM callback_records r
     WHERE EXISTS (
       SELECT 1 FROM callback_interactions i
       WHERE i.callback_id = r.id
         AND i.interaction_type = 'tap'
     )
     ORDER BY last_tapped_at DESC, r.id DESC`,
  ).all<CallbackRecord>();
  return res.results ?? [];
}

async function backfillHistoricalCallbackInteractions(env: Env): Promise<void> {
  await backfillBugStatusInteractions(env);
  await backfillIdeaStatusInteractions(env);
  await backfillBetaStatusInteractions(env);
}

async function backfillBugStatusInteractions(env: Env): Promise<void> {
  const histories = (await env.DB.prepare(
    `SELECT id, from_status, to_status, changed_by, created_at, bug_id
     FROM status_history
     ORDER BY id ASC`,
  ).all<StatusHistoryRow & { bug_id: number }>()).results ?? [];

  for (const history of histories) {
    const bug = await env.DB.prepare(`SELECT * FROM bugs WHERE id = ?`).bind(history.bug_id).first<BugRow>();
    if (!bug) continue;
    const record = await ensureHistoricalCallbackRecord(env, {
      callback_data: `rich:act:${history.bug_id}:status:${history.to_status}`,
      label: bugStatusButtonLabel(history.to_status),
    }, sourceForBug(env, bug));
    if (!record) continue;
    await insertHistoricalInteraction(env, record, `history:status_history:${history.id}`, history);
  }
}

async function backfillIdeaStatusInteractions(env: Env): Promise<void> {
  const histories = (await env.DB.prepare(
    `SELECT id, from_status, to_status, changed_by, created_at, idea_id
     FROM idea_status_history
     ORDER BY id ASC`,
  ).all<StatusHistoryRow & { idea_id: number }>()).results ?? [];

  for (const history of histories) {
    const idea = await env.DB.prepare(`SELECT * FROM ideas WHERE id = ?`).bind(history.idea_id).first<IdeaRow>();
    if (!idea) continue;
    const record = await ensureHistoricalCallbackRecord(env, {
      callback_data: `idea:act:${history.idea_id}:status:${history.to_status}`,
      label: ideaStatusButtonLabel(history.to_status),
    }, sourceForIdea(env, idea));
    if (!record) continue;
    await insertHistoricalInteraction(env, record, `history:idea_status_history:${history.id}`, history);
  }
}

async function backfillBetaStatusInteractions(env: Env): Promise<void> {
  const histories = (await env.DB.prepare(
    `SELECT id, from_status, to_status, changed_by, created_at, beta_feedback_id
     FROM beta_feedback_status_history
     ORDER BY id ASC`,
  ).all<StatusHistoryRow & { beta_feedback_id: number }>()).results ?? [];

  for (const history of histories) {
    const beta = await env.DB.prepare(`SELECT * FROM beta_feedback WHERE id = ?`).bind(history.beta_feedback_id).first<BetaFeedbackRow>();
    if (!beta) continue;
    const record = await ensureHistoricalCallbackRecord(env, {
      callback_data: `beta:menu:${history.beta_feedback_id}:status`,
      label: "Status",
    }, sourceForBeta(env, beta));
    if (!record) continue;
    await insertHistoricalInteraction(env, record, `history:beta_feedback_status_history:${history.id}`, history);
  }
}

async function ensureHistoricalCallbackRecord(
  env: Env,
  button: ExtractedButton,
  context: CallbackSourceContext,
): Promise<CallbackRecord | null> {
  await upsertCallbackRecord(env, button, context);
  return await findCallbackByData(env, button.callback_data);
}

export async function getCallbackRecord(env: Env, id: number): Promise<CallbackRecord | null> {
  return await env.DB.prepare(
    `SELECT
       r.id,
       r.callback_data,
       r.button_label,
       r.source_kind,
       r.source_id,
       r.source_public_id,
       r.source_title,
       r.app,
       r.source_chat_id,
       r.source_message_id,
       r.source_thread_id,
       r.followup_destination,
       r.followup_message,
       r.followup_message_html,
       r.followup_message_doc,
       r.followup_enabled,
       r.active,
       (
         SELECT COUNT(*)
         FROM callback_interactions i
         WHERE i.callback_id = r.id
           AND i.interaction_type = 'tap'
       ) AS tap_count,
       COALESCE(
         (
           SELECT MAX(i.created_at)
           FROM callback_interactions i
           WHERE i.callback_id = r.id
             AND i.interaction_type = 'tap'
         ),
         r.last_tapped_at
       ) AS last_tapped_at,
       r.created_at,
       r.updated_at
     FROM callback_records r
     WHERE r.id = ?`,
  ).bind(id).first<CallbackRecord>();
}

export async function getCallbackDetail(env: Env, id: number): Promise<{
  record: CallbackRecord | null;
  interactions: CallbackInteraction[];
  recipients: { telegram_user_id: number; label: string; private_chat_id: number | null }[];
}> {
  const record = await getCallbackRecord(env, id);
  if (!record) return { record: null, interactions: [], recipients: [] };
  const interactions = (await env.DB.prepare(
    `SELECT * FROM callback_interactions
     WHERE callback_id = ?
     ORDER BY created_at DESC, id DESC`,
  ).bind(id).all<CallbackInteraction>()).results ?? [];

  const seen = new Set<number>();
  const recipients: { telegram_user_id: number; label: string; private_chat_id: number | null }[] = [];
  for (const item of interactions) {
    if (!item.telegram_user_id || seen.has(item.telegram_user_id)) continue;
    seen.add(item.telegram_user_id);
    recipients.push({
      telegram_user_id: item.telegram_user_id,
      private_chat_id: item.private_chat_id,
      label: displayTelegramUser(item),
    });
  }
  return { record, interactions, recipients };
}

export async function updateCallbackConfig(
  env: Env,
  id: number,
  input: {
    followup_destination?: CallbackDestination;
    followup_message?: string;
    followup_message_html?: string | null;
    followup_message_doc?: string | null;
    followup_enabled?: boolean;
    active?: boolean;
  },
): Promise<CallbackRecord | null> {
  const record = await getCallbackRecord(env, id);
  if (!record) return null;
  const destination = input.followup_destination === "channel" || input.followup_destination === "dm"
    ? input.followup_destination
    : record.followup_destination;
  const message = typeof input.followup_message === "string"
    ? input.followup_message.slice(0, 3900)
    : record.followup_message;
  const messageHtml = typeof input.followup_message_html === "string"
    ? input.followup_message_html.slice(0, 3900)
    : input.followup_message_html === null
    ? null
    : record.followup_message_html;
  const messageDoc = typeof input.followup_message_doc === "string"
    ? input.followup_message_doc.slice(0, 12000)
    : input.followup_message_doc === null
    ? null
    : record.followup_message_doc;
  const enabled = typeof input.followup_enabled === "boolean" ? (input.followup_enabled ? 1 : 0) : record.followup_enabled;
  const active = typeof input.active === "boolean" ? (input.active ? 1 : 0) : record.active;
  await env.DB.prepare(
    `UPDATE callback_records
     SET followup_destination = ?,
         followup_message = ?,
         followup_message_html = ?,
         followup_message_doc = ?,
         followup_enabled = ?,
         active = ?,
         updated_at = ?
     WHERE id = ?`,
  ).bind(destination, message, messageHtml, messageDoc, enabled, active, unixNow(), id).run();
  return await getCallbackRecord(env, id);
}

export async function handlePublishedCallbackTap(env: Env, ctx: CallbackTapContext): Promise<{ proceed: boolean }> {
  if (!ctx.callback_data || ctx.callback_data === "noop") return { proceed: true };
  let record = await findCallbackByData(env, ctx.callback_data);
  if (!record) {
    await registerObservedCallback(env, ctx);
    record = await findCallbackByData(env, ctx.callback_data);
  }
  if (!record) return { proceed: true };

  await env.DB.prepare(
    `UPDATE callback_records SET tap_count = tap_count + 1, last_tapped_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(unixNow(), unixNow(), record.id).run();

  const delivery = record.active
    ? await sendConfiguredFollowup(env, record, ctx)
    : {
        status: "skipped_inactive",
        response_chat_id: null,
        response_message_id: null,
        error: null,
      };
  await insertInteraction(env, record.id, {
    interaction_type: "tap",
    callback_query_id: ctx.callback_query_id,
    telegram_user_id: ctx.from.id,
    telegram_username: ctx.from.username ?? null,
    telegram_first_name: ctx.from.first_name ?? null,
    telegram_last_name: ctx.from.last_name ?? null,
    private_chat_id: ctx.from.id,
    source_chat_id: ctx.message?.chat.id ?? record.source_chat_id,
    source_message_id: ctx.message?.message_id ?? record.source_message_id,
    source_thread_id: ctx.message?.message_thread_id ?? record.source_thread_id,
    response_destination: record.followup_destination,
    response_message: record.followup_message,
    response_message_html: record.followup_message_html,
    response_message_doc: record.followup_message_doc,
    response_chat_id: delivery.response_chat_id,
    response_message_id: delivery.response_message_id,
    delivery_status: delivery.status,
    delivery_error: delivery.error,
    sent_by_tg_id: null,
  });

  return { proceed: !!record.active };
}

export async function sendManualCallbackUpdate(
  env: Env,
  recordId: number,
  input: {
    message: string;
    message_html?: string | null;
    message_doc?: string | null;
    destination?: ManualCallbackDestination;
    recipient_user_id?: number | null;
    sent_by_tg_id: number;
  },
): Promise<{ ok: boolean; error?: string; record?: CallbackRecord }> {
  const record = await getCallbackRecord(env, recordId);
  if (!record) return { ok: false, error: "not_found" };
  const message = input.message.trim().slice(0, 3900);
  if (!message) return { ok: false, error: "message_required" };
  const messageHtml = typeof input.message_html === "string" ? input.message_html.trim().slice(0, 3900) : null;
  const messageDoc = typeof input.message_doc === "string" ? input.message_doc.slice(0, 12000) : null;
  const destination = input.destination === "channel" || input.destination === "dm" || input.destination === "github"
    ? input.destination
    : record.followup_destination;

  let recipient: CallbackInteraction | null = null;
  if (destination === "dm") {
    const userId = input.recipient_user_id ? Number(input.recipient_user_id) : null;
    recipient = userId
      ? await latestInteractionForUser(env, record.id, userId)
      : await latestInteractionWithUser(env, record.id);
    if (!recipient?.telegram_user_id) return { ok: false, error: "recipient_required" };
  }

  const delivery = destination === "github"
    ? await sendGitHubCallbackUpdate(env, record, message)
    : await sendRegularFollowup(env, record, {
        destination,
        message,
        message_html: messageHtml,
        telegram_user_id: recipient?.telegram_user_id ?? null,
        private_chat_id: recipient?.private_chat_id ?? recipient?.telegram_user_id ?? null,
        source_chat_id: record.source_chat_id,
        source_message_id: record.source_message_id,
        source_thread_id: record.source_thread_id,
      });

  await insertInteraction(env, record.id, {
    interaction_type: "manual",
    callback_query_id: null,
    telegram_user_id: recipient?.telegram_user_id ?? null,
    telegram_username: recipient?.telegram_username ?? null,
    telegram_first_name: recipient?.telegram_first_name ?? null,
    telegram_last_name: recipient?.telegram_last_name ?? null,
    private_chat_id: recipient?.private_chat_id ?? recipient?.telegram_user_id ?? null,
    source_chat_id: record.source_chat_id,
    source_message_id: record.source_message_id,
    source_thread_id: record.source_thread_id,
    response_destination: destination,
    response_message: message,
    response_message_html: destination === "github" ? null : messageHtml,
    response_message_doc: messageDoc,
    response_chat_id: delivery.response_chat_id,
    response_message_id: delivery.response_message_id,
    delivery_status: delivery.status,
    delivery_error: delivery.error,
    sent_by_tg_id: input.sent_by_tg_id,
  });

  if (delivery.status !== "sent") return { ok: false, error: delivery.error ?? delivery.status, record };
  return { ok: true, record };
}

export function sourceForBug(env: Env, row: BugRow): CallbackSourceContext {
  return {
    source_kind: "bug",
    source_id: row.id,
    source_public_id: publicIdOf(row),
    source_title: row.title,
    app: row.app,
    source_chat_id: discussionChatId(env),
    source_message_id: row.report_message_id,
    source_thread_id: row.discussion_thread_id,
  };
}

export function sourceForIdea(env: Env, row: IdeaRow): CallbackSourceContext {
  return {
    source_kind: "idea",
    source_id: row.id,
    source_public_id: ideaPublicId(row),
    source_title: row.title,
    app: row.app,
    source_chat_id: discussionChatId(env),
    source_message_id: row.report_message_id,
    source_thread_id: row.discussion_thread_id,
  };
}

export function sourceForBeta(env: Env, row: BetaFeedbackRow): CallbackSourceContext {
  return {
    source_kind: "beta",
    source_id: row.id,
    source_public_id: betaFeedbackPublicId(row),
    source_title: trunc(row.testing.replace(/\s+/g, " ").trim(), 160),
    app: row.app,
    source_chat_id: discussionChatId(env),
    source_message_id: row.report_message_id,
    source_thread_id: row.discussion_thread_id,
  };
}

function extractCallbackButtons(richMessage: InputRichMessage): ExtractedButton[] {
  const out: ExtractedButton[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    const data = obj.callback_data;
    if (typeof data === "string" && data) {
      out.push({ callback_data: data, label: textValue(obj.text) || data });
    }
    for (const child of Object.values(obj)) visit(child);
  };
  visit(richMessage.blocks ?? []);
  const seen = new Set<string>();
  return out.filter((button) => {
    if (seen.has(button.callback_data)) return false;
    seen.add(button.callback_data);
    return true;
  });
}

async function upsertCallbackRecord(
  env: Env,
  button: ExtractedButton,
  context: CallbackSourceContext,
): Promise<void> {
  const now = unixNow();
  await env.DB.prepare(
    `INSERT INTO callback_records (
       callback_data, button_label, source_kind, source_id, source_public_id,
       source_title, app, source_chat_id, source_message_id, source_thread_id,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(callback_data) DO UPDATE SET
       button_label = excluded.button_label,
       source_kind = excluded.source_kind,
       source_id = excluded.source_id,
       source_public_id = excluded.source_public_id,
       source_title = excluded.source_title,
       app = excluded.app,
       source_chat_id = excluded.source_chat_id,
       source_message_id = excluded.source_message_id,
       source_thread_id = excluded.source_thread_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      button.callback_data,
      button.label,
      context.source_kind,
      context.source_id,
      context.source_public_id,
      context.source_title,
      context.app ?? null,
      context.source_chat_id,
      context.source_message_id,
      context.source_thread_id,
      now,
      now,
    )
    .run();
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).join("").trim();
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

async function insertHistoricalInteraction(
  env: Env,
  record: CallbackRecord,
  historyKey: string,
  history: StatusHistoryRow,
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id FROM callback_interactions WHERE callback_query_id = ? LIMIT 1`,
  ).bind(historyKey).first<{ id: number }>();
  if (existing) return;

  await insertInteraction(env, record.id, {
    interaction_type: "tap",
    callback_query_id: historyKey,
    telegram_user_id: history.changed_by,
    telegram_username: null,
    telegram_first_name: null,
    telegram_last_name: null,
    private_chat_id: history.changed_by,
    source_chat_id: record.source_chat_id,
    source_message_id: record.source_message_id,
    source_thread_id: record.source_thread_id,
    response_destination: null,
    response_message: null,
    response_message_html: null,
    response_message_doc: null,
    response_chat_id: null,
    response_message_id: null,
    delivery_status: "backfilled",
    delivery_error: null,
    sent_by_tg_id: null,
    created_at: history.created_at,
  });

  await env.DB.prepare(
    `UPDATE callback_records
     SET tap_count = (
       SELECT COUNT(*)
       FROM callback_interactions
       WHERE callback_id = ?
         AND interaction_type = 'tap'
     ),
     last_tapped_at = (
       SELECT MAX(created_at)
       FROM callback_interactions
       WHERE callback_id = ?
         AND interaction_type = 'tap'
     ),
     updated_at = ?
     WHERE id = ?`,
  ).bind(record.id, record.id, unixNow(), record.id).run();
}

function bugStatusButtonLabel(status: string): string {
  const labels: Record<string, string> = {
    confirmed: "Confirmed",
    investigating: "Investigating",
    in_progress: "In Progress",
    fix_in_testing: "Fix In Testing",
    fixed: "Mark Fixed",
    closed: "Close",
    cannot_reproduce: "Cannot Reproduce",
  };
  return labels[status] ?? "Status";
}

function ideaStatusButtonLabel(status: string): string {
  const labels: Record<string, string> = {
    accepted: "Accept",
    rejected: "Reject",
    in_progress: "In Progress",
    in_testing: "In Testing",
    shipped: "Mark Shipped",
  };
  return labels[status] ?? "Status";
}

async function findCallbackByData(env: Env, callbackData: string): Promise<CallbackRecord | null> {
  return await env.DB.prepare(`SELECT * FROM callback_records WHERE callback_data = ?`)
    .bind(callbackData)
    .first<CallbackRecord>();
}

async function registerObservedCallback(env: Env, ctx: CallbackTapContext): Promise<void> {
  await registerPublishedRichMessageCallbacks(env, {
    blocks: [{ type: "buttons", buttons: [{ text: ctx.callback_data, callback_data: ctx.callback_data }] }],
  }, {
    source_kind: "unknown",
    source_id: null,
    source_public_id: null,
    source_title: null,
    app: null,
    source_chat_id: ctx.message?.chat.id ?? null,
    source_message_id: ctx.message?.message_id ?? null,
    source_thread_id: ctx.message?.message_thread_id ?? null,
  });
}

async function sendConfiguredFollowup(
  env: Env,
  record: CallbackRecord,
  ctx: CallbackTapContext,
): Promise<{ status: string; response_chat_id: number | null; response_message_id: number | null; error: string | null }> {
  if (!record.followup_enabled) {
    return { status: "skipped_disabled", response_chat_id: null, response_message_id: null, error: null };
  }
  if (!record.followup_message.trim()) {
    return { status: "skipped_empty", response_chat_id: null, response_message_id: null, error: null };
  }
  return await sendRegularFollowup(env, record, {
    destination: record.followup_destination,
    message: record.followup_message,
    message_html: record.followup_message_html,
    telegram_user_id: ctx.from.id,
    private_chat_id: ctx.from.id,
    source_chat_id: ctx.message?.chat.id ?? record.source_chat_id,
    source_message_id: ctx.message?.message_id ?? record.source_message_id,
    source_thread_id: ctx.message?.message_thread_id ?? record.source_thread_id,
  });
}

async function sendRegularFollowup(
  env: Env,
  record: CallbackRecord,
  input: {
    destination: CallbackDestination;
    message: string;
    message_html?: string | null;
    telegram_user_id: number | null;
    private_chat_id: number | null;
    source_chat_id: number | null;
    source_message_id: number | null;
    source_thread_id: number | null;
  },
): Promise<{ status: string; response_chat_id: number | null; response_message_id: number | null; error: string | null }> {
  try {
    const html = input.message_html?.trim() || esc(input.message);
    if (input.destination === "dm") {
      const chatId = input.private_chat_id ?? input.telegram_user_id;
      if (!chatId) return { status: "failed", response_chat_id: null, response_message_id: null, error: "missing_dm_chat" };
      const msg = await sendMessage(env, chatId, html, { parse_mode: "HTML" });
      return { status: "sent", response_chat_id: chatId, response_message_id: msg.message_id, error: null };
    }
    const chatId = input.source_chat_id ?? record.source_chat_id;
    if (!chatId) return { status: "failed", response_chat_id: null, response_message_id: null, error: "missing_channel_chat" };
    const opts = input.source_thread_id
      ? {
          parse_mode: "HTML" as const,
          message_thread_id: input.source_thread_id,
          reply_parameters: input.source_message_id ? { message_id: input.source_message_id } : undefined,
        }
      : { parse_mode: "HTML" as const };
    const msg = await sendMessage(env, chatId, html, opts);
    return { status: "sent", response_chat_id: chatId, response_message_id: msg.message_id, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn("callback_followup_send_failed", { callbackId: record.id, err: message });
    return { status: "failed", response_chat_id: null, response_message_id: null, error: message.slice(0, 300) };
  }
}

async function sendGitHubCallbackUpdate(
  env: Env,
  record: CallbackRecord,
  message: string,
): Promise<{ status: string; response_chat_id: number | null; response_message_id: number | null; error: string | null }> {
  const body = `### Callback Update\n\n${message}\n\n_Updated through Vox Portal._`;
  try {
    if (record.source_kind === "bug" && record.source_id) {
      const bug = await env.DB.prepare(`SELECT * FROM bugs WHERE id = ?`).bind(record.source_id).first<BugRow>();
      if (!bug) return failedDelivery("missing_bug");
      const result = await postIssueComment(env, bug, body);
      return result.ok ? sentDelivery() : failedDelivery("error" in result ? result.error : result.skipped);
    }

    if (record.source_kind === "idea" && record.source_id) {
      const idea = await env.DB.prepare(`SELECT * FROM ideas WHERE id = ?`).bind(record.source_id).first<IdeaRow>();
      if (!idea?.github_discussion_id || !idea.github_comment_id) return failedDelivery("missing_github_comment");
      const result = await addDiscussionComment(env, discussionTargetFromRow(idea), body, { replyToId: idea.github_comment_id });
      return result.ok ? sentDelivery() : failedDelivery(result.error ?? "github_failed");
    }

    if (record.source_kind === "beta" && record.source_id) {
      const beta = await env.DB.prepare(`SELECT * FROM beta_feedback WHERE id = ?`).bind(record.source_id).first<BetaFeedbackRow>();
      if (!beta?.github_discussion_id || !beta.github_comment_id) return failedDelivery("missing_github_comment");
      const result = await addDiscussionComment(env, discussionTargetFromRow(beta), body, { replyToId: beta.github_comment_id });
      return result.ok ? sentDelivery() : failedDelivery(result.error ?? "github_failed");
    }

    return failedDelivery("unsupported_source");
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.warn("callback_github_update_failed", { callbackId: record.id, err });
    return failedDelivery(err);
  }
}

function discussionTargetFromRow(row: IdeaRow | BetaFeedbackRow): DiscussionTarget {
  const [owner, repo] = (row.github_repo ?? "/").split("/");
  return {
    owner: owner || "unknown",
    repo: repo || "unknown",
    discussion_number: 0,
    discussion_node_id: row.github_discussion_id ?? "",
    discussion_url: row.github_discussion_url ?? "",
  };
}

function sentDelivery() {
  return { status: "sent", response_chat_id: null, response_message_id: null, error: null };
}

function failedDelivery(error: string) {
  return { status: "failed", response_chat_id: null, response_message_id: null, error: error.slice(0, 300) };
}

async function insertInteraction(
  env: Env,
  callbackId: number,
  input: Omit<CallbackInteraction, "id" | "callback_id" | "created_at"> & { created_at?: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO callback_interactions (
       callback_id, interaction_type, callback_query_id, telegram_user_id,
       telegram_username, telegram_first_name, telegram_last_name, private_chat_id,
       source_chat_id, source_message_id, source_thread_id, response_destination,
       response_message, response_message_html, response_message_doc,
       response_chat_id, response_message_id, delivery_status,
       delivery_error, sent_by_tg_id, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      callbackId,
      input.interaction_type,
      input.callback_query_id,
      input.telegram_user_id,
      input.telegram_username,
      input.telegram_first_name,
      input.telegram_last_name,
      input.private_chat_id,
      input.source_chat_id,
      input.source_message_id,
      input.source_thread_id,
      input.response_destination,
      input.response_message,
      input.response_message_html,
      input.response_message_doc,
      input.response_chat_id,
      input.response_message_id,
      input.delivery_status,
      input.delivery_error,
      input.sent_by_tg_id,
      input.created_at ?? unixNow(),
    )
    .run();
}

async function latestInteractionWithUser(env: Env, callbackId: number): Promise<CallbackInteraction | null> {
  return await env.DB.prepare(
    `SELECT * FROM callback_interactions
     WHERE callback_id = ? AND telegram_user_id IS NOT NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).bind(callbackId).first<CallbackInteraction>();
}

async function latestInteractionForUser(env: Env, callbackId: number, userId: number): Promise<CallbackInteraction | null> {
  return await env.DB.prepare(
    `SELECT * FROM callback_interactions
     WHERE callback_id = ? AND telegram_user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).bind(callbackId, userId).first<CallbackInteraction>();
}

function displayTelegramUser(item: CallbackInteraction): string {
  const name = [item.telegram_first_name, item.telegram_last_name].filter(Boolean).join(" ").trim();
  const username = item.telegram_username ? `@${item.telegram_username}` : "";
  return [username, name || item.telegram_user_id].filter(Boolean).join(" - ");
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
