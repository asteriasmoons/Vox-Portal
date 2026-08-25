// Top-level Telegram update dispatcher.
// Routes messages, callback_queries, and channel/discussion mirror events
// to the right handler.

import type { Env } from "../config";
import { discussionChatId } from "../config";
import { handleCommand, ensureCommandsRegistered } from "./commands";
import { handleWizardMessage, handleWizardCallback, getSession } from "./conversation";
import { handleAdminCallback, handleAdminGroupCommand } from "./admin";
import { recordDiscussionMirror } from "./channel";
import { claimUpdateId } from "../db/queries";
import { log } from "../util/log";
import type { TelegramMessage } from "./api";

interface Update {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: TelegramMessage;
    data?: string;
  };
}

export async function dispatchUpdate(env: Env, update: Update): Promise<void> {
  const fresh = await claimUpdateId(env, update.update_id);
  if (!fresh) {
    log.info("duplicate_update_ignored", { update_id: update.update_id });
    return;
  }

  // Auto-register slash-command menu on first webhook after deploy.
  // Cheap KV read guarded so it only actually hits Telegram once per version.
  await ensureCommandsRegistered(env);

  try {
    if (update.callback_query) {
      await onCallbackQuery(env, update.callback_query);
      return;
    }
    if (update.message) {
      await onMessage(env, update.message);
      return;
    }
    // channel_post and other update types are not otherwise processed.
  } catch (e) {
    log.error("dispatch_failed", e, { update_id: update.update_id });
  }
}

async function onMessage(env: Env, msg: TelegramMessage) {
  // Case A: message inside the linked discussion group.
  if (msg.chat.id === discussionChatId(env)) {
    // A.1 — Auto-forwarded channel mirror: capture the channel-post → discussion-root mapping.
    // Current Bot API exposes the original channel post through forward_origin.
    if (
      msg.is_automatic_forward &&
      msg.forward_origin?.type === "channel" &&
      typeof msg.forward_origin.message_id === "number"
    ) {
      await recordDiscussionMirror(
        env,
        msg.forward_origin.message_id,
        msg.message_id,
      );
      return;
    }
    // A.2 — Admin slash command inside a bug's thread.
    if (msg.text?.startsWith("/")) {
      const handled = await handleAdminGroupCommand(env, msg);
      if (handled) return;
    }
    return;
  }

  // Case B: private chat with the bot.
  if (msg.chat.type === "private") {
    // Slash command?
    const entities = msg.entities ?? [];
    const first = entities[0];
    if (first?.type === "bot_command" && first.offset === 0 && msg.text) {
      const rawCmd = msg.text.slice(0, first.length); // e.g. "/bug@VoxBugsBot"
      const cmd = rawCmd.replace(/^\//, "").split("@")[0].toLowerCase();
      const args = msg.text.slice(first.length).trim();

      // /cancel always aborts the wizard, even mid-session.
      const handledCmd = await handleCommand(env, msg, cmd, args);
      if (handledCmd) return;
    }

    // Otherwise, if this user has an in-flight wizard, feed it.
    const tgId = msg.from?.id;
    if (tgId && (await getSession(env, tgId))) {
      await handleWizardMessage(env, msg);
    }
    return;
  }
}

async function onCallbackQuery(env: Env, cq: NonNullable<Update["callback_query"]>) {
  const data = cq.data ?? "";
  log.info("callback_query_received", {
    data,
    from_id: cq.from.id,
    chat_id: cq.message?.chat.id,
    message_id: cq.message?.message_id,
  });
  const fromTgId = cq.from.id;
  const messageId = cq.message?.message_id;
  const chatId = cq.message?.chat.id;
  if (!messageId || !chatId) return;

  // Wizard picker taps (private chat).
  if (data.startsWith("wiz:") && cq.message?.chat.type === "private") {
    const handled = await handleWizardCallback(env, chatId, fromTgId, data);
    if (handled) {
      const { answerCallbackQuery } = await import("./api");
      await answerCallbackQuery(env, cq.id);
      return;
    }
  }

  // Admin taps in the discussion group.
  if ((data.startsWith("menu:") || data.startsWith("act:")) && cq.message?.chat.id === discussionChatId(env)) {
    await handleAdminCallback({
      env,
      callbackQueryId: cq.id,
      chatId,
      messageId,
      fromTgId,
      data,
    });
    return;
  }

  // Fallback ack so the spinner doesn't hang.
  const { answerCallbackQuery } = await import("./api");
  await answerCallbackQuery(env, cq.id);
}
