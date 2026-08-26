// Bot API 10.3 Rich Message builders for Vox Bugs.
//
// Everything here maps to concrete objects documented at
//   https://core.telegram.org/bots/api  (10.1 foundation, 10.2 media,
//   10.3 RichBlockButtons + DisabledButton + button styles).
//
// A `RichText` field per Telegram spec may be a plain String, an Array of
// RichText, or a typed RichText object. We use plain strings almost
// everywhere for readability.

import type { BugRow } from "../db/types";
import {
  statusMeta, severityMeta, categoryMeta, frequencyMeta,
  STATUSES, SEVERITIES, CATEGORIES,
} from "../bugs/constants";
import { publicIdOf, formatTimestamp } from "../bugs/formatting";

// ── Buttons ────────────────────────────────────────────────
// RichMessageButton style values, per the Bot API 10.3 reference.
export type ButtonStyle = "primary" | "success" | "danger" | "link";

export interface RichMessageButton {
  text: string;                 // RichText accepts a plain string
  style?: ButtonStyle;
  callback_data?: string;
  url?: string;
  disabled?: Record<string, never>; // DisabledButton is `{}`
}

// A single row of 1-8 buttons, per InputRichBlockButtons spec.
export function buttonsRow(buttons: RichMessageButton[], align?: "left" | "center" | "right") {
  return { type: "buttons", buttons, ...(align ? { align } : {}) };
}

// Convenience for a disabled button (currently-selected marker, no-op).
// Per RichMessageButton spec: "Exactly one of the fields other than text
// and style must be used to specify the type of the button." Both
// `callback_data` and `disabled` count as type fields, so setting BOTH
// silently breaks callback wiring for the entire message. A disabled button
// therefore carries `disabled` ONLY.
export function disabledButton(text: string, style?: ButtonStyle): RichMessageButton {
  const btn: RichMessageButton = { text, disabled: {} };
  if (style) btn.style = style;
  return btn;
}

// ── Block builders ────────────────────────────────────────
const heading = (text: string, size = 3) => ({ type: "heading", text, size });
const paragraph = (text: string) => ({ type: "paragraph", text });
const divider = () => ({ type: "divider" });

function orderedList(items: string[]) {
  return {
    type: "list",
    items: items.map((t) => ({ blocks: [paragraph(t)] })),
  };
}

// A compact key-value table. `[["Label","Value"], …]`.
function kvTable(rows: [string, string][], caption?: string) {
  return {
    type: "table",
    is_compact: true,
    is_bordered: false,
    is_striped: true,
    ...(caption ? { caption } : {}),
    cells: rows.map(([k, v]) => [
      { text: k, is_header: true, align: "left" },
      { text: v, align: "left" },
    ]),
  };
}

