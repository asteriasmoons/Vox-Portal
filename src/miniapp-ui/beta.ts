// Beta Feedback form: mirrors the Idea form's standalone page wiring.

import { requireEl, formatBytes, $ } from "./dom";
import { INIT_DATA, haptic } from "./tg";
import { showTopError, clearErrors } from "./ui";

const H_INIT = "x-telegram-init-data";
const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;

interface Entry {
  id: number;
  file: File;
  status: "queued" | "uploading" | "done" | "error";
  key?: string;
  mime?: string;
  name?: string;
  size?: number;
  error?: string;
}

interface ConfigOption { id: string; label: string }
interface ConfigResponse {
  ok: true;
  apps: string[];
  beta_feedback_types: ConfigOption[];
  beta_overall_experiences: ConfigOption[];
  beta_would_use_options: ConfigOption[];
}

interface BetaSubmitResponse {
  ok: true;
  public_id: string;
  id: number;
  telegram: { status: "sent" | "failed" };
}

const queue: Entry[] = [];
let nextId = 1;

export async function initBetaFeedbackPage(): Promise<void> {
  if (!INIT_DATA) showTopError("This form must be opened from inside Telegram.");
  void loadBetaConfig();
  wireFilePicker();
  wireSubmit();
}

async function loadBetaConfig(): Promise<void> {
  try {
    const res = await fetch("/api/config");
    const cfg = (await res.json()) as ConfigResponse;
    if (!cfg.ok) throw new Error("config");
    const app = requireEl<HTMLSelectElement>("#beta-app-select");
    const overall = requireEl<HTMLSelectElement>("#beta-overall-select");
    const wouldUse = requireEl<HTMLSelectElement>("#beta-would-use-select");
    const typeBox = requireEl("#beta-feedback-type-options");
    for (const name of cfg.apps) addOption(app, name, name);
    for (const opt of cfg.beta_overall_experiences) addOption(overall, opt.id, opt.label);
    for (const opt of cfg.beta_would_use_options) addOption(wouldUse, opt.id, opt.label);
    typeBox.innerHTML = "";
    for (const opt of cfg.beta_feedback_types) {
      const label = document.createElement("label");
      label.className = "check-chip";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "feedback_types";
      input.value = opt.id;
      const text = document.createElement("span");
      text.textContent = opt.label;
      label.append(input, text);
      typeBox.appendChild(label);
    }
  } catch {
    showTopError("Couldn't load the form options. Please close and reopen.");
  }
}

function addOption(sel: HTMLSelectElement, value: string, label: string): void {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  sel.appendChild(opt);
}

function wireFilePicker(): void {
  const input = requireEl<HTMLInputElement>("#beta-file-input");
  input.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    const files = Array.from(target.files ?? []);
    target.value = "";
    for (const f of files) enqueue(f);
  });
  renderQueue();
}

function enqueue(file: File): void {
  if (queue.filter((u) => u.status !== "error").length >= MAX_FILES) {
    showTopError(`You can attach up to ${MAX_FILES} files.`);
    return;
  }
  if (file.size > MAX_BYTES) {
    showTopError(`"${file.name}" is larger than 20 MB.`);
    return;
  }
  const entry: Entry = { id: nextId++, file, status: "queued" };
  queue.push(entry);
  renderQueue();
  void upload(entry);
}

async function upload(entry: Entry): Promise<void> {
  entry.status = "uploading";
  renderQueue();
  try {
    const fd = new FormData();
    fd.append("file", entry.file, entry.file.name);
    const res = await fetch("/api/upload", { method: "POST", headers: { [H_INIT]: INIT_DATA }, body: fd });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; key?: string; mime?: string; name?: string; size?: number; error?: string };
    if (!res.ok || !data.ok || !data.key) throw new Error(data.error ?? "upload");
    entry.key = data.key; entry.mime = data.mime; entry.name = data.name; entry.size = data.size;
    entry.status = "done";
  } catch (e) {
    entry.status = "error";
    entry.error = e instanceof Error ? e.message : String(e);
  }
  renderQueue();
}

function renderQueue(): void {
  const list = requireEl<HTMLUListElement>("#beta-file-list");
  list.innerHTML = "";
  for (const u of queue) {
    const li = document.createElement("li");
    if (u.status === "error") li.classList.add("err");
    const name = document.createElement("span"); name.className = "name"; name.textContent = u.file.name;
    const size = document.createElement("span"); size.className = "size"; size.textContent = formatBytes(u.file.size);
    const stat = document.createElement("span"); stat.className = "prog";
    stat.textContent =
      u.status === "uploading" ? "uploading..." :
      u.status === "queued"    ? "queued"       :
      u.status === "error"     ? "failed"       : "✓";
    const rm = document.createElement("button"); rm.type = "button"; rm.className = "rm"; rm.textContent = "×";
    rm.setAttribute("aria-label", "Remove");
    rm.addEventListener("click", () => { const i = queue.indexOf(u); if (i >= 0) queue.splice(i, 1); renderQueue(); });
    li.append(name, size, stat, rm);
    list.appendChild(li);
  }
}

