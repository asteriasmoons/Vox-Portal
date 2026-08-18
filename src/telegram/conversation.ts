// /bug conversational flow.
// State is stored in KV (binding SESSIONS) under key `sess:<tg_user_id>`.
// Each step asks one question and, where possible, offers inline choices so
// the user isn't retyping enums by hand. Free-text steps accept the next
// message from that user in a private chat.

import type { Env } from "../config";
import { sendMessage, type TelegramMessage } from "./api";
import {
  CATEGORIES,
  SEVERITIES,
  FREQUENCIES,
  type CategoryId,
  type SeverityId,
  type FrequencyId,
} from "../bugs/constants";
import { createBug, type IncomingAttachment } from "../bugs/service";
import { esc } from "../util/html";
import { log } from "../util/log";

// Ordered steps of the wizard. Adding a step? Add it here, in TYPES, and in `next`.
export type Step =
  | "app"
  | "app_version"
  | "app_build"
  | "device"
  | "os"
  | "category"
  | "severity"
  | "title"
  | "actual"
  | "expected"
  | "steps"
  | "frequency"
  | "notes"
  | "attachments"
  | "confirm";

const ORDER: Step[] = [
  "app",
  "app_version",
  "app_build",
  "device",
  "os",
  "category",
  "severity",
  "title",
  "actual",
  "expected",
  "steps",
  "frequency",
  "notes",
  "attachments",
  "confirm",
];

interface Draft {
  app?: string;
  app_version?: string;
  app_build?: string;
  device?: string;
  os?: string;
  category?: CategoryId;
  severity?: SeverityId;
  title?: string;
  actual?: string;
  expected?: string;
  steps?: string;
  frequency?: FrequencyId;
  notes?: string;
  attachments: IncomingAttachment[];
}

interface Session {
  step: Step;
  draft: Draft;
  updated_at: number;
}

const KEY = (tgId: number) => `sess:${tgId}`;
const TTL_SEC = 60 * 60 * 2; // wizard auto-expires after 2h idle
const SKIP_TOKENS = new Set(["-", "skip", "none", "n/a", "na"]);

function isSkip(text: string): boolean {
  return SKIP_TOKENS.has(text.trim().toLowerCase());
}

