import { requireEl } from "./dom";
import { INIT_DATA, haptic } from "./tg";
import { TelegramMessageEditor } from "./telegram-message-editor";

interface WorkHistoryEntry {
  id: number;
  assignment_id: number | null;
  event_type: string;
  submission_type: "bug" | "idea" | "beta";
  submission_record_id: number;
  public_id: string;
  work_id: string;
  app: string;
  status: string;
  activity_status: string | null;
  assigned_username: string | null;
  assigned_telegram_user_id: number | null;
  assigned_by: number | null;
  assigned_by_username: string | null;
  note: string | null;
  message: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  actor_telegram_id: number | null;
  actor_username: string | null;
  created_at: number;
}

let workEditor: TelegramMessageEditor | null = null;
let currentWorkId = "";
let entriesCache: WorkHistoryEntry[] = [];
let filtersBound = false;

export function initWorkCenter(): void {
  workEditor = new TelegramMessageEditor(requireEl<HTMLElement>("#work-reporter-message"));
  requireEl<HTMLButtonElement>("#work-detail-back").addEventListener("click", () => {
    requireEl("#work-detail").classList.add("hidden");
    requireEl("#work-list-panel").classList.remove("hidden");
  });
  requireEl<HTMLButtonElement>("#work-send-reporter-update").addEventListener("click", () => void sendReporterUpdate());
  bindFilters();
  void loadWorkCenter();
}

export async function loadWorkCenter(): Promise<void> {
  const loading = requireEl("#work-history-loading");
  const empty = requireEl("#work-history-empty");
  const list = requireEl<HTMLUListElement>("#work-history-list");
  const detail = requireEl("#work-detail");
  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  list.classList.add("hidden");
  detail.classList.add("hidden");
  list.innerHTML = "";

  try {
    const res = await fetch(`/api/work-history?${workHistoryQuery()}`, { headers: authHeaders() });
    const data = await res.json() as {
      ok: boolean;
      entries?: WorkHistoryEntry[];
      filters?: { apps?: string[]; assignees?: string[]; event_types?: string[]; states?: string[] };
      error?: string;
    };
    if (!res.ok || !data.ok) throw new Error(data.error ?? "work");
    entriesCache = data.entries ?? [];
    hydrateWorkFilterOptions(data.filters ?? {});
    loading.classList.add("hidden");
    if (!entriesCache.length) {
      empty.classList.remove("hidden");
      return;
    }
    for (const entry of entriesCache) list.appendChild(renderWorkRow(entry));
    list.classList.remove("hidden");
  } catch {
    loading.textContent = "Couldn't load work.";
  }
}

function bindFilters(): void {
  if (filtersBound) return;
  filtersBound = true;
  for (const id of ["work-history-search","work-history-type","work-history-app","work-history-assignee","work-history-event","work-history-state"]) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
      void loadWorkCenter();
    });
  }
}

function renderWorkRow(entry: WorkHistoryEntry): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `history-item work-entry history-item-${entry.submission_type}`;
  li.setAttribute("role", "button");
  li.tabIndex = 0;

  const row1 = document.createElement("div");
  row1.className = "row1";
  const badge = document.createElement("span");
  badge.className = `type-badge type-badge-${entry.submission_type}`;
  const badgeIcon = document.createElement("img");
  badgeIcon.className = "type-badge-glyph";
  badgeIcon.alt = "";
  badgeIcon.src = entry.submission_type === "idea" ? "/icons/decorbulb.svg" : entry.submission_type === "beta" ? "/icons/starchat.svg" : "/icons/cutebug.svg";
  const badgeText = document.createElement("span");
  badgeText.textContent = entry.submission_type === "bug" ? "Bug" : entry.submission_type === "idea" ? "Idea" : "Beta";
  badge.append(badgeIcon, badgeText);
  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.textContent = labelize(entry.activity_status || entry.delivery_status || "active");
  row1.append(badge, pill);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = workEventLabel(entry.event_type);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [
    entry.public_id,
    `Work ID: ${entry.work_id}`,
    entry.app,
    entry.assigned_username ? `Assigned to ${entry.assigned_username}` : null,
    formatRelative(entry.created_at),
  ].filter(Boolean).join(" · ");
  const note = document.createElement("div");
  note.className = "work-note";
  note.textContent = entry.message || entry.note || "No note recorded.";
  li.append(row1, title, meta, note);

  const open = () => renderWorkDetail(entry);
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(); });
  return li;
}

function renderWorkDetail(entry: WorkHistoryEntry): void {
  currentWorkId = entry.work_id;
  requireEl("#work-list-panel").classList.add("hidden");
  requireEl("#work-detail").classList.remove("hidden");
  setText("#work-detail-public-id", entry.public_id);
  setText("#work-detail-state", labelize(entry.activity_status || "active"));
  setText("#work-detail-title", workEventLabel(entry.event_type));
  setText("#work-detail-meta", [entry.app, formatDate(entry.created_at)].filter(Boolean).join(" · "));
  setText("#work-detail-work-id", entry.work_id);
  setText("#work-detail-type", entry.submission_type === "bug" ? "Bug Report" : entry.submission_type === "idea" ? "Idea" : "Beta Feedback");
  setText("#work-detail-app", entry.app);
  setText("#work-detail-assignee", entry.assigned_username || "Unassigned");
  setText("#work-detail-status", labelize(entry.status));
  setText("#work-detail-created", formatDate(entry.created_at));
  setText("#work-detail-note", entry.note || "No assignment note recorded.");
  setText("#work-send-feedback", "");
  workEditor?.clear();
  renderRelatedActivity(entry.work_id);
}

