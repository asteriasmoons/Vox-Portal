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
import { bugAffectedAreaLabels, bugOptionLabel } from "../bugs/app-metadata";

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
type RichText = string | { type: string; text?: RichText; [key: string]: unknown } | RichText[];
type WithInternalWorkId = { work_id?: string | null };

const heading = (text: string, size = 3) => ({ type: "heading", text, size });
const paragraph = (text: RichText) => ({ type: "paragraph", text });
const divider = () => ({ type: "divider" });

function internalWorkIdQuote(row: WithInternalWorkId): unknown | null {
  const workId = row.work_id?.trim();
  if (!workId) return null;
  return {
    type: "blockquote",
    blocks: [
      paragraph({ type: "spoiler", text: `Work ID: ${workId}` }),
    ],
  };
}

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

function solidHeaderKvTable(rows: [string, string][], caption?: string) {
  return {
    type: "table",
    is_compact: true,
    is_bordered: false,
    is_striped: false,
    ...(caption ? { caption } : {}),
    cells: rows.map(([k, v]) => [
      { text: k, is_header: true, align: "left" },
      { text: v, is_header: true, align: "left" },
    ]),
  };
}

function blueTable(rows: string[][], caption?: string) {
  return {
    type: "table",
    is_compact: true,
    is_bordered: false,
    is_striped: false,
    ...(caption ? { caption } : {}),
    cells: rows.map((row) => row.map((text) => ({
      text,
      is_header: true,
      align: "left",
    }))),
  };
}

function blueKvTable(rows: [string, string][], caption?: string) {
  return blueTable(rows.map(([k, v]) => [k, v]), caption);
}