function wireSubmit(): void {
  const form = requireEl<HTMLFormElement>("#beta-feedback-form");
  const btn = requireEl<HTMLButtonElement>("#beta-submit-btn");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearErrors();

    const fd = new FormData(form);
    const data: Record<string, string> = {};
    for (const [k, v] of fd.entries()) {
      if (k !== "feedback_types") data[k] = typeof v === "string" ? v : "";
    }
    const feedbackTypes = fd.getAll("feedback_types").filter((v): v is string => typeof v === "string");

    const errs: [string, string][] = [];
    if (!data.app) errs.push(["app", "Required"]);
    if (!data.testing?.trim()) errs.push(["testing", "Required"]);
    if (!feedbackTypes.length) errs.push(["feedback_types", "Required"]);
    if (!data.what_did_you_do?.trim()) errs.push(["what_did_you_do", "Required"]);
    if (!data.what_happened?.trim()) errs.push(["what_happened", "Required"]);
    if (!data.overall_experience) errs.push(["overall_experience", "Required"]);
    if (!data.would_use_feature) errs.push(["would_use_feature", "Required"]);
    if (errs.length) {
      showFieldErrors(form, errs);
      showTopError("Please fix the highlighted fields.");
      return;
    }

    if (queue.some((u) => u.status === "queued" || u.status === "uploading")) {
      showTopError("Please wait for attachments to finish uploading.");
      return;
    }

    const attachments = queue
      .filter((u) => u.status === "done" && u.key)
      .map((u) => ({ key: u.key!, name: u.name!, mime: u.mime!, size: u.size }));

    btn.disabled = true; btn.textContent = "Sending...";
    try {
      const res = await fetch("/api/submit-beta-feedback", {
        method: "POST",
        headers: { "content-type": "application/json", [H_INIT]: INIT_DATA },
        body: JSON.stringify({
          app: data.app,
          app_version: data.app_version,
          app_build: data.app_build,
          testing: data.testing,
          feedback_types: feedbackTypes,
          what_did_you_do: data.what_did_you_do,
          what_happened: data.what_happened,
          expected_behavior: data.expected_behavior,
          overall_experience: data.overall_experience,
          would_use_feature: data.would_use_feature,
          changes: data.changes,
          notes: data.notes,
          attachments,
          submit_token: typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID() : String(Date.now()),
        }),
      });
      const out = (await res.json().catch(() => ({}))) as BetaSubmitResponse & { error?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? "submit");
      showBetaSuccess(out.public_id, out.telegram);
    } catch {
      btn.disabled = false; btn.textContent = "Send feedback";
      showTopError("Couldn't submit your beta feedback. Please try again.");
    }
  });
}

function showFieldErrors(form: HTMLFormElement, errs: [string, string][]): void {
  for (const [name, msg] of errs) {
    const el = name === "feedback_types"
      ? document.getElementById("beta-feedback-type-options")
      : form.querySelector<HTMLElement>(`[name="${name}"]`);
    if (!el) continue;
    const label = (el.closest("label") ?? el.closest("fieldset") ?? el.parentNode) as HTMLElement;
    const s = document.createElement("div");
    s.className = "field-error"; s.textContent = msg;
    label.appendChild(s);
  }
}

function showBetaSuccess(publicId: string, telegram: { status: "sent" | "failed" }): void {
  requireEl("#beta-success-id").textContent = publicId;
  requireEl("#beta-feedback-form").classList.add("hidden");
  requireEl("#beta-success").classList.remove("hidden");
  const dest = $("#beta-success-destinations");
  if (dest) {
    dest.innerHTML = "";
    dest.appendChild(destRow(telegram.status === "sent" ? "ok" : "warn",
      telegram.status === "sent" ? "Sent to Telegram" : "Telegram delivery failed"));
  }
  haptic("success");
}

function destRow(kind: "ok" | "warn" | "muted", text: string): HTMLElement {
  const li = document.createElement("li");
  li.className = `dest dest-${kind}`;
  const mark = document.createElement("span");
  mark.className = "dest-mark";
  mark.textContent = kind === "ok" ? "✓" : kind === "warn" ? "⚠" : "·";
  const label = document.createElement("span");
  label.className = "dest-label";
  label.textContent = text;
  li.append(mark, label);
  return li;
}