// ── Public: bug report Rich Message ───────────────────────
// Builds a complete InputRichMessage body for the given bug, INCLUDING
// the management button bar. State (Status/Severity/Category) is rendered
// live so editMessageText(rich_message) updates it in place.
//
// Attachments are NOT embedded here — they continue to post as their own
// messages in the thread so the existing attachment flow is untouched, per
// the "do not break working attachment delivery" instruction.
export function buildBugReportRichMessage(bug: BugRow): { blocks: unknown[] } {
  const st = statusMeta(bug.status);
  const sev = severityMeta(bug.severity);
  const cat = categoryMeta(bug.category);
  const blocks: unknown[] = [];

  blocks.push(heading(`REPORT — ${publicIdOf(bug)}`, 2));
  blocks.push(paragraph(bug.title));

  // Live state table — updated in place on every management action.
  blocks.push(
    kvTable([
      ["Status",   `${st.emoji} ${st.label}`],
      ["Severity", sev.label],
      ["Category", cat.label],
    ]),
  );

  blocks.push(divider());

  if (bug.actual_behavior) {
    blocks.push(heading("What Happened", 4));
    blocks.push(paragraph(bug.actual_behavior));
  }
  if (bug.expected_behavior) {
    blocks.push(heading("Expected Behavior", 4));
    blocks.push(paragraph(bug.expected_behavior));
  }

  const steps = extractSteps(bug.reproduction_steps);
  if (steps.length) {
    blocks.push(heading("Steps to Reproduce", 4));
    blocks.push(orderedList(steps));
  }

  if (bug.frequency) {
    const f = frequencyMeta(bug.frequency);
    blocks.push(paragraph(`Frequency: ${f?.label ?? bug.frequency}`));
  }

  // Environment table — compact, per API 10.3 is_compact.
  const envRows: [string, string][] = [];
  const kv = (k: string, v: string | null | undefined) => { if (v && v.trim()) envRows.push([k, v]); };
  kv("App", bug.app);
  kv("Version", bug.app_version);
  kv("Build", bug.app_build);
  kv("Device", bug.device);
  kv("OS", bug.os);
  if (envRows.length) {
    blocks.push(heading("Environment", 4));
    blocks.push(kvTable(envRows));
  }

  if (bug.notes) {
    blocks.push(heading("Additional Notes", 4));
    blocks.push(paragraph(bug.notes));
  }

  const reporter = bug.reporter_username
    ? `@${bug.reporter_username}`
    : bug.reporter_display_name || "anonymous";
  blocks.push(heading("Reporter", 4));
  blocks.push(paragraph(`${reporter} · submitted ${formatTimestamp(bug.created_at)}`));

  if (bug.github_issue_url && bug.github_issue_number) {
    blocks.push(divider());
    blocks.push(
      paragraph(`GitHub Issue: #${bug.github_issue_number} — ${bug.github_issue_url}`),
    );
  }

  blocks.push(divider());

  // Management buttons — the whole point of Rich Message controls.
  // Rows are stacked; each row is a RichBlockButtons block.
  for (const row of managementButtonBlocks(bug)) blocks.push(row);

  return { blocks };
}

// Split reproduction_steps into an array. Accepts "1. …\n2. …" or free lines.
function extractSteps(input: string | null): string[] {
  if (!input) return [];
  const raw = input.replace(/\r/g, "").trim();
  if (!raw) return [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const numbered = lines.every((l) => /^\d+[.)]/.test(l));
  if (numbered) return lines.map((l) => l.replace(/^\d+[.)]\s*/, ""));
  if (lines.length > 1) return lines;
  return [raw];
}

// ── Management button bar ─────────────────────────────────
// One RichBlockButtons per visual row. Uses 10.3 style + disabled fields.
export function managementButtonBlocks(bug: BugRow): unknown[] {
  const id = bug.id;
  const isFixed  = bug.status === "fixed";
  const isClosed = bug.status === "closed";
  const isCantRepro = bug.status === "cannot_reproduce";
  const cb = (verb: string, extra = "") => `rich:${verb}:${id}${extra ? `:${extra}` : ""}`;

  return [
    buttonsRow([
      { text: "Status",   style: "primary", callback_data: cb("menu", "status") },
      { text: "Severity", style: "primary", callback_data: cb("menu", "severity") },
      { text: "Category", style: "primary", callback_data: cb("menu", "category") },
    ]),
    buttonsRow([
      isFixed
        ? disabledButton("✓ Fixed", "success")
        : { text: "Mark Fixed", style: "success", callback_data: cb("act", "status:fixed") },
      isClosed
        ? disabledButton("✓ Closed", "danger")
        : { text: "Close", style: "danger", callback_data: cb("act", "status:closed") },
    ]),
    buttonsRow([
      !isClosed && !isFixed
        ? disabledButton("Reopen")
        : { text: "Reopen", style: "primary", callback_data: cb("act", "status:investigating") },
      isCantRepro
        ? disabledButton("✓ Cannot Reproduce")
        : { text: "Cannot Reproduce", callback_data: cb("act", "status:cannot_reproduce") },
    ]),
    buttonsRow([
      { text: "Add Note", callback_data: cb("menu", "note") },
    ]),
  ];
}

