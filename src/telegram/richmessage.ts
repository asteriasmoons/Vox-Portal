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
export function disabledButton(text: string, style?: ButtonStyle): RichMessageButton {
  return { text, style, callback_data: "noop", disabled: {} };
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
