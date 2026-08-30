// Formatting helpers for channel tickets, discussion posts, and DMs.
// All output is HTML (parse_mode=HTML). Every user-supplied field is escaped.

import type { BugRow } from "../db/types";
import { esc, trunc } from "../util/html";
import { statusMeta, severityMeta, categoryMeta, frequencyMeta } from "./constants";
import { bugOptionLabel } from "./app-metadata";

export function publicIdOf(row: Pick<BugRow, "public_number">): string {
  return `BUG-${String(row.public_number).padStart(4, "0")}`;
}

export function formatTimestamp(unixSec: number): string {
  // Fixed en-US formatting; times shown in UTC to keep channel history unambiguous.
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }) + " UTC";
}

// Concise channel ticket. Scannable at a glance; no long user prose here.
export function renderChannelTicket(row: BugRow): string {
  const st = statusMeta(row.status);
  const sev = severityMeta(row.severity);
  const bugType = categoryMeta(row.bug_type ?? row.category);
  const id = publicIdOf(row);
  const reporter = row.reporter_username
    ? `@${esc(row.reporter_username)}`
    : esc(row.reporter_display_name ?? "anonymous");

  const lines: string[] = [];
  lines.push(`🐛 <b>${esc(id)}</b>`);
  lines.push(`<b>${esc(trunc(row.title, 140))}</b>`);
  lines.push("");
  lines.push(`Status: ${st.emoji} <b>${esc(st.label)}</b>`);
  lines.push(`Severity: <b>${esc(sev.label)}</b>`);
  lines.push(`Bug Type: ${esc(bugType.label)}`);
  lines.push(`App: <b>${esc(row.app)}</b>`);
  if (row.feature) lines.push(`Feature: ${esc(bugOptionLabel(row.app, "feature", row.feature))}`);
  if (row.app_version) lines.push(`Version: ${esc(row.app_version)}`);
  if (row.app_build) lines.push(`Build: ${esc(row.app_build)}`);
  if (row.device) lines.push(`Device: ${esc(row.device)}`);
  if (row.os) lines.push(`OS: ${esc(row.os)}`);
  lines.push(`Reporter: ${reporter}`);
  lines.push(`Submitted: ${esc(formatTimestamp(row.created_at))}`);

  if (row.duplicate_of_id) {
    lines.push("");
    lines.push(`↳ Duplicate of internal bug #${row.duplicate_of_id}`);
  }
  if (row.status === "fixed" && (row.fixed_in_version || row.fixed_in_build)) {
    const v = row.fixed_in_version ? `v${esc(row.fixed_in_version)}` : "";
    const b = row.fixed_in_build ? ` build ${esc(row.fixed_in_build)}` : "";
    lines.push(`Fixed in: ${v}${b}`.trim());
  }
  return lines.join("\n");
}

// Full report — posted as the first message inside the discussion thread.
export function renderReportBody(row: BugRow): string {
  const lines: string[] = [];
  lines.push(`<b>REPORT — ${esc(publicIdOf(row))}</b>`);
  lines.push("");
  lines.push(`<b>What happened</b>`);
  lines.push(esc(row.actual_behavior));
  if (row.expected_behavior) {
    lines.push("");
    lines.push(`<b>Expected behavior</b>`);
    lines.push(esc(row.expected_behavior));
  }
  if (row.reproduction_steps) {
    lines.push("");
    lines.push(`<b>Steps to reproduce</b>`);
    lines.push(esc(row.reproduction_steps));
  }
  if (row.frequency) {
    const f = frequencyMeta(row.frequency);
    lines.push("");
    lines.push(`<b>Frequency:</b> ${esc(f?.label ?? row.frequency)}`);
  }
  if (row.notes) {
    lines.push("");
    lines.push(`<b>Additional notes</b>`);
    lines.push(esc(row.notes));
  }
  return lines.join("\n");
}

// Posted into discussion thread each time status changes.
export function renderStatusUpdate(fromStatus: string | null, toStatus: string): string {
  const from = fromStatus ? statusMeta(fromStatus) : null;
  const to = statusMeta(toStatus);
  const arrow = from ? `${from.emoji} ${from.label} → ${to.emoji} ${to.label}` : `→ ${to.emoji} ${to.label}`;
  return [
    `<b>STATUS UPDATE</b>`,
    esc(arrow),
    esc(formatTimestamp(Math.floor(Date.now() / 1000))),
  ].join("\n");
}

// DM sent to the original reporter on important status changes.
export function renderReporterDm(row: BugRow, fromStatus: string | null): string {
  const st = statusMeta(row.status);
  const id = publicIdOf(row);
  const lines: string[] = [];
  lines.push(`🐛 <b>${esc(id)} Update</b>`);
  lines.push(esc(row.title));
  lines.push("");
  if (fromStatus) {
    const from = statusMeta(fromStatus);
    lines.push(`Status changed: ${from.label} → <b>${esc(st.label)}</b> ${st.emoji}`);
  } else {
    lines.push(`Status: <b>${esc(st.label)}</b> ${st.emoji}`);
  }
  if (row.status === "fixed" && (row.fixed_in_version || row.fixed_in_build)) {
    const v = row.fixed_in_version ? `v${esc(row.fixed_in_version)}` : "";
    const b = row.fixed_in_build ? ` (build ${esc(row.fixed_in_build)})` : "";
    lines.push("");
    lines.push(`This fix is in ${v}${b}.`.trim());
  }
  lines.push("");
  lines.push("Thanks for helping us improve.");
  return lines.join("\n");
}

// Confirmation DM sent immediately after submission.
export function renderSubmissionConfirmation(row: BugRow): string {
  const id = publicIdOf(row);
  return [
    `✅ <b>Bug Report Submitted</b>`,
    `<b>${esc(id)}</b>`,
    esc(row.title),
    ``,
    `Your report has been received.`,
    `You'll receive updates here when its status changes.`,
  ].join("\n");
}