// ── Ephemeral pickers ─────────────────────────────────────
// Each opens as an ephemeral message that REPLACES the report while the
// admin picks, then is deleted after the action lands.

export function buildStatusPickerRichMessage(bug: BugRow): { blocks: unknown[] } {
  const blocks: unknown[] = [heading(`Change Status — ${publicIdOf(bug)}`, 3)];
  const current = bug.status;
  blocks.push(paragraph(`Current: ${statusMeta(current).emoji} ${statusMeta(current).label}`));
  const rows: unknown[] = [];
  let row: RichMessageButton[] = [];
  for (const s of STATUSES) {
    const btn: RichMessageButton = s.id === current
      ? disabledButton(`✓ ${s.emoji} ${s.label}`)
      : { text: `${s.emoji} ${s.label}`, callback_data: `rich:act:${bug.id}:status:${s.id}` };
    row.push(btn);
    if (row.length === 2) { rows.push(buttonsRow(row)); row = []; }
  }
  if (row.length) rows.push(buttonsRow(row));
  rows.push(buttonsRow([{ text: "‹ Back", callback_data: `rich:back:${bug.id}` }]));
  return { blocks: [...blocks, ...rows] };
}

export function buildSeverityPickerRichMessage(bug: BugRow): { blocks: unknown[] } {
  const blocks: unknown[] = [
    heading(`Change Severity — ${publicIdOf(bug)}`, 3),
    paragraph(`Current: ${severityMeta(bug.severity).label}`),
  ];
  const rows: unknown[] = [];
  for (const s of SEVERITIES) {
    rows.push(buttonsRow([
      s.id === bug.severity
        ? disabledButton(`✓ ${s.label}`)
        : { text: s.label, callback_data: `rich:act:${bug.id}:severity:${s.id}` },
    ]));
  }
  rows.push(buttonsRow([{ text: "‹ Back", callback_data: `rich:back:${bug.id}` }]));
  return { blocks: [...blocks, ...rows] };
}

export function buildCategoryPickerRichMessage(bug: BugRow): { blocks: unknown[] } {
  const blocks: unknown[] = [
    heading(`Change Category — ${publicIdOf(bug)}`, 3),
    paragraph(`Current: ${categoryMeta(bug.category).label}`),
  ];
  const rows: unknown[] = [];
  let row: RichMessageButton[] = [];
  for (const c of CATEGORIES) {
    const btn: RichMessageButton = c.id === bug.category
      ? disabledButton(`✓ ${c.label}`)
      : { text: c.label, callback_data: `rich:act:${bug.id}:category:${c.id}` };
    row.push(btn);
    if (row.length === 2) { rows.push(buttonsRow(row)); row = []; }
  }
  if (row.length) rows.push(buttonsRow(row));
  rows.push(buttonsRow([{ text: "‹ Back", callback_data: `rich:back:${bug.id}` }]));
  return { blocks: [...blocks, ...rows] };
}

// ── Feature Idea Rich Message ─────────────────────────
// Deliberately DIFFERENT layout from bug reports so ideas and bugs are
// visually distinct in the same discussion group.
import type { IdeaRow } from "../db/types";
import { IDEA_STATUSES, ideaStatusMeta } from "../ideas/constants";
import { ideaPublicId } from "../ideas/formatting";

