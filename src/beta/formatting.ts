// Formatting helpers for Beta Feedback channel tickets, Rich Message detail,
// and reporter DMs. Mirrors Bugs/Ideas edge formatting.

import type { BetaFeedbackRow } from "../db/types";
import { esc, trunc } from "../util/html";
import {
  betaFeedbackTypeMeta,
  betaOverallExperienceMeta,
  betaStatusMeta,
  betaWouldUseMeta,
} from "./constants";

export function betaFeedbackPublicId(row: Pick<BetaFeedbackRow, "public_number">): string {
  return `BETA-${String(row.public_number).padStart(4, "0")}`;
}

export function formatTimestamp(unixSec: number): string {
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

export function betaFeedbackTypeLabels(row: Pick<BetaFeedbackRow, "feedback_types">): string[] {
  return parseFeedbackTypes(row.feedback_types)
    .map((id) => betaFeedbackTypeMeta(id)?.label ?? id)
    .filter(Boolean);
}

export function renderBetaFeedbackChannelTicket(row: BetaFeedbackRow): string {
  const st = betaStatusMeta(row.status);
  const reporter = row.reporter_username
    ? `@${esc(row.reporter_username)}`
    : esc(row.reporter_display_name ?? "anonymous");
  const preview = trunc(row.what_happened.replace(/\s+/g, " ").trim(), 200);
  const lines: string[] = [];
  lines.push(`🧪 <b>BETA FEEDBACK — ${esc(betaFeedbackPublicId(row))}</b>`);
  lines.push(`<b>${esc(trunc(row.testing, 140))}</b>`);
  lines.push("");
  lines.push(`App: <b>${esc(row.app)}</b>`);
  if (row.app_version) lines.push(`Version: ${esc(row.app_version)}`);
  if (row.app_build) lines.push(`Build: ${esc(row.app_build)}`);
  lines.push(`Status: ${st.emoji} <b>${esc(st.label)}</b>`);
  lines.push(`Overall: ${esc(betaOverallExperienceMeta(row.overall_experience).label)}`);
  lines.push(`Would use: ${esc(betaWouldUseMeta(row.would_use_feature).label)}`);
  const types = betaFeedbackTypeLabels(row);
  if (types.length) lines.push(`Types: ${esc(types.join(", "))}`);
  lines.push(`Reporter: ${reporter}`);
  lines.push(`Submitted: ${esc(formatTimestamp(row.created_at))}`);
  if (preview) {
    lines.push("");
    lines.push(`<i>${esc(preview)}</i>`);
  }
  return lines.join("\n");
}

export function renderBetaFeedbackReporterDm(row: BetaFeedbackRow, fromStatus: string | null): string {
  const st = betaStatusMeta(row.status);
  const lines: string[] = [];
  lines.push(`🧪 <b>${esc(betaFeedbackPublicId(row))} Update</b>`);
  lines.push(esc(row.testing));
  lines.push("");
  if (fromStatus) {
    const from = betaStatusMeta(fromStatus);
    lines.push(`Status changed: ${from.label} → <b>${esc(st.label)}</b> ${st.emoji}`);
  } else {
    lines.push(`Status: <b>${esc(st.label)}</b> ${st.emoji}`);
  }
  lines.push("");
  lines.push("Thanks for testing the beta.");
  return lines.join("\n");
}

export function renderBetaFeedbackSubmissionConfirmation(row: BetaFeedbackRow): string {
  return [
    `✅ <b>Beta Feedback Submitted</b>`,
    `<b>${esc(betaFeedbackPublicId(row))}</b>`,
    esc(row.testing),
    ``,
    `Your feedback was received.`,
    `You'll get updates here when it's reviewed.`,
  ].join("\n");
}

function parseFeedbackTypes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch { /* fall through */ }
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}