export async function getSession(env: Env, tgId: number): Promise<Session | null> {
  const raw = await env.SESSIONS.get(KEY(tgId));
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function saveSession(env: Env, tgId: number, s: Session): Promise<void> {
  s.updated_at = Math.floor(Date.now() / 1000);
  await env.SESSIONS.put(KEY(tgId), JSON.stringify(s), { expirationTtl: TTL_SEC });
}

export async function clearSession(env: Env, tgId: number): Promise<void> {
  await env.SESSIONS.delete(KEY(tgId));
}

// Start a fresh /bug wizard. Overwrites any existing draft.
export async function startBugWizard(env: Env, chatId: number, tgId: number) {
  const s: Session = { step: "app", draft: { attachments: [] }, updated_at: 0 };
  await saveSession(env, tgId, s);
  await promptFor(env, chatId, s.step);
}

// Cancel any in-flight wizard.
export async function cancelBugWizard(env: Env, chatId: number, tgId: number) {
  const existed = !!(await getSession(env, tgId));
  await clearSession(env, tgId);
  await sendMessage(
    env,
    chatId,
    existed
      ? "Cancelled. Your draft has been discarded."
      : "Nothing to cancel — you don't have a report in progress.",
  );
}

// Dispatch an incoming message from a user who has an active session.
export async function handleWizardMessage(env: Env, msg: TelegramMessage) {
  const chatId = msg.chat.id;
  const tgId = msg.from?.id;
  if (!tgId) return;

  const s = await getSession(env, tgId);
  if (!s) return;

  // /cancel is handled by the commands module before we get here, but a stray
  // /start/etc. inside the wizard should abort rather than being stored.
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (text.startsWith("/")) return;

  // Attachments step accepts media; other steps accept text.
  if (s.step === "attachments") {
    if (text.toLowerCase() === "done") {
      s.step = "confirm";
      await saveSession(env, tgId, s);
      await promptFor(env, chatId, s.step, s.draft);
      return;
    }
    const att = extractAttachment(msg);
    if (att) {
      s.draft.attachments.push(att);
      await saveSession(env, tgId, s);
      await sendMessage(
        env,
        chatId,
        `Got it. ${s.draft.attachments.length} attachment${s.draft.attachments.length === 1 ? "" : "s"} so far. Send more, or type <b>done</b> to continue.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    await sendMessage(
      env,
      chatId,
      "Send a photo, video, or document — or type <b>done</b> to continue.",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (s.step === "confirm") {
    if (/^(yes|y|send|submit|go)$/i.test(text)) {
      await submitDraft(env, chatId, tgId, s, msg);
      return;
    }
    if (/^(no|n|cancel|abort)$/i.test(text)) {
      await cancelBugWizard(env, chatId, tgId);
      return;
    }
    await sendMessage(env, chatId, "Reply <b>yes</b> to submit or <b>no</b> to cancel.", { parse_mode: "HTML" });
    return;
  }

  // Text steps.
  if (!text) return;
  applyTextAnswer(s, text);
  advance(s);
  await saveSession(env, tgId, s);
  await promptFor(env, chatId, s.step, s.draft);
}

// Handle callback_query taps from inline pickers we sent during the wizard.
export async function handleWizardCallback(
  env: Env,
  chatId: number,
  tgId: number,
  data: string,
): Promise<boolean> {
  const s = await getSession(env, tgId);
  if (!s) return false;

  // wiz:<step>:<value>
  const m = data.match(/^wiz:(category|severity|frequency):(.+)$/);
  if (!m) return false;
  const [, step, value] = m;
  if (step === "category") s.draft.category = value as CategoryId;
  else if (step === "severity") s.draft.severity = value as SeverityId;
  else if (step === "frequency") s.draft.frequency = value as FrequencyId;
  advance(s);
  await saveSession(env, tgId, s);
  await promptFor(env, chatId, s.step, s.draft);
  return true;
}

// ── Internal helpers ───────────────────────────────────────
function applyTextAnswer(s: Session, text: string) {
  const skip = isSkip(text);
  switch (s.step) {
    case "app":         s.draft.app = text; break;
    case "app_version": s.draft.app_version = skip ? undefined : text; break;
    case "app_build":   s.draft.app_build = skip ? undefined : text; break;
    case "device":      s.draft.device = skip ? undefined : text; break;
    case "os":          s.draft.os = skip ? undefined : text; break;
    case "title":       s.draft.title = text; break;
    case "actual":      s.draft.actual = text; break;
    case "expected":    s.draft.expected = skip ? undefined : text; break;
    case "steps":       s.draft.steps = skip ? undefined : text; break;
    case "notes":       s.draft.notes = skip ? undefined : text; break;
    // enum-picker steps handled via callback; typing free-text there is ignored.
    case "category":
    case "severity":
    case "frequency":
    case "attachments":
    case "confirm":
      break;
  }
}

function advance(s: Session) {
  const i = ORDER.indexOf(s.step);
  s.step = ORDER[Math.min(i + 1, ORDER.length - 1)];
}

async function promptFor(env: Env, chatId: number, step: Step, draft?: Draft) {
  switch (step) {
    case "app":
      await sendMessage(env, chatId, "Which app is this about? (e.g. Vox, Lurelia)");
      return;
    case "app_version":
      await sendMessage(env, chatId, "What app <b>version</b> are you on? (e.g. 1.2.0 — or type <b>skip</b>)", { parse_mode: "HTML" });
      return;
    case "app_build":
      await sendMessage(env, chatId, "What <b>build number</b>? (e.g. 142 — or type <b>skip</b>)", { parse_mode: "HTML" });
      return;
    case "device":
      await sendMessage(env, chatId, "What device are you using? (e.g. iPhone 16 Pro — or <b>skip</b>)", { parse_mode: "HTML" });
      return;
    case "os":
      await sendMessage(env, chatId, "What OS/version? (e.g. iOS 26.6 — or <b>skip</b>)", { parse_mode: "HTML" });
      return;
    case "category":
      await sendMessage(env, chatId, "Pick a category:", {
        reply_markup: {
          inline_keyboard: chunk(
            CATEGORIES.map((c) => ({ text: c.label, callback_data: `wiz:category:${c.id}` })),
            2,
          ),
        },
      });
      return;
    case "severity":
      await sendMessage(env, chatId, "How severe is it?", {
        reply_markup: {
          inline_keyboard: SEVERITIES.map((s) => [
            { text: `${s.label} — ${s.hint}`, callback_data: `wiz:severity:${s.id}` },
          ]),
        },
      });
      return;
    case "title":
      await sendMessage(env, chatId, "Give it a <b>short title</b> (one line).", { parse_mode: "HTML" });
      return;
    case "actual":
      await sendMessage(env, chatId, "<b>What happened?</b> Describe it in your own words.", { parse_mode: "HTML" });
      return;
    case "expected":
      await sendMessage(env, chatId, "<b>What did you expect to happen?</b> (or <b>skip</b>)", { parse_mode: "HTML" });
      return;
    case "steps":
      await sendMessage(
        env,
        chatId,
        "<b>Steps to reproduce.</b> Number them if you can:\n1. …\n2. …\n(or <b>skip</b>)",
        { parse_mode: "HTML" },
      );
      return;
    case "frequency":
      await sendMessage(env, chatId, "How often does it happen?", {
        reply_markup: {
          inline_keyboard: FREQUENCIES.map((f) => [
            { text: f.label, callback_data: `wiz:frequency:${f.id}` },
          ]),
        },
      });
      return;
    case "notes":
      await sendMessage(env, chatId, "Anything else we should know? (or <b>skip</b>)", { parse_mode: "HTML" });
      return;
    case "attachments":
      await sendMessage(
        env,
        chatId,
        "Send any <b>screenshots, screen recordings, or files</b> that show the bug.\nWhen you're finished attaching (or if you have none), type <b>done</b>.",
        { parse_mode: "HTML" },
      );
      return;
    case "confirm":
      await sendMessage(env, chatId, renderSummary(draft!), { parse_mode: "HTML" });
      return;
  }
}

function renderSummary(d: Draft): string {
  const line = (label: string, v?: string) => (v ? `<b>${esc(label)}:</b> ${esc(v)}` : null);
  const parts = [
    `<b>Review your report</b>`,
    ``,
    line("App", d.app),
    line("Version", d.app_version),
    line("Build", d.app_build),
    line("Device", d.device),
    line("OS", d.os),
    line("Category", d.category),
    line("Severity", d.severity),
    line("Title", d.title),
    ``,
    `<b>What happened:</b>\n${esc(d.actual ?? "")}`,
    d.expected ? `\n<b>Expected:</b>\n${esc(d.expected)}` : null,
    d.steps ? `\n<b>Steps:</b>\n${esc(d.steps)}` : null,
    d.frequency ? `\n<b>Frequency:</b> ${esc(d.frequency)}` : null,
    d.notes ? `\n<b>Notes:</b>\n${esc(d.notes)}` : null,
    ``,
    `Attachments: <b>${d.attachments.length}</b>`,
    ``,
    `Send this report? Reply <b>yes</b> or <b>no</b>.`,
  ].filter(Boolean);
  return parts.join("\n");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function extractAttachment(msg: TelegramMessage): IncomingAttachment | null {
  if (msg.photo && msg.photo.length) {
    // Telegram returns multiple sizes; pick the largest.
    const largest = msg.photo.reduce((a, b) => ((a.width * a.height) > (b.width * b.height) ? a : b));
    return {
      source: "telegram",
      kind: "photo",
      telegram_file_id: largest.file_id,
      size_bytes: largest.file_size,
      width: largest.width,
      height: largest.height,
    };
  }
  if (msg.video) {
    return {
      source: "telegram",
      kind: "video",
      telegram_file_id: msg.video.file_id,
      mime: msg.video.mime_type,
      file_name: msg.video.file_name,
      size_bytes: msg.video.file_size,
      width: msg.video.width,
      height: msg.video.height,
    };
  }
  if (msg.animation) {
    return {
      source: "telegram",
      kind: "animation",
      telegram_file_id: msg.animation.file_id,
      mime: msg.animation.mime_type,
      file_name: msg.animation.file_name,
      size_bytes: msg.animation.file_size,
      width: msg.animation.width,
      height: msg.animation.height,
    };
  }
  if (msg.document) {
    return {
      source: "telegram",
      kind: "document",
      telegram_file_id: msg.document.file_id,
      mime: msg.document.mime_type,
      file_name: msg.document.file_name,
      size_bytes: msg.document.file_size,
    };
  }
  return null;
}

async function submitDraft(env: Env, chatId: number, tgId: number, s: Session, msg: TelegramMessage) {
  const d = s.draft;
  const missing: string[] = [];
  if (!d.app) missing.push("app");
  if (!d.category) missing.push("category");
  if (!d.severity) missing.push("severity");
  if (!d.title) missing.push("title");
  if (!d.actual) missing.push("what happened");
  if (missing.length) {
    await sendMessage(env, chatId, `Missing required fields: ${missing.join(", ")}. Please start over with /bug.`);
    await clearSession(env, tgId);
    return;
  }

  try {
    await createBug(
      env,
      {
        reporter_tg_id: tgId,
        reporter_username: msg.from?.username ?? null,
        reporter_display_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || null,
        app: d.app!,
        app_version: d.app_version ?? null,
        app_build: d.app_build ?? null,
        device: d.device ?? null,
        os: d.os ?? null,
        category: d.category!,
        severity: d.severity!,
        title: d.title!,
        actual_behavior: d.actual!,
        expected_behavior: d.expected ?? null,
        reproduction_steps: d.steps ?? null,
        frequency: d.frequency ?? null,
        notes: d.notes ?? null,
      },
      d.attachments,
    );
    // createBug already DMs the reporter a confirmation.
  } catch (e) {
    log.error("wizard_submit_failed", e, { tgId });
    await sendMessage(env, chatId, "Sorry — something went wrong submitting your report. Please try again in a minute.");
  } finally {
    await clearSession(env, tgId);
  }
}
