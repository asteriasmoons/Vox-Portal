import type { Env } from "../config";
import { isAdmin } from "../config";
import { sendMessage } from "../telegram/api";
import { assignWork, isWorkIdFormat, type AssignmentEventType } from "./service";
import { esc } from "../util/html";

type WorkCommandName = "case" | "assign";

interface WorkCommandMessage {
  chat: { id: number; type?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
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
  const threadOpts = msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
  if (!msg.from || !isAdmin(env, msg.from.id)) {
    await sendMessage(env, msg.chat.id, "This command is admin-only.", threadOpts);
    return true;
  }

  const usage = commandUsage(cmd);
  const parsed = parseAssignmentArgs(args);
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
    expected_type: cmd === "case" ? "bug" : "idea",
    work_id: parsed.workId,
    assigned_username: parsed.username,
    assigned_by: msg.from.id,
    assigned_by_username: msg.from.username ?? msg.from.first_name ?? null,
    note: parsed.note,
    event_type: commandEventType(cmd),
  });

  if (!result.ok) {
    await sendMessage(env, msg.chat.id, renderAssignmentError(cmd, result), { ...threadOpts, parse_mode: "HTML" });
    return true;
  }

  await sendMessage(env, msg.chat.id, renderAssignmentConfirmation(cmd, result), {
    ...threadOpts,
    parse_mode: "HTML",
  });
  return true;
}

function parseAssignmentArgs(args: string): { username: string; workId: string; note: string } | null {
  const match = args.trim().match(/^(@[A-Za-z0-9_]{5,32})\s+([A-Za-z0-9]{6})\s+([\s\S]+)$/);
  if (!match) return null;
  const note = match[3].trim();
  if (!note) return null;
  return {
    username: match[1],
    workId: match[2].toUpperCase(),
    note,
  };
}

function isTelegramUsername(value: string): boolean {
  return /^@[A-Za-z0-9_]{5,32}$/.test(value);
}

function commandEventType(cmd: WorkCommandName): AssignmentEventType {
  return cmd === "case" ? "case_assigned" : "idea_assigned";
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
  const title = cmd === "case" ? "✅ Case Assigned" : "✅ Idea Assigned";
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
      const expected = cmd === "case" ? "Bug Report" : "Idea";
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
