// Beta Feedback form: create mode by default, edit mode when opened with
// ?edit=<id>. One form, two submission endpoints.

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

interface ExistingAttachment {
  id: number;
  kind: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  removed?: boolean;
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
  telegram: { status: "sent" | "updated" | "failed" };
}

interface BetaDetailResponse {
  ok: boolean;
  beta_feedback?: Record<string, unknown>;
  attachments?: ExistingAttachment[];
  error?: string;
}

const queue: Entry[] = [];
const existingAttachments: ExistingAttachment[] = [];
let nextId = 1;
let editId: number | null = null;
let editPublicId: string | null = null;

export async function initBetaFeedbackPage(): Promise<void> {
  if (!INIT_DATA) showTopError("This form must be opened from inside Telegram.");
  editId = editIdFromUrl();
  wireFilePicker();
  wireSubmit();
  await loadBetaConfig();
  if (editId) await loadForEdit(editId);
  renderQueue();
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

async function loadForEdit(id: number): Promise<void> {
  try {
    const res = await fetch(`/api/mybeta-feedback/${id}`, { headers: { [H_INIT]: INIT_DATA } });
    const data = (await res.json().catch(() => ({}))) as BetaDetailResponse;
    if (!res.ok || !data.ok || !data.beta_feedback) throw new Error(data.error ?? "detail");
    const row = data.beta_feedback;
    editPublicId = String(row.public_id ?? `BETA-${String(row.public_number ?? id).padStart(4, "0")}`);

    const title = document.querySelector<HTMLElement>(".page-title");
    if (title) title.textContent = "Edit Beta Feedback";
    const sub = document.querySelector<HTMLElement>(".sub");
    if (sub) sub.textContent = "Update the existing submission without creating a new BETA ID.";
    const back = document.querySelector<HTMLAnchorElement>(".back-btn");
    if (back) {
      back.href = "./history.html";
      back.textContent = "Back";
    }
    requireEl("#beta-edit-public-id").textContent = editPublicId;
    requireEl("#beta-edit-note").classList.remove("hidden");
    requireEl<HTMLButtonElement>("#beta-submit-btn").textContent = "Submit Updated Version";

    setValue("app", row.app);
    setValue("app_version", row.app_version);
    setValue("app_build", row.app_build);
    setValue("testing", row.testing);
    setValue("what_did_you_do", row.what_did_you_do);
    setValue("what_happened", row.what_happened);
    setValue("expected_behavior", row.expected_behavior);
    setValue("overall_experience", row.overall_experience);
    setValue("would_use_feature", row.would_use_feature);
    setValue("changes", row.changes);
    setValue("notes", row.notes);

    const selectedTypes = new Set(parseFeedbackTypes(String(row.feedback_types ?? "")));
    document.querySelectorAll<HTMLInputElement>('input[name="feedback_types"]').forEach((input) => {
      input.checked = selectedTypes.has(input.value);
    });

    existingAttachments.splice(0, existingAttachments.length, ...(data.attachments ?? []));
  } catch {
    showTopError("Couldn't load this beta feedback for editing.");
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
}

function enqueue(file: File): void {
  if (activeAttachmentCount() >= MAX_FILES) {
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

  for (const a of existingAttachments.filter((att) => !att.removed)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = a.file_name || labelize(a.kind);
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = a.size_bytes ? formatBytes(a.size_bytes) : "size unknown";
    const stat = document.createElement("span");
    stat.className = "prog";
    stat.textContent = "saved";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "×";
    rm.setAttribute("aria-label", "Remove");
    rm.addEventListener("click", () => { a.removed = true; renderQueue(); });
    li.append(name, size, stat, rm);
    list.appendChild(li);
  }

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

    const payload = {
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
      ...(editId ? {
        keep_attachment_ids: existingAttachments
          .filter((a) => !a.removed)
          .map((a) => a.id),
      } : {}),
    };

    btn.disabled = true;
    btn.textContent = editId ? "Updating..." : "Sending...";
    try {
      const res = await fetch(editId ? `/api/mybeta-feedback/${editId}` : "/api/submit-beta-feedback", {
        method: editId ? "PATCH" : "POST",
        headers: { "content-type": "application/json", [H_INIT]: INIT_DATA },
        body: JSON.stringify(payload),
      });
      const out = (await res.json().catch(() => ({}))) as BetaSubmitResponse & { error?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? "submit");
      showBetaSuccess(out.public_id, out.telegram);
    } catch {
      btn.disabled = false;
      btn.textContent = editId ? "Submit Updated Version" : "Send feedback";
      showTopError(editId ? "Couldn't update your beta feedback. Please try again." : "Couldn't submit your beta feedback. Please try again.");
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

function showBetaSuccess(publicId: string, telegram: { status: "sent" | "updated" | "failed" }): void {
  requireEl("#beta-success-id").textContent = publicId;
  requireEl("#beta-feedback-form").classList.add("hidden");
  requireEl("#beta-success").classList.remove("hidden");
  const title = document.querySelector<HTMLElement>("#beta-success .page-title");
  if (title) title.textContent = editId ? "Beta feedback updated" : "Beta feedback sent";
  const kicker = document.querySelector<HTMLElement>("#beta-success .success-kicker");
  if (kicker) kicker.textContent = editId ? "FEEDBACK UPDATED" : "FEEDBACK RECEIVED";
  const copy = document.querySelector<HTMLElement>("#beta-success .success-copy");
  if (copy) copy.innerHTML = editId
    ? `Your changes were saved to <b id="beta-success-id">${publicId}</b>.`
    : `Your feedback was saved as <b id="beta-success-id">${publicId}</b>.`;
  const dest = $("#beta-success-destinations");
  if (dest) {
    dest.innerHTML = "";
    const okText = editId ? "Telegram and GitHub mirrors updated" : "Sent to Telegram";
    dest.appendChild(destRow(telegram.status === "failed" ? "warn" : "ok",
      telegram.status === "failed" ? "Telegram delivery failed" : okText));
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

function editIdFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get("edit");
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function setValue(name: string, value: unknown): void {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
  if (el) el.value = typeof value === "string" ? value : "";
}

function parseFeedbackTypes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch { /* fall through */ }
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function activeAttachmentCount(): number {
  return existingAttachments.filter((a) => !a.removed).length
    + queue.filter((u) => u.status !== "error").length;
}

function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
