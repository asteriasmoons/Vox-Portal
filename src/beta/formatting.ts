// Formatting helpers for Beta Feedback channel tickets, GitHub Discussion
// comments, Rich Message detail, and reporter DMs. Mirrors Bugs/Ideas edge
// formatting.

import type { BetaFeedbackRow } from "../db/types";
import { esc, trunc } from "../util/html";
import {
  betaFeedbackTypeMeta,
  betaOverallExperienceMeta,
  betaStatusMeta,
  betaWouldUseMeta,
} from "./constants";

export interface BetaFeedbackAttachmentReference {
  id: number;
  kind: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url?: string | null;
}

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
  if (row.last_edited_at) lines.push(`Edited: ${esc(formatTimestamp(row.last_edited_at))}`);
  if (preview) {
    lines.push("");
    lines.push(`<i>${esc(preview)}</i>`);
  }
  return lines.join("\n");
}

export function renderBetaFeedbackGitHubComment(
  row: BetaFeedbackRow,
  attachments: BetaFeedbackAttachmentReference[] = [],
): string {
  const parts: string[] = [];
  const types = betaFeedbackTypeLabels(row);
  const st = betaStatusMeta(row.status);
  parts.push(`## Beta Feedback - ${betaFeedbackPublicId(row)}`);
  parts.push(row.testing.trim());
  parts.push("---");
  parts.push([
    "| Detail | Value |",
    "| --- | --- |",
    tableRow("App", row.app),
    tableRow("Version", row.app_version || "Not provided"),
    tableRow("Build", row.app_build || "Not provided"),
    tableRow("Status", st.label),
    tableRow("Feedback Type", types.length ? types.join(", ") : "Not provided"),
    tableRow("Overall Experience", betaOverallExperienceMeta(row.overall_experience).label),
    tableRow("Would Use This Feature", betaWouldUseMeta(row.would_use_feature).label),
  ].join("\n"));

  const sec = (h: string, v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (!t) return;
    parts.push("---");
    parts.push(`### ${h}`);
    parts.push(t);
  };
  sec("What Were You Testing?", row.testing);
  sec("What Did You Do?", row.what_did_you_do);
  sec("What Happened?", row.what_happened);
  sec("What Did You Expect?", row.expected_behavior);
  sec("Anything You'd Change?", row.changes);
  sec("Additional Notes", row.notes);

  if (attachments.length) {
    parts.push("---");
    parts.push("### Reference");
    parts.push(renderGitHubReferences(attachments));
  }

  parts.push(`---`);
  if (row.last_edited_at) {
    parts.push(`_Edited ${formatTimestamp(row.last_edited_at)}_`);
  }
  parts.push(`_Submitted through the Voxiverse Telegram Mini App — ${betaFeedbackPublicId(row)}_`);
  return parts.join("\n\n");
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

function tableRow(label: string, value: string): string {
  return `| ${markdownTableCell(label)} | ${markdownTableCell(value)} |`;
}

function markdownTableCell(value: string): string {
  return value
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function renderGitHubReferences(attachments: BetaFeedbackAttachmentReference[]): string {
  const images = attachments.filter((a) => a.url && (a.mime_type ?? "").toLowerCase().startsWith("image/"));
  const nonImages = attachments.filter((a) => !a.url || !(a.mime_type ?? "").toLowerCase().startsWith("image/"));
  const chunks: string[] = [];
  if (images.length) {
    chunks.push(renderImageTable(images));
  }
  if (nonImages.length) {
    chunks.push(nonImages.map((a) => {
      const name = a.file_name || `${a.kind}-${a.id}`;
      return a.url ? `- [${escapeMarkdownLinkText(name)}](${a.url})` : `- ${escapeMarkdownLinkText(name)}`;
    }).join("\n"));
  }
  return chunks.join("\n\n");
}

function renderImageTable(images: BetaFeedbackAttachmentReference[]): string {
  const rows: string[] = ["<table>"];
  for (let i = 0; i < images.length; i += 2) {
    const first = images[i];
    const second = images[i + 1];
    rows.push("  <tr>");
    rows.push(`    <td>${renderImageCell(first)}</td>`);
    rows.push(`    <td>${second ? renderImageCell(second) : ""}</td>`);
    rows.push("  </tr>");
  }
  rows.push("</table>");
  return rows.join("\n");
}

function renderImageCell(att: BetaFeedbackAttachmentReference): string {
  const name = escapeHtmlAttr(att.file_name || `${att.kind}-${att.id}`);
  const url = escapeHtmlAttr(att.url ?? "");
  return `<a href="${url}"><img src="${url}" width="220" alt="${name}"></a>`;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
