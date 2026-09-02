import type { Env } from "../config";
import { channelId, discussionChatId, isAdmin } from "../config";
import { sendMessage } from "../telegram/api";
import { assignWork, isWorkIdFormat, type ResolvedWorkRef } from "./service";
import { esc } from "../util/html";

type WorkCommandName = "case" | "assign";

interface WorkCommandMessage {
  message_id?: number;
  chat: { id: number; type?: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  sender_chat?: { id: number; type: string; title?: string; username?: string };
  message_thread_id?: number;
}

export function isWorkAssignmentCommand(cmd: string): cmd is WorkCommandName {
  return cmd === "case" || cmd === "assign";
}

export async function handleWorkAssignmentCommand(
  env: Env,
  msg: WorkCommandMessage,
  cmd: WorkCommandName,
  args: string,
): Promise<boolean> {
  const threadOpts = commandReplyOptions(msg);
  const authorized = isAuthorizedWorkCommand(env, msg);
  if (!authorized) {
    await sendMessage(env, msg.chat.id, "This command is admin-only.", threadOpts);
    return true;
  }

  const usage = commandUsage(cmd);
  const parsed = parseAssignmentArgs(args, env.BOT_USERNAME, msg.from?.username);
  if (!parsed) {
    await sendMessage(env, msg.chat.id, usage, { ...threadOpts, parse_mode: "HTML" });
    return true;
  }
  if (!isTelegramUsername(parsed.username)) {
    await sendMessage(env, msg.chat.id, "Username must look like @username.", threadOpts);
    return true;
  }
  if (!isWorkIdFormat(parsed.workId)) {
    await sendMessage(env, msg.chat.id, "Work ID must be 6 characters using the internal Work ID format.", threadOpts);
    return true;
  }

  const result = await assignWork(env, {
    expected_types: cmd === "case" ? ["bug"] : ["idea", "beta"],
    work_id: parsed.workId,
    assigned_username: parsed.username,
    assigned_by: msg.from?.id ?? 0,
    assigned_by_username: msg.from?.username ?? msg.from?.first_name ?? msg.sender_chat?.username ?? msg.sender_chat?.title ?? null,
    note: parsed.note,
  });

  if (!result.ok) {
    await sendMessage(
      env,
      result.resolved ? discussionChatId(env) : msg.chat.id,
      renderAssignmentError(cmd, result),
      { ...(result.resolved ? workCommentReplyOptions(result.resolved, msg) : threadOpts), parse_mode: "HTML" },
    );
    return true;
  }

  await sendMessage(
    env,
    discussionChatId(env),
    renderAssignmentConfirmation(cmd, result),
    { ...workCommentReplyOptions(result.resolved, msg), parse_mode: "HTML" },
  );
  return true;
}

function parseAssignmentArgs(
  args: string,
  botUsername: string,
  callerUsername?: string,
): { username: string; workId: string; note: string } | null {
  const botMention = normalizeMention(botUsername);
  let normalized = args.trim();
  if (botMention && normalized.toLowerCase().startsWith(`${botMention.toLowerCase()} `)) {
    normalized = normalized.slice(botMention.length).trim();
  }

  let match = normalized.match(/^(@[A-Za-z0-9_]{5,32})\s+([A-Za-z0-9]{6})\s+([\s\S]+)$/);
  if (match) {
    const note = match[3].trim();
    if (!note) return null;
    return {
      username: match[1],
      workId: match[2].toUpperCase(),
      note,
    };
  }

  match = normalized.match(/^([A-Za-z0-9]{6})\s+([\s\S]+)$/);
  const note = match?.[2]?.trim() ?? "";
  if (!match || !note || !callerUsername) return null;
  const username = normalizeMention(callerUsername);
  if (!username) return null;
  if (!note) return null;
  return {
    username,
    workId: match[1].toUpperCase(),
    note,
  };
}

function normalizeMention(value: string | undefined | null): string {
  const clean = (value ?? "").trim().replace(/^@/, "");
  return clean ? `@${clean}` : "";
}

function isTelegramUsername(value: string): boolean {
  return /^@[A-Za-z0-9_]{5,32}$/.test(value);
}

function isAuthorizedWorkCommand(env: Env, msg: WorkCommandMessage): boolean {
  if (msg.from && isAdmin(env, msg.from.id)) return true;
  const senderChatId = msg.sender_chat?.id;
  if (!senderChatId) return false;
  const chatId = msg.chat.id;
  const configured = configuredInternalChatIds(env);
  if (configured.has(chatId) || configured.has(senderChatId)) return true;
  return msg.chat.type !== "private" && senderChatId === chatId;
}

function commandReplyOptions(msg: WorkCommandMessage): { message_thread_id?: number; reply_parameters?: { message_id: number } } {
  if (msg.message_thread_id) return { message_thread_id: msg.message_thread_id };
  if (msg.message_id) return { reply_parameters: { message_id: msg.message_id } };
  return {};
}

function workCommentReplyOptions(
  resolved: ResolvedWorkRef,
  msg: WorkCommandMessage,
): { message_thread_id?: number; reply_parameters?: { message_id: number } } {
  const row = resolved.submission;
  const rootMessageId = row.report_message_id ?? row.discussion_message_id ?? row.discussion_thread_id ?? null;
  if (row.discussion_thread_id && rootMessageId) {
    return {
      message_thread_id: row.discussion_thread_id,
      reply_parameters: { message_id: rootMessageId },
    };
  }
  if (rootMessageId) return { reply_parameters: { message_id: rootMessageId } };
  return commandReplyOptions(msg);
}

function configuredInternalChatIds(env: Env): Set<number> {
  const ids = new Set<number>([channelId(env), discussionChatId(env)]);
  for (const raw of (env.JOIN_APPROVAL_CHAT_IDS ?? "").split(",")) {
    const id = Number(raw.trim());
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

function commandUsage(cmd: WorkCommandName): string {
  if (cmd === "case") {
    return [
      "<b>Usage:</b>",
      "/case &lt;username&gt; &lt;workID&gt; &lt;note&gt;",
      "",
      "<b>Example:</b>",
      "/case @alex 7KQ3XM Investigating the reminder completion issue",
    ].join("\n");
  }
  return [
    "<b>Usage:</b>",
    "/assign &lt;username&gt; &lt;workID&gt; &lt;note&gt;",
    "",
    "<b>Example:</b>",
    "/assign @alex M4PX8C Building this because I already work on this feature area",
  ].join("\n");
}

function renderAssignmentConfirmation(
  cmd: WorkCommandName,
  result: Extract<Awaited<ReturnType<typeof assignWork>>, { ok: true }>,
): string {
  const title = cmd === "case"
    ? "✅ Case Assigned"
    : result.resolved.submission_type === "beta"
    ? "✅ Feedback Assigned"
    : "✅ Idea Assigned";
  return [
    `<b>${title}</b>`,
    "",
    `<b>${esc(result.resolved.public_id)}</b>`,
    `<blockquote>Work ID: ${esc(result.resolved.work_ref.work_id)}</blockquote>`,
    "",
    `Assigned to: ${esc(result.assignment.assigned_username)}`,
    `Note: ${esc(result.assignment.note)}`,
  ].join("\n");
}

function renderAssignmentError(
  cmd: WorkCommandName,
  result: Extract<Awaited<ReturnType<typeof assignWork>>, { ok: false }>,
): string {
  switch (result.error) {
    case "bad_work_id":
      return "Work ID must be 6 characters using the internal Work ID format.";
    case "not_found":
      return "That Work ID does not exist.";
    case "wrong_type": {
      const expected = cmd === "case" ? "Bug Report" : "Idea or Beta Feedback";
      const actual = result.resolved?.submission_type === "bug"
        ? "Bug Report"
        : result.resolved?.submission_type === "idea"
        ? "Idea"
        : "Beta Feedback";
      return `${cmd === "case" ? "/case" : "/assign"} only accepts ${expected} Work IDs. That Work ID resolves to ${actual}.`;
    }
    case "already_assigned": {
      const assigned = result.assignment;
      return [
        "This submission is already actively assigned.",
        "",
        assigned ? `Assigned to: ${esc(assigned.assigned_username)}` : null,
        assigned ? `Assigned: ${esc(formatTimestamp(assigned.assigned_at))}` : null,
        assigned ? `Note: ${esc(assigned.note)}` : null,
      ].filter(Boolean).join("\n");
    }
    default:
      return "Couldn't save the assignment. The database returned an error.";
  }
}

function formatTimestamp(unixSec: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(unixSec * 1000));
}