export function buildIdeaReportRichMessage(idea: IdeaRow): { blocks: unknown[] } {
  const blocks: unknown[] = [];
  const st = ideaStatusMeta(idea.status);

  blocks.push(heading(`💡 IDEA — ${ideaPublicId(idea)}`, 2));
  blocks.push(paragraph(idea.title));

  blocks.push(kvTable([
    ["App",    idea.app],
    ["Status", `${st.emoji} ${st.label}`],
  ]));

  blocks.push(divider());

  const sec = (h: string, v: string | null | undefined) => {
    if (!v || !v.trim()) return;
    blocks.push(heading(h, 4));
    blocks.push(paragraph(v));
  };
  sec("What I Want", idea.what_i_want);
  sec("Why It Would Be Useful", idea.why_useful);
  sec("How It Should Work", idea.how_it_works);
  sec("Where It Belongs", idea.where_it_belongs);
  sec("Extra Notes", idea.notes);

  if (idea.decision_reason && (idea.status === "accepted" || idea.status === "rejected")) {
    blocks.push(heading(idea.status === "accepted" ? "Accepted — Reason" : "Rejected — Reason", 4));
    blocks.push(paragraph(idea.decision_reason));
  }

  const reporter = idea.reporter_username
    ? `@${idea.reporter_username}`
    : idea.reporter_display_name || "anonymous";
  blocks.push(heading("Reporter", 4));
  blocks.push(paragraph(`${reporter} · submitted ${formatIdeaTs(idea.created_at)}`));

  if (idea.github_comment_url) {
    blocks.push(divider());
    blocks.push(paragraph(`GitHub Discussion comment: ${idea.github_comment_url}`));
  }

  blocks.push(divider());
  for (const row of ideaManagementButtonBlocks(idea)) blocks.push(row);
  return { blocks };
}

function formatIdeaTs(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  }) + " UTC";
}

// Idea-specific button bar. Distinct from Bug controls: no severity/category.
// Accept + Reject prompt for a reason via /reason command in the thread.
export function ideaManagementButtonBlocks(idea: IdeaRow): unknown[] {
  const id = idea.id;
  const cb = (verb: string, extra = "") => `idea:${verb}:${id}${extra ? `:${extra}` : ""}`;
  const isAccepted = idea.status === "accepted";
  const isRejected = idea.status === "rejected";
  const isInProgress = idea.status === "in_progress";
  const isTesting  = idea.status === "in_testing";
  const isShipped  = idea.status === "shipped";
  const decided = isAccepted || isRejected || isInProgress || isTesting || isShipped;

  const rows: unknown[] = [];

  // View on GitHub (link button — no callback).
  if (idea.github_comment_url) {
    rows.push(buttonsRow([
      { text: "🔗 View on GitHub", style: "link", url: idea.github_comment_url },
    ]));
  }

  // Decision row.
  rows.push(buttonsRow([
    isAccepted
      ? disabledButton("✓ Accepted", "success")
      : { text: "✅ Accept", style: "success", callback_data: cb("act", "status:accepted") },
    isRejected
      ? disabledButton("✓ Rejected", "danger")
      : { text: "❌ Reject", style: "danger", callback_data: cb("act", "status:rejected") },
  ]));

  // Implementation stages appear only once the idea has been accepted.
  if (decided && !isRejected) {
    rows.push(buttonsRow([
      isInProgress
        ? disabledButton("✓ In Progress")
        : { text: "🔵 In Progress", style: "primary", callback_data: cb("act", "status:in_progress") },
      isTesting
        ? disabledButton("✓ In Testing")
        : { text: "🟣 In Testing", style: "primary", callback_data: cb("act", "status:in_testing") },
    ]));
    rows.push(buttonsRow([
      isShipped
        ? disabledButton("✓ Shipped", "success")
        : { text: "🚢 Mark Shipped", style: "success", callback_data: cb("act", "status:shipped") },
    ]));
  }

  return rows;
}

// Prompt used when the admin taps "Add Note". Shown as an ephemeral message
// telling them to reply to the report with /note <text>.
export function buildNotePromptRichMessage(bug: BugRow): { blocks: unknown[] } {
  return {
    blocks: [
      heading(`Add Note — ${publicIdOf(bug)}`, 3),
      paragraph(
        `Reply to the report in this thread with:  /note <your note text>\n\nThe note will be posted to the discussion AND commented on GitHub Issue #${bug.github_issue_number ?? "—"}.`,
      ),
      buttonsRow([{ text: "Dismiss", callback_data: `rich:back:${bug.id}` }]),
    ],
  };
}
