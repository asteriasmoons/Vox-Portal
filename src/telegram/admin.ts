// Admin management flow for the Bot API 10.3 Rich Message report.
//
// Callback grammar (kept in one place so the router below is exhaustive):
//   rich:menu:<bugId>:status | severity | category | note
//   rich:act:<bugId>:status:<statusId>
//   rich:act:<bugId>:severity:<severityId>
//   rich:act:<bugId>:category:<categoryId>
//   rich:back:<bugId>                     (dismiss ephemeral picker)
//   beta:menu:<betaFeedbackId>:status
//   beta:act:<betaFeedbackId>:status:<statusId>
//   beta:back:<betaFeedbackId>            (dismiss ephemeral picker)
//   noop                                  (fired by disabled current-selection buttons)
//
// Every management action:
//   1. Verifies the caller is an admin.
//   2. Opens or dismisses an ephemeral Rich Message (replaces the report
//      in-place while the picker is up, then is deleted).
//   3. Mutates DB state.
//   4. Refreshes the LIVE Rich Message report so Status/Severity/Category
//      always show current values and the correct disabled button set.
//   5. Refreshes the concise channel ticket (existing behavior).
//   6. Appends a permanent STATUS UPDATE / SEVERITY UPDATE / etc. message
//      to the discussion thread (the history log — existing behavior).
//   7. Syncs the equivalent action to the linked GitHub Issue (idempotent).
//   8. DMs the reporter on button-driven changes.
//
// GitHub failure is isolated: we log it, we do not roll back Telegram.

import type { Env } from "../config";
import { isAdmin, discussionChatId } from "../config";
import {
  answerCallbackQuery,
  sendEphemeralRichMessage,
  deleteEphemeralMessage,
  sendMessage,
  type EphemeralMessageParameters,
} from "./api";
import {
  buildStatusPickerRichMessage,
  buildSeverityPickerRichMessage,
  buildCategoryPickerRichMessage,
  buildNotePromptRichMessage,
  buildBetaFeedbackStatusPickerRichMessage,
} from "./richmessage";
import { refreshRichReport } from "./channel";
import {
  getBug, updateBugCategory, updateBugSeverity, markDuplicate,
} from "../db/queries";
import { changeStatus } from "../bugs/service";
import { refreshChannelTicket, postStatusUpdateToThread, postManagementUpdateToThread, postAdminNoteToThread } from "./channel";
import type { StatusId } from "../bugs/constants";
import { STATUS_IDS, SEVERITY_IDS, CATEGORY_IDS, statusMeta, severityMeta, categoryMeta } from "../bugs/constants";
import {
  syncStatusChange, syncSeverityChange, syncCategoryChange, syncAdminNote,
} from "../github/service";
import { log } from "../util/log";
import { esc } from "../util/html";
import type { BugRow } from "../db/types";

interface CallbackCtx {
  env: Env;
  callbackQueryId: string;
  chatId: number;
  messageId: number;
  fromTgId: number;
  data: string;
}

// Track the currently-open ephemeral picker per (chatId, fromTgId) so
// selection or Back can clean it up. We stash the id in KV under a short-
// TTL key. The router uses this to delete the picker when a choice is made.
const EPH_KEY = (bugId: number, tgId: number) => `eph:${bugId}:${tgId}`;
const BETA_EPH_KEY = (betaFeedbackId: number, tgId: number) => `beta_eph:${betaFeedbackId}:${tgId}`;

