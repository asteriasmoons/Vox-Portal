// Password-gated Telegram join approvals.
//
// Telegram gives bots a temporary `user_chat_id` in chat_join_request updates.
// We use that private chat id to ask for the access password before approving
// the pending channel request.

import type { Env } from "../config";
import { channelId } from "../config";
import {
  approveChatJoinRequest,
  declineChatJoinRequest,
  sendMessage,
  type TelegramChatJoinRequest,
  type TelegramMessage,
} from "./api";
import { esc } from "../util/html";
import { log } from "../util/log";

const JOIN_TTL_SEC = 5 * 60;
const MAX_ATTEMPTS = 3;

interface PendingJoinApproval {
  chatId: number;
  userId: number;
  userChatId: number;
  attempts: number;
  requestedAt: number;
  chatTitle?: string;
  inviteLink?: string;
}

const userKey = (userId: number) => `join:user:${userId}`;
const chatKey = (userChatId: number) => `join:chat:${userChatId}`;

export async function handleChatJoinRequest(env: Env, request: TelegramChatJoinRequest): Promise<void> {
  if (request.chat.id !== channelId(env)) {
    log.warn("chat_join_request_ignored_wrong_chat", {
      chatId: request.chat.id,
      userId: request.from.id,
      configuredChannelId: channelId(env),
    });
    return;
  }

  if (!joinPassword(env)) {
    log.error("chat_join_request_password_missing", undefined, {
      chatId: request.chat.id,
      userId: request.from.id,
    });
    return;
  }

  const pending: PendingJoinApproval = {
    chatId: request.chat.id,
    userId: request.from.id,
    userChatId: request.user_chat_id,
    attempts: 0,
    requestedAt: request.date,
    chatTitle: request.chat.title,
    inviteLink: request.invite_link?.invite_link,
  };

  await savePending(env, pending);

  try {
    await sendMessage(
      env,
      request.user_chat_id,
      [
        `Hi ${esc(displayName(request.from))}.`,
        ``,
        `To join <b>${esc(request.chat.title ?? "Voxiverse")}</b>, reply with the access password.`,
        ``,
        `This request expires in 5 minutes.`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    log.info("chat_join_request_challenge_sent", {
      chatId: request.chat.id,
      userId: request.from.id,
      userChatId: request.user_chat_id,
      inviteLink: request.invite_link?.invite_link ?? null,
    });
  } catch (e) {
    log.error("chat_join_request_challenge_failed", e, {
      chatId: request.chat.id,
      userId: request.from.id,
      userChatId: request.user_chat_id,
    });
  }
}

export async function handleJoinApprovalPasswordMessage(env: Env, msg: TelegramMessage): Promise<boolean> {
  if (msg.chat.type !== "private") return false;
  const fromId = msg.from?.id;
  if (!fromId) return false;

  const pending = await getPending(env, msg.chat.id, fromId);
  if (!pending) return false;

  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!text) {
    await sendMessage(env, pending.userChatId, "Please reply with the access password as text.");
    return true;
  }

  if (/^\/?(cancel|stop)$/i.test(text)) {
    await sendMessage(env, pending.userChatId, "Join request cancelled.");
    await declineAndClear(env, pending, "chat_join_request_cancelled");
    return true;
  }

  if (normalizePassword(text) === normalizePassword(joinPassword(env) ?? "")) {
    await sendMessage(env, pending.userChatId, "Password accepted. Approving your join request now.");
    try {
      await approveChatJoinRequest(env, pending.chatId, pending.userId);
      await clearPending(env, pending);
      log.info("chat_join_request_approved", {
        chatId: pending.chatId,
        userId: pending.userId,
        userChatId: pending.userChatId,
      });
    } catch (e) {
      await clearPending(env, pending);
      log.error("chat_join_request_approve_failed", e, {
        chatId: pending.chatId,
        userId: pending.userId,
        userChatId: pending.userChatId,
      });
      await sendMessage(env, pending.userChatId, "I could not approve the request. Please ask an admin to check it.");
    }
    return true;
  }

  pending.attempts += 1;
  if (pending.attempts >= MAX_ATTEMPTS) {
    await sendMessage(env, pending.userChatId, "That password was incorrect. Your join request was declined.");
    await declineAndClear(env, pending, "chat_join_request_declined_wrong_password");
    return true;
  }

  await savePending(env, pending);
  const remaining = MAX_ATTEMPTS - pending.attempts;
  await sendMessage(
    env,
    pending.userChatId,
    `That password was incorrect. Try again. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
  );
  log.info("chat_join_request_password_incorrect", {
    chatId: pending.chatId,
    userId: pending.userId,
    attempts: pending.attempts,
  });
  return true;
}

async function savePending(env: Env, pending: PendingJoinApproval): Promise<void> {
  const value = JSON.stringify(pending);
  await Promise.all([
    env.SESSIONS.put(userKey(pending.userId), value, { expirationTtl: JOIN_TTL_SEC }),
    env.SESSIONS.put(chatKey(pending.userChatId), value, { expirationTtl: JOIN_TTL_SEC }),
  ]);
}

async function getPending(
  env: Env,
  privateChatId: number,
  fromUserId: number,
): Promise<PendingJoinApproval | null> {
  const raw = (await env.SESSIONS.get(chatKey(privateChatId))) ?? (await env.SESSIONS.get(userKey(fromUserId)));
  return raw ? (JSON.parse(raw) as PendingJoinApproval) : null;
}

async function clearPending(env: Env, pending: PendingJoinApproval): Promise<void> {
  await Promise.all([
    env.SESSIONS.delete(userKey(pending.userId)),
    env.SESSIONS.delete(chatKey(pending.userChatId)),
  ]);
}

async function declineAndClear(env: Env, pending: PendingJoinApproval, eventName: string): Promise<void> {
  try {
    await declineChatJoinRequest(env, pending.chatId, pending.userId);
    log.info(eventName, {
      chatId: pending.chatId,
      userId: pending.userId,
      userChatId: pending.userChatId,
    });
  } catch (e) {
    log.error(`${eventName}_failed`, e, {
      chatId: pending.chatId,
      userId: pending.userId,
      userChatId: pending.userChatId,
    });
  } finally {
    await clearPending(env, pending);
  }
}

function joinPassword(env: Env): string | null {
  const password = env.JOIN_APPROVAL_PASSWORD?.trim();
  return password || null;
}

function normalizePassword(value: string): string {
  return value.trim().toLowerCase();
}

function displayName(user: TelegramChatJoinRequest["from"]): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "there";
}
