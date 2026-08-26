// Feature Idea form: app dropdown, attachment queue, submit.
// Separate queue instance from the Bug form so they don't share state.

import { requireEl, formatBytes, $ } from "./dom";
import { INIT_DATA } from "./tg";
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

const queue: Entry[] = [];
let nextId = 1;

interface ConfigResponse {
  ok: true;
  apps: string[];
  categories: { id: string; label: string }[];
  severities: { id: string; label: string }[];
  frequencies: { id: string; label: string }[];
}

interface IdeaGitHubResult {
  status: "created" | "skipped_no_mapping" | "skipped_disabled" | "failed";
  comment_id?: string;
  comment_url?: string;
  reason?: string;
}

interface IdeaSubmitResponse {
  ok: true;
  public_id: string;
  id: number;
  telegram: { status: "sent" | "failed" };
  github: IdeaGitHubResult;
}

export async function initIdeaPage(): Promise<void> {
  if (!INIT_DATA) showTopError("This form must be opened from inside Telegram.");
  void loadIdeaConfig();
  wireFilePicker();
  wireSubmit();
}

async function loadIdeaConfig(): Promise<void> {
  try {
    const res = await fetch("/api/config");
    const cfg = (await res.json()) as ConfigResponse;
    if (!cfg.ok) throw new Error("config");
    const sel = requireEl<HTMLSelectElement>("#idea-app-select");
    for (const name of cfg.apps) {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    }
  } catch {
    showTopError("Couldn't load the form options. Please close and reopen.");
  }
}

function wireFilePicker(): void {
  const input = requireEl<HTMLInputElement>("#idea-file-input");
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
  const list = requireEl<HTMLUListElement>("#idea-file-list");
  list.innerHTML = "";
  for (const u of queue) {
    const li = document.createElement("li");
    if (u.status === "error") li.classList.add("err");
    const name = document.createElement("span"); name.className = "name"; name.textContent = u.file.name;
    const size = document.createElement("span"); size.className = "size"; size.textContent = formatBytes(u.file.size);
    const stat = document.createElement("span"); stat.className = "prog";
    stat.textContent =
      u.status === "uploading" ? "uploading…" :
      u.status === "queued"    ? "queued"      :
      u.status === "error"     ? "failed"      : "✓";
    const rm = document.createElement("button"); rm.type = "button"; rm.className = "rm"; rm.textContent = "×";
    rm.setAttribute("aria-label", "Remove");
    rm.addEventListener("click", () => { const i = queue.indexOf(u); if (i >= 0) queue.splice(i, 1); renderQueue(); });
    li.append(name, size, stat, rm);
    list.appendChild(li);
  }
}

function wireSubmit(): void {
  const form = requireEl<HTMLFormElement>("#idea-form");
  const btn = requireEl<HTMLButtonElement>("#idea-submit-btn");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearErrors();

    const fd = new FormData(form);
    const data: Record<string, string> = {};
    for (const [k, v] of fd.entries()) data[k] = typeof v === "string" ? v : "";

    const errs: [string, string][] = [];
    if (!data.app) errs.push(["app", "Required"]);
    if (!data.title?.trim()) errs.push(["title", "Required"]);
    if (!data.what_i_want?.trim()) errs.push(["what_i_want", "Required"]);
    if (errs.length) {
      for (const [name, msg] of errs) {
        const el = form.querySelector<HTMLElement>(`[name="${name}"]`);
        if (!el) continue;
        const label = (el.closest("label") ?? el.parentNode) as HTMLElement;
        const s = document.createElement("div");
        s.className = "field-error"; s.textContent = msg;
        label.appendChild(s);
      }
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

    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      const res = await fetch("/api/submit-idea", {
        method: "POST",
        headers: { "content-type": "application/json", [H_INIT]: INIT_DATA },
        body: JSON.stringify({
          app: data.app,
          title: data.title,
          what_i_want: data.what_i_want,
          why_useful: data.why_useful,
          how_it_works: data.how_it_works,
          where_it_belongs: data.where_it_belongs,
          notes: data.notes,
          attachments,
          submit_token: typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID() : String(Date.now()),
        }),
      });
      const out = (await res.json().catch(() => ({}))) as IdeaSubmitResponse & { error?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? "submit");
      showIdeaSuccess(out.public_id, out.telegram, out.github);
    } catch {
      btn.disabled = false; btn.textContent = "Submit idea";
      showTopError("Couldn't submit your idea. Please try again.");
    }
  });
}

function showIdeaSuccess(publicId: string, telegram: { status: "sent" | "failed" }, github: IdeaGitHubResult): void {
  requireEl("#idea-success-id").textContent = publicId;
  requireEl("#idea-form").classList.add("hidden");
  requireEl("#idea-success").classList.remove("hidden");
  const dest = $("#idea-success-destinations");
  if (dest) {
    dest.innerHTML = "";
    dest.appendChild(destRow(telegram.status === "sent" ? "ok" : "warn",
      telegram.status === "sent" ? "Sent to Telegram" : "Telegram delivery failed"));
    dest.appendChild(ideaGitHubRow(github));
  }
}

function destRow(kind: "ok" | "warn" | "muted", text: string, href?: string): HTMLElement {
  const li = document.createElement("li");
  li.className = `dest dest-${kind}`;
  const mark = document.createElement("span");
  mark.className = "dest-mark";
  mark.textContent = kind === "ok" ? "✓" : kind === "warn" ? "⚠" : "·";
  const label = document.createElement(href ? "a" : "span");
  label.className = "dest-label";
  label.textContent = text;
  if (href && label instanceof HTMLAnchorElement) {
    label.href = href; label.target = "_blank"; label.rel = "noopener noreferrer";
  }
  li.append(mark, label);
  return li;
}

function ideaGitHubRow(g: IdeaGitHubResult): HTMLElement {
  switch (g.status) {
    case "created":
      return destRow("ok", "Idea posted to GitHub Discussion", g.comment_url);
    case "skipped_no_mapping":
      return destRow("muted", "No GitHub Ideas discussion configured for this app");
    case "skipped_disabled":
      return destRow("muted", "GitHub integration disabled");
    case "failed":
      return destRow("warn", "GitHub Discussion comment could not be created");
  }
}