async function storeEphemeral(env: Env, bugId: number, tgId: number, ephId: number) {
  await env.SESSIONS.put(EPH_KEY(bugId, tgId), String(ephId), { expirationTtl: 600 });
}
async function takeEphemeral(env: Env, bugId: number, tgId: number): Promise<number | null> {
  const raw = await env.SESSIONS.get(EPH_KEY(bugId, tgId));
  if (!raw) return null;
  await env.SESSIONS.delete(EPH_KEY(bugId, tgId));
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
async function storeBetaEphemeral(env: Env, betaFeedbackId: number, tgId: number, ephId: number) {
  await env.SESSIONS.put(BETA_EPH_KEY(betaFeedbackId, tgId), String(ephId), { expirationTtl: 600 });
}
async function takeBetaEphemeral(env: Env, betaFeedbackId: number, tgId: number): Promise<number | null> {
  const raw = await env.SESSIONS.get(BETA_EPH_KEY(betaFeedbackId, tgId));
  if (!raw) return null;
  await env.SESSIONS.delete(BETA_EPH_KEY(betaFeedbackId, tgId));
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── Router ─────────────────────────────────────────────
// Recognizes the `rich:*` grammar (new) and also the older `menu:*` / `act:*`
// callbacks emitted by the pre-10.3 keyboard so nothing breaks in flight.
// `idea:*` handles Feature Idea management taps.
export async function handleAdminCallback(ctx: CallbackCtx): Promise<boolean> {
  const { env, data, fromTgId, callbackQueryId, chatId, messageId } = ctx;

  // Feature Idea and Beta Feedback callbacks — separate grammars, separate handlers.
  if (data.startsWith("idea:")) {
    return await handleIdeaCallback(ctx);
  }
  if (data.startsWith("beta:")) {
    return await handleBetaFeedbackCallback(ctx);
  }

  if (data === "noop") {
    // Disabled current-selection buttons emit this. Give the tapper a hint.
    await answerCallbackQuery(env, callbackQueryId, "That's the current value.");
    return true;
  }

  if (!data.startsWith("rich:") && !data.startsWith("menu:") && !data.startsWith("act:")) {
    log.warn("admin_callback_grammar_mismatch", { data });
    return false;
  }

  const authorized = isAdmin(env, fromTgId);
  log.info("admin_callback_authorization", { data, fromTgId, authorized });
  if (!authorized) {
    await answerCallbackQuery(env, callbackQueryId, "Not authorized.", true);
    return true;
  }

  // Extract bugId (always the second-or-third path component depending on grammar).
  const parts = data.split(":");
  const bugId = Number(data.startsWith("rich:") ? parts[2] : parts[2]);
  if (!Number.isFinite(bugId)) return false;

  const bug = await getBug(env, bugId);
  if (!bug) {
    await answerCallbackQuery(env, callbackQueryId, "Bug not found.", true);
    return true;
  }

  // ── Menu openers → ephemeral picker ──────────────────
  if (data.startsWith("rich:menu:") || data.startsWith("menu:")) {
    const what = data.startsWith("rich:menu:") ? parts[3] : parts[1];
    let picker;
    if (what === "status")   picker = buildStatusPickerRichMessage(bug);
    else if (what === "severity") picker = buildSeverityPickerRichMessage(bug);
    else if (what === "category") picker = buildCategoryPickerRichMessage(bug);
    else if (what === "note")     picker = buildNotePromptRichMessage(bug);
    else if (what === "back") {
      // "Back" while no picker is stored — just ack.
      await answerCallbackQuery(env, callbackQueryId);
      return true;
    } else {
      await answerCallbackQuery(env, callbackQueryId, "Unknown menu.", true);
      return true;
    }

    // Bot API 10.3: ephemeral message replaces the report IN PLACE for
    // this admin only, via replace_callback_query_message. Do NOT pass
    // message_thread_id or reply_parameters here — those turn the send
    // into a new comment in the thread instead of a replacement of the
    // callback-originating message. The replacement inherits the
    // location of the tapped message automatically.
    const ephemeral: EphemeralMessageParameters = {
      receiver_user_id: fromTgId,
      callback_query_id: callbackQueryId,
      replace_callback_query_message: true,
    };
    try {
      const eph = await sendEphemeralRichMessage(env, chatId, ephemeral, picker);
      // Prefer ephemeral_message_id when Telegram provides it (10.2+
      // ephemerals); fall back to message_id for compatibility.
      const ephId = eph.ephemeral_message_id ?? eph.message_id ?? 0;
      if (ephId) await storeEphemeral(env, bug.id, fromTgId, ephId);
      // No answerCallbackQuery — ephemeral send already consumed the callback.
    } catch (e) {
      log.error("ephemeral_picker_send_failed", e, { bugId, what });
      await answerCallbackQuery(env, callbackQueryId, "Couldn't open menu.", true);
    }
    return true;
  }

  // ── Back button inside a picker → dismiss ────────────
  if (data.startsWith("rich:back:")) {
    await dismissPicker(env, chatId, bug.id, fromTgId, messageId);
    await answerCallbackQuery(env, callbackQueryId);
    return true;
  }

  // ── Concrete actions ─────────────────────────────────
  // rich:act:<bugId>:<verb>:<value>  or  act:<verb>:<bugId>:<value> (legacy)
  const verb  = data.startsWith("rich:act:") ? parts[3] : parts[1];
  const value = data.startsWith("rich:act:") ? parts[4] : parts[3];

  try {
    switch (verb) {
      case "status": {
        if (!(STATUS_IDS as readonly string[]).includes(value)) {
          await answerCallbackQuery(env, callbackQueryId, "Unknown status.", true);
          return true;
        }
        const fromStatus = bug.status;
        const updated = await changeStatus(env, bug.id, value as StatusId, fromTgId);
        await afterAction(env, callbackQueryId, chatId, bug.id, fromTgId, messageId,
          `Status → ${statusMeta(value).label}`);
        if (updated) {
          void syncStatusChange(env, updated, fromStatus, value).catch((e) =>
            log.warn("sync_status_failed", { bugId: bug.id, err: String(e) }));
        }
        break;
      }
      case "severity": {
        if (!(SEVERITY_IDS as readonly string[]).includes(value)) {
          await answerCallbackQuery(env, callbackQueryId, "Unknown severity.", true);
          return true;
        }
        const from = bug.severity;
        await updateBugSeverity(env, bug.id, value);
        const fresh = await getBug(env, bug.id);
        if (fresh) {
          const fromLabel = severityMeta(from).label;
          const toLabel = severityMeta(value).label;
          await refreshChannelTicket(env, fresh);
          await refreshRichReport(env, fresh);
          if (from !== value) {
            await postManagementUpdateToThread(env, fresh, "BUG SEVERITY UPDATE", `${fromLabel} → ${toLabel}`);
            await notifyBugReporterFieldChange(env, fresh, "Severity", fromLabel, toLabel);
          }
          void syncSeverityChange(env, fresh, from, value).catch((e) =>
            log.warn("sync_severity_failed", { bugId: bug.id, err: String(e) }));
        }
        await afterAction(env, callbackQueryId, chatId, bug.id, fromTgId, messageId,
          `Severity → ${severityMeta(value).label}`);
        break;
      }
      case "category": {
        if (!(CATEGORY_IDS as readonly string[]).includes(value)) {
          await answerCallbackQuery(env, callbackQueryId, "Unknown category.", true);
          return true;
        }
        const from = bug.category;
        await updateBugCategory(env, bug.id, value);
        const fresh = await getBug(env, bug.id);
        if (fresh) {
          const fromLabel = categoryMeta(from).label;
          const toLabel = categoryMeta(value).label;
          await refreshChannelTicket(env, fresh);
          await refreshRichReport(env, fresh);
          if (from !== value) {
            await postManagementUpdateToThread(env, fresh, "BUG CATEGORY UPDATE", `${fromLabel} → ${toLabel}`);
            await notifyBugReporterFieldChange(env, fresh, "Category", fromLabel, toLabel);
          }
          void syncCategoryChange(env, fresh, from, value).catch((e) =>
            log.warn("sync_category_failed", { bugId: bug.id, err: String(e) }));
        }
        await afterAction(env, callbackQueryId, chatId, bug.id, fromTgId, messageId,
          `Category → ${categoryMeta(value).label}`);
        break;
      }
      default:
        await answerCallbackQuery(env, callbackQueryId, "Unknown action.", true);
        return true;
    }
  } catch (e) {
    log.error("admin_action_failed", e, { data });
    await answerCallbackQuery(env, callbackQueryId, "Action failed. Check logs.", true);
  }
  return true;
}

async function notifyBugReporterFieldChange(
  env: Env,
  row: BugRow,
  field: string,
  fromLabel: string,
  toLabel: string,
): Promise<void> {
  const publicId = `BUG-${String(row.public_number).padStart(4, "0")}`;
  try {
    await sendMessage(
      env,
      row.reporter_tg_id,
      [
        `<b>${esc(publicId)} Update</b>`,
        esc(row.title),
        "",
        `${esc(field)} changed: ${esc(fromLabel)} → <b>${esc(toLabel)}</b>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  } catch (e) {
    log.warn("bug_reporter_field_dm_failed", { bugId: row.id, field, err: String(e) });
  }
}

// Common post-action tidy: delete the ephemeral picker (if any) and ack.
// `tappedMessageId` is the callback query's own message id — for taps on
// an ephemeral picker this IS the ephemeral_message_id we need to delete.
async function afterAction(env: Env, cbId: string, chatId: number, bugId: number, tgId: number, tappedMessageId: number, toast: string) {
  await dismissPicker(env, chatId, bugId, tgId, tappedMessageId);
  await answerCallbackQuery(env, cbId, toast);
}

async function dismissPicker(env: Env, chatId: number, bugId: number, tgId: number, tappedMessageId?: number) {
  // Preferred path: the callback that fired came FROM the picker, so its
  // message id IS the ephemeral_message_id we need. This is robust even
  // when Telegram returned 0 for message_id on the original send.
  let ephId = tappedMessageId && tappedMessageId > 0 ? tappedMessageId : 0;
  if (!ephId) {
    const stored = await takeEphemeral(env, bugId, tgId);
    if (stored) ephId = stored;
  } else {
    // Clear any KV bookkeeping we may have set at send time.
    await env.SESSIONS.delete(EPH_KEY(bugId, tgId));
  }
  if (!ephId) {
    log.warn("dismiss_picker_no_id", { bugId, tgId });
    return;
  }
  try {
    // `tgId` here IS the admin who tapped — Telegram requires the same
    // receiver_user_id we sent the ephemeral to.
    await deleteEphemeralMessage(env, chatId, tgId, ephId);
  } catch (e) {
    log.warn("ephemeral_delete_failed", { bugId, ephId, err: String(e) });
  }
}

// ── Idea callback handler ─────────────────────────────
// Grammar: idea:act:<ideaId>:status:<statusId>
//          idea:back:<ideaId>   (dismiss any picker)
// Accept/Reject transitions record a pending-reason prompt in KV. The
// admin then types `/reason <text>` in the same thread to attach the
// decision reason; the reason is saved to the idea row and mirrored into
// GitHub + Rich Message.
async function handleIdeaCallback(ctx: CallbackCtx): Promise<boolean> {
  const { env, data, fromTgId, callbackQueryId, chatId, messageId } = ctx;
  if (!isAdmin(env, fromTgId)) {
    await answerCallbackQuery(env, callbackQueryId, "Not authorized.", true);
    return true;
  }
  const parts = data.split(":");
  const ideaId = Number(parts[2]);
  if (!Number.isFinite(ideaId)) return false;

  if (data.startsWith("idea:back:")) {
    await answerCallbackQuery(env, callbackQueryId);
    return true;
  }

  // idea:act:<ideaId>:<verb>:<value>
  const verb = parts[3];
  const value = parts[4];
  if (verb !== "status") {
    await answerCallbackQuery(env, callbackQueryId, "Unknown idea action.", true);
    return true;
  }
  const { IDEA_STATUS_IDS, ideaStatusMeta } = await import("../ideas/constants");
  if (!(IDEA_STATUS_IDS as readonly string[]).includes(value)) {
    await answerCallbackQuery(env, callbackQueryId, "Unknown status.", true);
    return true;
  }
  const { changeIdeaStatus } = await import("../ideas/service");
  const updated = await changeIdeaStatus(env, ideaId, value as any, fromTgId, null);
  if (!updated) {
    await answerCallbackQuery(env, callbackQueryId, "Idea not found.", true);
    return true;
  }

  // Accept / Reject need a reason. Park a pending-reason key so the next
  // `/reason <text>` from this admin in this thread attaches to this idea.
  if (value === "accepted" || value === "rejected") {
    await env.SESSIONS.put(
      `idea_reason_pending:${updated.discussion_thread_id ?? 0}:${fromTgId}`,
      String(ideaId),
      { expirationTtl: 60 * 30 },
    );
    await answerCallbackQuery(
      env, callbackQueryId,
      `Idea marked ${value}. Type /reason <text> in this thread to record why.`,
      true,
    );
  } else {
    await answerCallbackQuery(env, callbackQueryId, `Idea → ${ideaStatusMeta(value).label}`);
  }

  // GitHub Discussions sync — post a follow-up comment reflecting the change.
  void syncIdeaStatusToGitHub(env, updated, value).catch((e) =>
    log.warn("idea_github_status_sync_failed", { ideaId, err: String(e) }));

  return true;
}

async function syncIdeaStatusToGitHub(env: Env, idea: import("../db/types").IdeaRow, toStatus: string): Promise<void> {
  if (!idea.github_discussion_id) return;
  const { resolveIdeaDiscussion, ideaStatusMeta } = await import("../ideas/constants");
  const target = resolveIdeaDiscussion(idea.app);
  if (!target) return;
  const { addDiscussionComment } = await import("../github/discussions");
  const st = ideaStatusMeta(toStatus);
  const body = `### Idea status: ${st.emoji} ${st.label}\n\n${
    idea.decision_reason ? `${idea.decision_reason}\n\n` : ""
  }_Updated through the Voxiverse Telegram Mini App._`;
  await addDiscussionComment(env, target, body);
}

// ── Beta Feedback callback handler ─────────────────────
// Grammar: beta:menu:<betaFeedbackId>:status
//          beta:act:<betaFeedbackId>:status:<statusId>
//          beta:back:<betaFeedbackId>
async function handleBetaFeedbackCallback(ctx: CallbackCtx): Promise<boolean> {
  const { env, data, fromTgId, callbackQueryId, chatId, messageId } = ctx;
  if (!isAdmin(env, fromTgId)) {
    await answerCallbackQuery(env, callbackQueryId, "Not authorized.", true);
    return true;
  }
  const parts = data.split(":");
  const betaFeedbackId = Number(parts[2]);
  if (!Number.isFinite(betaFeedbackId)) return false;

  if (data.startsWith("beta:back:")) {
    await dismissBetaPicker(env, chatId, betaFeedbackId, fromTgId, messageId);
    await answerCallbackQuery(env, callbackQueryId);
    return true;
  }

  const { getBetaFeedback } = await import("../db/queries");
  const betaFeedback = await getBetaFeedback(env, betaFeedbackId);
  if (!betaFeedback) {
    await answerCallbackQuery(env, callbackQueryId, "Beta feedback not found.", true);
    return true;
  }

  if (data.startsWith("beta:menu:")) {
    const what = parts[3];
    if (what !== "status") {
      await answerCallbackQuery(env, callbackQueryId, "Unknown beta feedback menu.", true);
      return true;
    }
    const ephemeral: EphemeralMessageParameters = {
      receiver_user_id: fromTgId,
      callback_query_id: callbackQueryId,
      replace_callback_query_message: true,
    };
    try {
      const eph = await sendEphemeralRichMessage(
        env,
        chatId,
        ephemeral,
        buildBetaFeedbackStatusPickerRichMessage(betaFeedback),
      );
      const ephId = eph.ephemeral_message_id ?? eph.message_id ?? 0;
      if (ephId) await storeBetaEphemeral(env, betaFeedback.id, fromTgId, ephId);
    } catch (e) {
      log.error("beta_feedback_ephemeral_picker_send_failed", e, { betaFeedbackId, what });
      await answerCallbackQuery(env, callbackQueryId, "Couldn't open menu.", true);
    }
    return true;
  }

  if (!data.startsWith("beta:act:")) {
    await answerCallbackQuery(env, callbackQueryId, "Unknown beta feedback action.", true);
    return true;
  }

  const verb = parts[3];
  const value = parts[4];
  if (verb !== "status") {
    await answerCallbackQuery(env, callbackQueryId, "Unknown beta feedback action.", true);
    return true;
  }
  const { BETA_STATUS_IDS, betaStatusMeta } = await import("../beta/constants");
  if (!(BETA_STATUS_IDS as readonly string[]).includes(value)) {
    await answerCallbackQuery(env, callbackQueryId, "Unknown status.", true);
    return true;
  }
  const { changeBetaFeedbackStatus } = await import("../beta/service");
  const updated = await changeBetaFeedbackStatus(env, betaFeedbackId, value as any, fromTgId);
  if (!updated) {
    await answerCallbackQuery(env, callbackQueryId, "Beta feedback not found.", true);
    return true;
  }
  await dismissBetaPicker(env, chatId, betaFeedbackId, fromTgId, messageId);
  await answerCallbackQuery(env, callbackQueryId, `Beta Feedback → ${betaStatusMeta(value).label}`);
  return true;
}

async function dismissBetaPicker(
  env: Env,
  chatId: number,
  betaFeedbackId: number,
  tgId: number,
  tappedMessageId?: number,
) {
  let ephId = tappedMessageId && tappedMessageId > 0 ? tappedMessageId : 0;
  if (!ephId) {
    const stored = await takeBetaEphemeral(env, betaFeedbackId, tgId);
    if (stored) ephId = stored;
  } else {
    await env.SESSIONS.delete(BETA_EPH_KEY(betaFeedbackId, tgId));
  }
  if (!ephId) {
    log.warn("beta_feedback_dismiss_picker_no_id", { betaFeedbackId, tgId });
    return;
  }
  try {
    await deleteEphemeralMessage(env, chatId, tgId, ephId);
  } catch (e) {
    log.warn("beta_feedback_ephemeral_delete_failed", { betaFeedbackId, ephId, err: String(e) });
  }
}

// ── Admin commands typed inside a bug's discussion thread ─
// /note <text>, /fixed <ver> [build], /dup BUG-####
// The note flow also comments on GitHub.
export async function handleAdminGroupCommand(
  env: Env,
  msg: {
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    sender_chat?: { id: number; type: string; title?: string; username?: string };
    message_thread_id?: number;
    reply_to_message?: import("./api").TelegramMessage;
    text?: string;
  },
): Promise<boolean> {
  const text = (msg.text ?? "").trim();
  if (!text.startsWith("/")) return false;

  // Anonymous supergroup admins are represented by Telegram through
  // `sender_chat` (the discussion group itself), not a usable personal User.
  const anonymousAdmin = msg.sender_chat?.id === discussionChatId(env);
  const userAdmin = !!msg.from && isAdmin(env, msg.from.id);
  if (!anonymousAdmin && !userAdmin) return false;

  const spaceIdx = text.indexOf(" ");
  const rawCmd = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

  // /reason is an idea-flow command; it doesn't need a matching bug row.
  // Handle it before the bug lookup so it works in idea threads too.
  if (cmd === "reason") return await handleReasonCommand(env, msg, args);

  // The legacy bug admin commands below are forum-thread based and still
  // require message_thread_id. /reason is resolved independently above so
  // linked-channel discussion comments are supported too.
  if (!msg.message_thread_id) return false;
  if (!msg.from || !isAdmin(env, msg.from.id)) return false;

  const row = await env.DB.prepare(`SELECT * FROM bugs WHERE discussion_thread_id = ? LIMIT 1`)
    .bind(msg.message_thread_id)
    .first<BugRow>();
  if (!row) return false;

  switch (cmd) {
    case "note": {
      if (!args) return true;
      const byName = msg.from.username ?? msg.from.first_name ?? String(msg.from.id);
      await postAdminNoteToThread(env, row, args, byName);
      void syncAdminNote(env, row, args, byName).catch((e) =>
        log.warn("sync_note_failed", { bugId: row.id, err: String(e) }));
      return true;
    }
    case "fixed": {
      const [ver, build] = args.split(/\s+/, 2);
      await env.DB.prepare(
        `UPDATE bugs SET fixed_in_version = ?, fixed_in_build = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(ver ?? null, build ?? null, Math.floor(Date.now() / 1000), row.id)
        .run();
      const fromStatus = row.status;
      const updated = await changeStatus(env, row.id, "fixed", msg.from.id);
      if (updated) {
        void syncStatusChange(env, updated, fromStatus, "fixed").catch((e) =>
          log.warn("sync_status_failed", { bugId: row.id, err: String(e) }));
      }
      return true;
    }
    case "dup": {
      const m = args.match(/BUG-(\d+)/i);
      if (!m) {
        await sendMessage(env, msg.chat.id, "Usage: /dup BUG-####", { message_thread_id: msg.message_thread_id });
        return true;
      }
      const of = await env.DB.prepare(`SELECT * FROM bugs WHERE public_number = ?`)
        .bind(Number(m[1]))
        .first<BugRow>();
      if (!of) {
        await sendMessage(env, msg.chat.id, "That bug number doesn't exist.", { message_thread_id: msg.message_thread_id });
        return true;
      }
      await markDuplicate(env, row.id, of.id);
      const fresh = await getBug(env, row.id);
      if (fresh) {
        await refreshChannelTicket(env, fresh);
        await refreshRichReport(env, fresh);
      }
      await sendMessage(env, msg.chat.id,
        `Marked as duplicate of BUG-${String(of.public_number).padStart(4, "0")}.`,
        { message_thread_id: msg.message_thread_id });
      return true;
    }
    default:
      return false;
  }
}

// /reason <text> — attaches a decision reason to the idea most recently
// Accept/Reject'd by this admin in this thread. Idea-flow command; does
// not require a bugs row to exist for the thread.
async function handleReasonCommand(
  env: Env,
  msg: {
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    sender_chat?: { id: number; type: string; title?: string; username?: string };
    message_thread_id?: number;
    reply_to_message?: import("./api").TelegramMessage;
    text?: string;
  },
  args: string,
): Promise<boolean> {
  const actorTgId = msg.from && isAdmin(env, msg.from.id) ? msg.from.id : 0;
  const anonymousAdmin = msg.sender_chat?.id === discussionChatId(env);
  if (!actorTgId && !anonymousAdmin) return true;

  // Linked channel discussions do not reliably put message_thread_id on
  // user-authored comments. Collect every plausible discussion/root id from
  // both message_thread_id and Telegram's reply chain instead.
  const candidateIds = new Set<number>();
  if (msg.message_thread_id) candidateIds.add(msg.message_thread_id);
  let reply = msg.reply_to_message;
  for (let depth = 0; reply && depth < 8; depth++, reply = reply.reply_to_message) {
    if (reply.message_id) candidateIds.add(reply.message_id);
    if (reply.message_thread_id) candidateIds.add(reply.message_thread_id);
  }

  // Find the Idea represented by this exact linked discussion. Prefer the
  // durable D1 linkage rather than depending on the short-lived KV prompt.
  let ideaId: number | null = null;
  let threadId: number | null = msg.message_thread_id ?? null;
  for (const candidate of candidateIds) {
    const matched = await env.DB.prepare(
      `SELECT id, discussion_thread_id FROM ideas
       WHERE discussion_thread_id = ? OR discussion_message_id = ?
       ORDER BY id DESC LIMIT 1`,
    ).bind(candidate, candidate).first<{ id: number; discussion_thread_id: number | null }>();
    if (matched) {
      ideaId = matched.id;
      threadId = matched.discussion_thread_id ?? candidate;
      break;
    }
  }

  // KV is a fallback for Telegram update shapes where the reply root is not
  // exposed. Check any candidate thread key, then the direct thread id.
  if (ideaId == null) {
    for (const candidate of candidateIds) {
      if (!actorTgId) break;
      const raw = await env.SESSIONS.get(`idea_reason_pending:${candidate}:${actorTgId}`);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n)) { ideaId = n; threadId = candidate; break; }
    }
  }

  if (!args) {
    await sendMessage(env, msg.chat.id, "Usage: /reason <text>", threadId ? { message_thread_id: threadId } : {});
    return true;
  }

  if (ideaId == null) {
    await sendMessage(env, msg.chat.id, "I couldn't match this comment thread to an idea.",
      msg.reply_to_message?.message_id
        ? { reply_parameters: { message_id: msg.reply_to_message.message_id } }
        : {});
    return true;
  }

  const { getIdea } = await import("../db/queries");
  const idea = await getIdea(env, ideaId);
  if (!idea) return true;
  threadId = idea.discussion_thread_id ?? threadId;

  await env.DB.prepare(`UPDATE ideas SET decision_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(args, Math.floor(Date.now() / 1000), ideaId)
    .run();

  // Clear the pending key using the durable idea thread id and any candidate
  // ids Telegram supplied so stale prompts cannot linger.
  if (threadId) await env.SESSIONS.delete(`idea_reason_pending:${threadId}:${actorTgId}`);
  if (actorTgId) {
    for (const candidate of candidateIds) {
      await env.SESSIONS.delete(`idea_reason_pending:${candidate}:${actorTgId}`);
    }
  }

  const fresh = await getIdea(env, ideaId);
  if (!fresh) return true;
  const { refreshIdeaRichReport } = await import("./channel");
  await refreshIdeaRichReport(env, fresh);

  try {
    const { renderIdeaReporterDm } = await import("../ideas/formatting");
    await sendMessage(env, fresh.reporter_tg_id, renderIdeaReporterDm(fresh, null), { parse_mode: "HTML" });
  } catch (e) {
    log.warn("idea_reason_reporter_dm_failed", { ideaId, err: String(e) });
  }

  if (fresh.github_discussion_id) {
    const { resolveIdeaDiscussion } = await import("../ideas/constants");
    const target = resolveIdeaDiscussion(fresh.app);
    if (target) {
      const { addDiscussionComment } = await import("../github/discussions");
      const label = fresh.status === "accepted" ? "Accepted" : fresh.status === "rejected" ? "Rejected" : "Update";
      await addDiscussionComment(env, target,
        `### ${label} — Reason\n\n${args}\n\n_Updated through the Voxiverse Telegram Mini App._`);
    }
  }

  const sendOpts = fresh.discussion_thread_id
    ? { message_thread_id: fresh.discussion_thread_id, reply_parameters: { message_id: fresh.discussion_message_id ?? fresh.discussion_thread_id } }
    : msg.reply_to_message?.message_id
      ? { reply_parameters: { message_id: msg.reply_to_message.message_id } }
      : {};
  await sendMessage(env, msg.chat.id, `Reason saved for ${ideaPublicLabel(fresh.public_number)}.`, sendOpts);
  return true;
}

function ideaPublicLabel(publicNumber: number): string {
  return `IDEA-${String(publicNumber).padStart(4, "0")}`;
}

// Prevent unused-import warnings.
export const __unused_discussionChatId = discussionChatId;
export const __unused_postStatusUpdateToThread = postStatusUpdateToThread;