function renderRelatedActivity(workId: string): void {
  const list = requireEl<HTMLUListElement>("#work-related-activity");
  list.innerHTML = "";
  const related = entriesCache.filter((entry) => entry.work_id === workId);
  if (!related.length) {
    const li = document.createElement("li");
    li.className = "detail-attachment empty-attachment";
    li.textContent = "No work activity recorded.";
    list.appendChild(li);
    return;
  }
  for (const item of related) {
    const li = document.createElement("li");
    li.className = "callback-interaction";
    const top = document.createElement("div");
    top.className = "callback-interaction-top";
    const kind = document.createElement("strong");
    kind.textContent = workEventLabel(item.event_type);
    const when = document.createElement("span");
    when.textContent = formatDate(item.created_at);
    top.append(kind, when);
    li.appendChild(top);
    const actor = document.createElement("p");
    actor.textContent = [
      item.actor_username ? `by ${item.actor_username}` : item.assigned_by ? `by ${item.assigned_by}` : null,
      item.assigned_username ? `assigned to ${item.assigned_username}` : null,
      item.delivery_status ? `delivery ${item.delivery_status}` : null,
    ].filter(Boolean).join(" · ");
    if (actor.textContent) li.appendChild(actor);
    const copy = item.message || item.note || item.delivery_error || "";
    if (copy) {
      const p = document.createElement("p");
      p.className = item.delivery_error ? "callback-error" : "callback-message-preview";
      p.textContent = copy;
      li.appendChild(p);
    }
    list.appendChild(li);
  }
}

async function sendReporterUpdate(): Promise<void> {
  if (!currentWorkId) return;
  const btn = requireEl<HTMLButtonElement>("#work-send-reporter-update");
  const feedback = requireEl("#work-send-feedback");
  const value = workEditor?.getValue() ?? { text: "", html: "", doc: "" };
  btn.disabled = true;
  feedback.textContent = "Sending...";
  feedback.classList.remove("error", "success");
  try {
    const res = await fetch("/api/work/reporter-update", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        work_id: currentWorkId,
        message: value.text,
        message_html: value.html,
        message_doc: value.doc,
      }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error ?? "send_failed");
    feedback.classList.add("success");
    feedback.textContent = "Reporter update sent.";
    workEditor?.clear();
    haptic("success");
    await loadWorkCenter();
    const fresh = entriesCache.find((entry) => entry.work_id === currentWorkId);
    if (fresh) renderWorkDetail(fresh);
  } catch (e) {
    feedback.classList.add("error");
    feedback.textContent = e instanceof Error ? friendlySendError(e.message) : "Couldn't send update.";
    haptic("error");
  } finally {
    btn.disabled = false;
  }
}

function workHistoryQuery(): string {
  const params = new URLSearchParams();
  const map: [string, string][] = [
    ["type", "work-history-type"],
    ["app", "work-history-app"],
    ["assignee", "work-history-assignee"],
    ["event_type", "work-history-event"],
    ["state", "work-history-state"],
    ["q", "work-history-search"],
  ];
  for (const [key, id] of map) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    const value = el?.value.trim();
    if (value) params.set(key, value);
  }
  return params.toString();
}

function hydrateWorkFilterOptions(filters: { apps?: string[]; assignees?: string[]; event_types?: string[]; states?: string[] }): void {
  hydrateSelect("work-history-app", "All Apps", filters.apps ?? []);
  hydrateSelect("work-history-assignee", "All Assignees", filters.assignees ?? []);
  hydrateSelect("work-history-event", "All Activity", filters.event_types ?? [], workEventLabel);
  hydrateSelect("work-history-state", "All States", filters.states ?? [], labelize);
}

function hydrateSelect(id: string, emptyLabel: string, values: string[], labeler: (value: string) => string = (v) => v): void {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  select.appendChild(empty);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = labeler(value);
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function workEventLabel(value: string): string {
  switch (value) {
    case "case_assigned": return "Case Assigned";
    case "idea_assigned": return "Idea Assigned";
    case "beta_assigned": return "Feedback Assigned";
    case "reporter_update_sent": return "Reporter Update";
    default: return labelize(value);
  }
}

function friendlySendError(code: string): string {
  switch (code) {
    case "bad_work_id": return "That Work ID is not valid.";
    case "not_found": return "That Work ID does not exist.";
    case "message_required": return "Message is required.";
    case "send_failed": return "Telegram could not deliver the DM. The reporter may need to start the bot first.";
    default: return "Couldn't send update.";
  }
}

function authHeaders(): Record<string, string> {
  return { "x-telegram-init-data": INIT_DATA };
}

function setText(selector: string, value: string): void {
  requireEl(selector).textContent = value;
}

function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRelative(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDate(unixSec: number | null): string {
  if (!unixSec) return "Never";
  return new Date(unixSec * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
