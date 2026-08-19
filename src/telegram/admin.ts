// Admin callback-query handling for the inline keyboards attached to
// each bug's discussion-thread report message.

import type { Env } from "../config";
import { isAdmin } from "../config";
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage } from "./api";
import {
  adminActionsKeyboard,
  statusPickerKeyboard,
  severityPickerKeyboard,
  categoryPickerKeyboard,
} from "./keyboards";
import { getBug, updateBugCategory, updateBugSeverity } from "../db/queries";
import { changeStatus } from "../bugs/service";
import { refreshChannelTicket } from "./channel";
import type { StatusId } from "../bugs/constants";
import { STATUS_IDS, SEVERITY_IDS, CATEGORY_IDS } from "../bugs/constants";
import { log } from "../util/log";

interface CallbackCtx {
  env: Env;
  callbackQueryId: string;
  chatId: number;
  messageId: number;
  fromTgId: number;
  data: string;
}

export async function handleAdminCallback(ctx: CallbackCtx): Promise<boolean> {
  const { env, data, fromTgId, callbackQueryId, chatId, messageId } = ctx;

  // Callback formats:
  //   menu:<what>:<bugId>
  //   act:<what>:<bugId>:<value>
  const parts = data.split(":");
  if (parts.length < 3) return false;
  let [prefix, what, bugIdStr, valueMaybe] = parts;
  if (prefix === "a") {
    prefix = "act";
    if (what === "s") what = "status";
  }
  if (prefix !== "menu" && prefix !== "act") return false;

  if (!isAdmin(env, fromTgId)) {
    await answerCallbackQuery(env, callbackQueryId, "Not authorized.", true);
    return true;
  }

  const bugId = Number(bugIdStr);
  const row = await getBug(env, bugId);
  if (!row) {
    await answerCallbackQuery(env, callbackQueryId, "Bug not found.", true);
    return true;
  }

  if (prefix === "menu") {
    switch (what) {
      case "status":
        await editMessageReplyMarkup(env, chatId, messageId, statusPickerKeyboard(bugId));
        break;
      case "severity":
        await editMessageReplyMarkup(env, chatId, messageId, severityPickerKeyboard(bugId));
        break;
      case "category":
        await editMessageReplyMarkup(env, chatId, messageId, categoryPickerKeyboard(bugId));
        break;
      case "back":
        await editMessageReplyMarkup(env, chatId, messageId, adminActionsKeyboard(bugId));
        break;
      case "note":
        await answerCallbackQuery(
          env,
          callbackQueryId,
          "Reply to the report message with your note prefixed by /note.",
          true,
        );
        return true;
      default:
        return false;
    }
    await answerCallbackQuery(env, callbackQueryId);
    return true;
  }

  // prefix === 'act'
  const value = valueMaybe ?? "";
  try {
    switch (what) {
      case "status": {
        if (!(STATUS_IDS as readonly string[]).includes(value)) {
          await answerCallbackQuery(env, callbackQueryId, "Unknown status.", true);
          return true;
        }
        const updated = await changeStatus(env, bugId, value as StatusId, fromTgId);
        if (updated) await answerCallbackQuery(env, callbackQueryId, `Status → ${value}`);
        break;
      }
      case "severity": {
        if (!(SEVERITY_IDS as readonly string[]).includes(value)) {
          await answerCallbackQuery(env, callbackQueryId, "Unknown severity.", true);
          return true;
        }
        await updateBugSeverity(env, bugId, value);
        const fresh = await getBug(env, bugId);
        if (fresh) await refreshChannelTicket(env, fresh);
        await answerCallbackQuery(env, callbackQueryId, `Severity → ${value}`);
        break;
      }
      case "category": {
        if (!(CATEGORY_IDS as readonly string[]).includes(value)) {
          await answerCallbackQuery(env, callbackQueryId, "Unknown category.", true);
          return true;
        }
        await updateBugCategory(env, bugId, value);
        const fresh = await getBug(env, bugId);
        if (fresh) await refreshChannelTicket(env, fresh);
        await answerCallbackQuery(env, callbackQueryId, `Category → ${value}`);
        break;
      }
      default:
        await answerCallbackQuery(env, callbackQueryId, "Unknown action.", true);
        return true;
    }
    // Reset the keyboard to the primary admin menu.
    await editMessageReplyMarkup(env, chatId, messageId, adminActionsKeyboard(bugId));
  } catch (e) {
    log.error("admin_action_failed", e, { data });
    await answerCallbackQuery(env, callbackQueryId, "Action failed. Check logs.", true);
  }
  return true;
}

// Handle admin commands typed inside the discussion group thread.
// Supported:
//   /note <text>       — post an internal note into this bug's thread
//   /fixed <ver> [b]   — mark fixed and record fixed_in_version/build
//   /dup BUG-####      — mark this bug as duplicate of another
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

  // In linked-channel comments, Telegram sets message_thread_id to the
  // auto-forwarded discussion-root message id. That is stored as discussion_message_id.
  const row = await env.DB.prepare(
    `SELECT * FROM bugs WHERE discussion_message_id = ? LIMIT 1`,
  )
    .bind(msg.message_thread_id)
    .first<import("../db/types").BugRow>();
  if (!row) return false;

  const spaceIdx = text.indexOf(" ");
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case "note": {
      if (!args) return true;
      const { postAdminNoteToThread } = await import("./channel");
      const byName = msg.from.username ?? msg.from.first_name ?? String(msg.from.id);
      await postAdminNoteToThread(env, row, args, byName);
      return true;
    }
    case "fixed": {
      const [ver, build] = args.split(/\s+/, 2);
      await env.DB.prepare(
        `UPDATE bugs SET fixed_in_version = ?, fixed_in_build = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(ver ?? null, build ?? null, Math.floor(Date.now() / 1000), row.id)
        .run();
      await changeStatus(env, row.id, "fixed", msg.from.id);
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
        .first<import("../db/types").BugRow>();
      if (!of) {
        await sendMessage(env, msg.chat.id, "That bug number doesn't exist.", { message_thread_id: msg.message_thread_id });
        return true;
      }
      const { markDuplicate } = await import("../db/queries");
      await markDuplicate(env, row.id, of.id);
      const fresh = await getBug(env, row.id);
      if (fresh) await refreshChannelTicket(env, fresh);
      await sendMessage(env, msg.chat.id, `Marked as duplicate of BUG-${String(of.public_number).padStart(4, "0")}.`, {
        message_thread_id: msg.message_thread_id,
      });
      return true;
    }
    default:
      return false;
  }
}
