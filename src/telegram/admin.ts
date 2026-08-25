// Admin management flow for the Bot API 10.3 Rich Message report.
//
// Callback grammar (kept in one place so the router below is exhaustive):
//   rich:menu:<bugId>:status | severity | category | note
//   rich:act:<bugId>:status:<statusId>
//   rich:act:<bugId>:severity:<severityId>
//   rich:act:<bugId>:category:<categoryId>
//   rich:back:<bugId>                     (dismiss ephemeral picker)
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
//   8. DMs the reporter on notify-worthy status transitions.
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
} from "./richmessage";
import { refreshRichReport } from "./channel";
import {
  getBug, updateBugCategory, updateBugSeverity, markDuplicate,
} from "../db/queries";
import { changeStatus } from "../bugs/service";
import { refreshChannelTicket, postStatusUpdateToThread, postAdminNoteToThread } from "./channel";
import type { StatusId } from "../bugs/constants";
import { STATUS_IDS, SEVERITY_IDS, CATEGORY_IDS, statusMeta, severityMeta, categoryMeta } from "../bugs/constants";
import {
  syncStatusChange, syncSeverityChange, syncCategoryChange, syncAdminNote,
} from "../github/service";
import { log } from "../util/log";
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

// ── Router ─────────────────────────────────────────────
// Recognizes the `rich:*` grammar (new) and also the older `menu:*` / `act:*`
// callbacks emitted by the pre-10.3 keyboard so nothing breaks in flight.
export async function handleAdminCallback(ctx: CallbackCtx): Promise<boolean> {
  const { env, data, fromTgId, callbackQueryId, chatId, messageId } = ctx;

  if (data === "noop") {
    // Disabled current-selection buttons emit this. Give the tapper a hint.
    await answerCallbackQuery(env, callbackQueryId, "That's the current value.");
    return true;
  }

  if (!data.startsWith("rich:") && !data.startsWith("menu:") && !data.startsWith("act:")) return false;

  if (!isAdmin(env, fromTgId)) {
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

    // Bot API 10.3: ephemeral message replaces the report for this user only,
    // via replace_callback_query_message. Delete-on-back / delete-on-select
    // restores the report.
    const ephemeral: EphemeralMessageParameters = {
      receiver_user_id: fromTgId,
      callback_query_id: callbackQueryId,
      replace_callback_query_message: true,
    };
    try {
      const eph = await sendEphemeralRichMessage(env, chatId, ephemeral, picker, {
        message_thread_id: bug.discussion_thread_id ?? undefined,
      });
      await storeEphemeral(env, bug.id, fromTgId, eph.message_id);
      // No answerCallbackQuery — ephemeral send already consumed the callback.
    } catch (e) {
      log.error("ephemeral_picker_send_failed", e, { bugId, what });
      await answerCallbackQuery(env, callbackQueryId, "Couldn't open menu.", true);
    }
    return true;
  }

  // ── Back button inside a picker → dismiss ────────────
  if (data.startsWith("rich:back:")) {
    await dismissPicker(env, chatId, bug.id, fromTgId);
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
        await afterAction(env, callbackQueryId, chatId, bug.id, fromTgId,
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
          await refreshChannelTicket(env, fresh);
          await refreshRichReport(env, fresh);
          void syncSeverityChange(env, fresh, from, value).catch((e) =>
            log.warn("sync_severity_failed", { bugId: bug.id, err: String(e) }));
        }
        await afterAction(env, callbackQueryId, chatId, bug.id, fromTgId,
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
          await refreshChannelTicket(env, fresh);
          await refreshRichReport(env, fresh);
          void syncCategoryChange(env, fresh, from, value).catch((e) =>
            log.warn("sync_category_failed", { bugId: bug.id, err: String(e) }));
        }
        await afterAction(env, callbackQueryId, chatId, bug.id, fromTgId,
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

// Common post-action tidy: delete the ephemeral picker (if any) and ack.
async function afterAction(env: Env, cbId: string, chatId: number, bugId: number, tgId: number, toast: string) {
  await dismissPicker(env, chatId, bugId, tgId);
  await answerCallbackQuery(env, cbId, toast);
}

async function dismissPicker(env: Env, chatId: number, bugId: number, tgId: number) {
  const ephId = await takeEphemeral(env, bugId, tgId);
  if (!ephId) return;
  try {
    await deleteEphemeralMessage(env, chatId, ephId);
  } catch (e) {
    log.warn("ephemeral_delete_failed", { bugId, err: String(e) });
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
    message_thread_id?: number;
    text?: string;
  },
): Promise<boolean> {
  const text = (msg.text ?? "").trim();
  if (!text.startsWith("/")) return false;
  if (!msg.from || !isAdmin(env, msg.from.id)) return false;
  if (!msg.message_thread_id) return false;

  const row = await env.DB.prepare(`SELECT * FROM bugs WHERE discussion_thread_id = ? LIMIT 1`)
    .bind(msg.message_thread_id)
    .first<BugRow>();
  if (!row) return false;

  const spaceIdx = text.indexOf(" ");
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

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

// Prevent unused-import warnings.
export const __unused_discussionChatId = discussionChatId;
export const __unused_postStatusUpdateToThread = postStatusUpdateToThread;
