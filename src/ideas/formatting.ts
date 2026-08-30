// Formatting helpers for Feature Ideas: channel ticket (Telegram HTML),
// GitHub Discussion comment (Markdown), and reporter DM text.

import type { IdeaRow, IdeaAttachmentRow } from "../db/types";
import { esc, trunc } from "../util/html";
import { ideaStatusMeta } from "./constants";

export function ideaPublicId(row: Pick<IdeaRow, "public_number">): string {
  return `IDEA-${String(row.public_number).padStart(4, "0")}`;
}

export function formatTimestamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  }) + " UTC";
}

// Concise channel post — a scannable preview, not the full submission.
export function renderIdeaChannelTicket(row: IdeaRow): string {
  const st = ideaStatusMeta(row.status);
  const reporter = row.reporter_username
    ? `@${esc(row.reporter_username)}`
    : esc(row.reporter_display_name ?? "anonymous");
  const preview = trunc((row.what_i_want ?? "").replace(/\s+/g, " ").trim(), 200);
  return [
    `💡 <b>NEW FEATURE IDEA — ${esc(ideaPublicId(row))}</b>`,
    `<b>${esc(trunc(row.title, 140))}</b>`,
    ``,
    `App: <b>${esc(row.app)}</b>`,
    `Status: ${st.emoji} <b>${esc(st.label)}</b>`,
    `Reporter: ${reporter}`,
    `Submitted: ${esc(formatTimestamp(row.created_at))}`,
    preview ? `` : null,
    preview ? `<i>${esc(preview)}</i>` : null,
  ].filter((x): x is string => x != null).join("\n");
}

// Markdown for the GitHub Discussion comment.
export function renderIdeaGitHubComment(row: IdeaRow, attachmentNotes: string[] = []): string {
  const parts: string[] = [];
  parts.push(`## ${row.title}`);

  const sec = (h: string, v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (!t) return;
    parts.push(`---`);
    parts.push(`### ${h}\n\n${t}`);
  };
  sec("My Vision", row.what_i_want);
  sec("Why It Would Be Useful", row.why_useful);
  sec("How It Works", row.how_it_works);
  sec("Space Placement", row.where_it_belongs);
  sec("Extra Notes", row.notes);

  if (attachmentNotes.length) {
    parts.push(`---`);
    parts.push(`### Reference\n\n${attachmentNotes.map((a) => `- ${a}`).join("\n")}`);
  }

  parts.push(`---`);
  parts.push(`_Submitted through the Voxiverse Telegram Mini App — ${ideaPublicId(row)}_`);
  return parts.join("\n\n");
}

// DM for the reporter on notify-worthy status changes.
export function renderIdeaReporterDm(row: IdeaRow, fromStatus: string | null): string {
  const st = ideaStatusMeta(row.status);
  const id = ideaPublicId(row);
  const lines: string[] = [];
  lines.push(`💡 <b>${esc(id)} Update</b>`);
  lines.push(esc(row.title));
  lines.push("");
  if (fromStatus) {
    const from = ideaStatusMeta(fromStatus);
    lines.push(`Status changed: ${from.label} → <b>${esc(st.label)}</b> ${st.emoji}`);
  } else {
    lines.push(`Status: <b>${esc(st.label)}</b> ${st.emoji}`);
  }
  if (row.decision_reason && (row.status === "accepted" || row.status === "rejected")) {
    lines.push("");
    lines.push(`<i>${esc(row.decision_reason)}</i>`);
  }
  lines.push("");
  lines.push("Thanks for the idea.");
  return lines.join("\n");
}

export function renderIdeaSubmissionConfirmation(row: IdeaRow): string {
  return [
    `✅ <b>Idea Submitted</b>`,
    `<b>${esc(ideaPublicId(row))}</b>`,
    esc(row.title),
    ``,
    `Your idea was received.`,
    `You'll get updates here when it's accepted, rejected, or shipped.`,
  ].join("\n");
}

// Nothing here uses IdeaAttachmentRow directly; kept for API parity/future use.
export type { IdeaAttachmentRow };