// ── Public: bug report Rich Message ───────────────────────
// Builds a complete InputRichMessage body for the given bug, INCLUDING
// the management button bar. State (Status/Severity/Category) is rendered
// live so editMessageText(rich_message) updates it in place.
//
// Attachments are NOT embedded here — they continue to post as their own
// messages in the thread so the existing attachment flow is untouched, per
// the "do not break working attachment delivery" instruction.
export function buildBugReportRichMessage(bug: BugRow & WithInternalWorkId): { blocks: unknown[] } {
  const st = statusMeta(bug.status);
  const sev = severityMeta(bug.severity);
  const bugType = categoryMeta(bug.bug_type ?? bug.category);
  const feature = bugOptionLabel(bug.app, "feature", bug.feature);
  const affectedAreas = bugAffectedAreaLabels(bug.app, bug.affected_areas);
  const steps = extractSteps(bug.reproduction_steps);
  const blocks: unknown[] = [];

  blocks.push(heading(`BUG REPORT — ${publicIdOf(bug)}`, 2));
  const workIdBlock = internalWorkIdQuote(bug);
  if (workIdBlock) blocks.push(workIdBlock);
  blocks.push(paragraph(bug.title));
  blocks.push(divider());

  // Device Details table.
  const deviceRows: [string, string][] = [];
  const kv = (rows: [string, string][], k: string, v: string | null | undefined) => {
    if (v && v.trim()) rows.push([k, v]);
  };
  kv(deviceRows, "App", bug.app);
  kv(deviceRows, "Version", bug.app_version);
  kv(deviceRows, "Build", bug.app_build);
  kv(deviceRows, "Device", bug.device);
  kv(deviceRows, "OS", bug.os);
  if (deviceRows.length) {
    blocks.push(heading("Device Details", 4));
    blocks.push(blueKvTable(deviceRows));
    blocks.push(divider());
  }

  // Context Details table — live state rows update in place on every
  // management action.
  blocks.push(heading("Context Details", 4));
  blocks.push(
    blueKvTable([
      ["Status", `${st.emoji} ${st.label}`],
      ["Bug Type", bugType.label],
      ["Severity", sev.label],
      ["Reproducibility", bug.frequency ? frequencyMeta(bug.frequency)?.label ?? bug.frequency : "Not specified"],
      ["Feature", feature || "Not provided"],
      ["Affected Areas", affectedAreas.length ? affectedAreas.join(", ") : "None selected"],
    ]),
  );
  blocks.push(divider());

  if (steps.length) {
    blocks.push(heading("Steps to Reproduce", 4));
    blocks.push(blueTable([
      ["Step", "Action"],
      ...steps.map((step, index) => [String(index + 1), step]),
    ]));
    blocks.push(divider());
  }

  blocks.push(heading("Behavior Details", 4));
  blocks.push(blueKvTable([
    ["Expected", bug.expected_behavior || "Not provided"],
    ["Actual", bug.actual_behavior],
  ]));
  blocks.push(divider());

  if (bug.notes) {
    blocks.push(heading("Additional Notes", 4));
    blocks.push(paragraph(bug.notes));
    blocks.push(divider());
  }

  blocks.push(heading("Screenshots & Recordings", 4));
  blocks.push(paragraph("Attached files are posted as replies in this same comment thread."));
  blocks.push(divider());

  const reporter = bug.reporter_username
    ? `@${bug.reporter_username}`
    : bug.reporter_display_name || "anonymous";
  blocks.push(heading("Reporter", 4));
  blocks.push(paragraph(`${reporter} · submitted ${formatTimestamp(bug.created_at)}`));

  const gitHubNumber = bug.github_sub_issue_number ?? bug.github_issue_number;
  const gitHubUrl = bug.github_sub_issue_url ?? bug.github_issue_url;
  if (gitHubUrl && gitHubNumber) {
    blocks.push(divider());
    blocks.push(
      paragraph(`GitHub Issue: #${gitHubNumber} — ${gitHubUrl}`),
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
      { text: "Bug Type", style: "primary", callback_data: cb("menu", "category") },
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
import { IDEA_STATUSES, ideaTypeLabel } from "../ideas/constants";
import { ideaList, ideaPublicId, ideaWhereLabel } from "../ideas/formatting";

export function buildIdeaReportRichMessage(idea: IdeaRow & WithInternalWorkId): { blocks: unknown[] } {
  const blocks: unknown[] = [];

  // Plain text in headings — see comment on decision-row buttons above.
  blocks.push(heading(`IDEA — ${ideaPublicId(idea)}`, 2));
  const workIdBlock = internalWorkIdQuote(idea);
  if (workIdBlock) blocks.push(workIdBlock);
  blocks.push(paragraph(idea.title));

  blocks.push(heading("Idea Details", 4));
  blocks.push(blueKvTable([
    ["App", idea.app],
    ["Idea Type", ideaTypeLabel(idea.idea_type)],
    ["Where It Belongs", ideaWhereLabel(idea)],
  ]));

  blocks.push(divider());

  const sec = (h: string, v: string | null | undefined) => {
    if (!v || !v.trim()) return;
    blocks.push(heading(h, 4));
    blocks.push(paragraph(v));
    blocks.push(divider());
  };
  sec("My Vision", idea.what_i_want);
  sec("Why It Would Be Useful", idea.why_useful);
  const flow = ideaList(idea.user_flow, idea.how_it_works);
  if (flow.length) {
    blocks.push(heading("User Flow", 4));
    blocks.push(blueTable([
      ["Step", "Action"],
      ...flow.map((step, index) => [String(index + 1), step]),
    ]));
    blocks.push(divider());
  }
  const features = ideaList(idea.key_features);
  if (features.length) {
    blocks.push(heading("Key Features", 4));
    blocks.push(orderedList(features));
    blocks.push(divider());
  }
  sec("Expected Experience", idea.expected_experience);
  sec("Anything to Avoid?", idea.anything_to_avoid);
  sec("Extra Notes", idea.notes);

  if (idea.decision_reason && (idea.status === "accepted" || idea.status === "rejected")) {
    blocks.push(heading(idea.status === "accepted" ? "Accepted — Reason" : "Rejected — Reason", 4));
    blocks.push(paragraph(idea.decision_reason));
    blocks.push(divider());
  }

  const reporter = idea.reporter_username
    ? `@${idea.reporter_username}`
    : idea.reporter_display_name || "anonymous";
  blocks.push(heading("Reporter", 4));
  blocks.push(paragraph(`${reporter} · submitted ${formatIdeaTs(idea.created_at)}`));

  if (idea.github_comment_url) {
    blocks.push(divider());
    blocks.push(heading("GitHub Discussion", 4));
    blocks.push(paragraph(idea.github_comment_url));
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
      { text: "View on GitHub", style: "link", url: idea.github_comment_url },
    ]));
  }

  // Decision row. No emojis in button text — Bot API 10.3 button `text` is
  // RichText and only accepts plain text + RichTextCustomEmoji + DateTime
  // entities, so raw unicode emoji occasionally trip Telegram's validator.
  rows.push(buttonsRow([
    isAccepted
      ? disabledButton("Accepted", "success")
      : { text: "Accept", style: "success", callback_data: cb("act", "status:accepted") },
    isRejected
      ? disabledButton("Rejected", "danger")
      : { text: "Reject", style: "danger", callback_data: cb("act", "status:rejected") },
  ]));

  // Implementation stages appear only once the idea has been accepted.
  if (decided && !isRejected) {
    rows.push(buttonsRow([
      isInProgress
        ? disabledButton("In Progress")
        : { text: "In Progress", style: "primary", callback_data: cb("act", "status:in_progress") },
      isTesting
        ? disabledButton("In Testing")
        : { text: "In Testing", style: "primary", callback_data: cb("act", "status:in_testing") },
    ]));
    rows.push(buttonsRow([
      isShipped
        ? disabledButton("Shipped", "success")
        : { text: "Mark Shipped", style: "success", callback_data: cb("act", "status:shipped") },
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
        `Reply to the report in this thread with:  /note <your note text>\n\nThe note will be posted to the discussion AND commented on GitHub Issue #${bug.github_sub_issue_number ?? bug.github_issue_number ?? "—"}.`,
      ),
      buttonsRow([{ text: "Dismiss", callback_data: `rich:back:${bug.id}` }]),
    ],
  };
}

// ── Beta Feedback Rich Message ────────────────────────
import type { BetaFeedbackRow } from "../db/types";
import {
  BETA_STATUSES,
  betaOverallExperienceMeta,
  betaStatusMeta,
  betaWouldUseMeta,
} from "../beta/constants";
import { betaFeedbackPublicId, betaFeedbackTypeLabels, formatTimestamp as formatBetaTs } from "../beta/formatting";

export function buildBetaFeedbackRichMessage(row: BetaFeedbackRow & WithInternalWorkId): { blocks: unknown[] } {
  const blocks: unknown[] = [];
  const st = betaStatusMeta(row.status);
  const feedbackTypes = betaFeedbackTypeLabels(row);

  blocks.push(heading(`BETA FEEDBACK — ${betaFeedbackPublicId(row)}`, 2));
  const workIdBlock = internalWorkIdQuote(row);
  if (workIdBlock) blocks.push(workIdBlock);
  blocks.push(paragraph(row.testing));
  blocks.push(divider());

  blocks.push(solidHeaderKvTable([
    ["App", row.app],
    ["Version", row.app_version || "Not provided"],
    ["Build", row.app_build || "Not provided"],
    ["Status", `${st.emoji} ${st.label}`],
    ["Feedback Type", feedbackTypes.length ? feedbackTypes.join(", ") : "Not provided"],
    ["Overall Experience", betaOverallExperienceMeta(row.overall_experience).label],
    ["Would Use Feature", betaWouldUseMeta(row.would_use_feature).label],
  ]));

  blocks.push(divider());

  const sec = (h: string, v: string | null | undefined) => {
    if (!v || !v.trim()) return;
    blocks.push(heading(h, 4));
    blocks.push(paragraph(v));
    blocks.push(divider());
  };
  sec("What Did You Do?", row.what_did_you_do);
  sec("What Happened?", row.what_happened);
  sec("What Did You Expect?", row.expected_behavior);
  sec("Anything You'd Change?", row.changes);
  sec("Additional Notes", row.notes);

  const reporter = row.reporter_username
    ? `@${row.reporter_username}`
    : row.reporter_display_name || "anonymous";
  blocks.push(heading("Reporter", 4));
  blocks.push(paragraph(
    `${reporter} · submitted ${formatBetaTs(row.created_at)}${
      row.last_edited_at ? ` · edited ${formatBetaTs(row.last_edited_at)}` : ""
    }`,
  ));

  if (row.github_comment_url) {
    blocks.push(divider());
    blocks.push(paragraph(`GitHub Discussion comment: ${row.github_comment_url}`));
  }

  blocks.push(divider());
  for (const buttonRow of betaFeedbackManagementButtonBlocks(row)) blocks.push(buttonRow);
  return { blocks };
}

export function betaFeedbackManagementButtonBlocks(row: BetaFeedbackRow): unknown[] {
  const id = row.id;
  const rows: unknown[] = [];
  if (row.github_comment_url) {
    rows.push(buttonsRow([
      { text: "View on GitHub", style: "link", url: row.github_comment_url },
    ]));
  }
  rows.push(buttonsRow([
    { text: "Status", style: "primary", callback_data: `beta:menu:${id}:status` },
  ]));
  return rows;
}

export function buildBetaFeedbackStatusPickerRichMessage(row: BetaFeedbackRow): { blocks: unknown[] } {
  const blocks: unknown[] = [
    heading(`Change Status — ${betaFeedbackPublicId(row)}`, 3),
    paragraph(`Current: ${betaStatusMeta(row.status).emoji} ${betaStatusMeta(row.status).label}`),
  ];
  const rows: unknown[] = [];
  let buttons: RichMessageButton[] = [];
  for (const status of BETA_STATUSES) {
    buttons.push(
      status.id === row.status
        ? disabledButton(status.label)
        : { text: status.label, callback_data: `beta:act:${row.id}:status:${status.id}` },
    );
    if (buttons.length === 2) {
      rows.push(buttonsRow(buttons));
      buttons = [];
    }
  }
  if (buttons.length) rows.push(buttonsRow(buttons));
  rows.push(buttonsRow([{ text: "‹ Back", callback_data: `beta:back:${row.id}` }]));
  return { blocks: [...blocks, ...rows] };
}
