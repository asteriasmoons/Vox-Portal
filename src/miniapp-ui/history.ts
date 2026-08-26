// History page: list reports, open full details, and temporarily resubmit
// an existing report into its Telegram discussion comments.

import { requireEl } from "./dom";
import { INIT_DATA } from "./tg";

interface BugSummary {
  id: number;
  public_id: string;
  title: string;
  status: string;
  severity: string;
  category: string;
  created_at: number;
  // Delivery state (added by handleMyBugs). Missing on older API responses.
  telegram_posted?: boolean;
  report_posted?: boolean;
  github_created?: boolean;
  github_url?: string | null;
}

interface BugDetail extends BugSummary {
  app: string;
  app_version: string | null;
  app_build: string | null;
  device: string | null;
  os: string | null;
  actual_behavior: string;
  expected_behavior: string | null;
  reproduction_steps: string | null;
  frequency: string | null;
  notes: string | null;
  reporter_username: string | null;
  created_at: number;
}
interface AttachmentDetail {
  id: number;
  kind: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  posted_message_id: number | null;
}

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  confirmed: "Confirmed",
  investigating: "Investigating",
  in_progress: "In Progress",
  fix_in_testing: "Fix In Testing",
  fixed: "Fixed",
  closed: "Closed",
  cannot_reproduce: "Cannot Repro",
};

const STATUS_COLOR: Record<string, string> = {
  new: "#ff5c5c",
  confirmed: "#f7a13e",
  investigating: "#f7d13e",
  in_progress: "#3ea1f7",
  fix_in_testing: "#b46bf7",
  fixed: "#4ade80",
  closed: "#7a7a85",
  cannot_reproduce: "#c0c0c8",
};
export async function loadHistory(): Promise<void> {
  const loading = requireEl("#history-loading");
  const empty = requireEl("#history-empty");
  const list = requireEl<HTMLUListElement>("#history-list");
  const detail = requireEl("#history-detail");
  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  list.classList.add("hidden");
  detail.classList.add("hidden");
  list.innerHTML = "";

  interface Submission {
    type: "bug" | "idea";
    id: number;
    public_id: string;
    title: string;
    app?: string;
    status: string;
    created_at: number;
    telegram_posted?: boolean;
    report_posted?: boolean;
    github_created?: boolean;
    github_url?: string | null;
  }
  let data: { ok: boolean; submissions?: Submission[]; bugs?: BugSummary[] } = { ok: false };
  try {
    const res = await fetch("/api/mybugs", { headers: authHeaders() });
    data = await res.json() as { ok: boolean; submissions?: Submission[]; bugs?: BugSummary[] };
  } catch { /* empty state below */ }

  loading.classList.add("hidden");
  // Prefer the unified `submissions` feed; fall back to legacy `bugs` if
  // the server is an older build.
  const items: Submission[] = data.ok && data.submissions
    ? data.submissions
    : (data.bugs ?? []).map((b) => ({ ...b, type: "bug" as const }));
  if (!items.length) {
    empty.classList.remove("hidden");
    return;
  }
  for (const it of items) list.appendChild(renderRow(it as unknown as BugSummary & { type?: "bug" | "idea"; app?: string }));
  list.classList.remove("hidden");
}
function renderRow(bug: BugSummary & { type?: "bug" | "idea"; app?: string }): HTMLLIElement {
  const li = document.createElement("li");
  const isIdea = bug.type === "idea";
  li.className = `history-item${isIdea ? " history-item-idea" : ""}`;
  li.setAttribute("role", "button");
  li.tabIndex = 0;

  const row1 = document.createElement("div");
  row1.className = "row1";
  // Type badge distinguishes bugs from ideas at a glance.
  const typeBadge = document.createElement("span");
  typeBadge.className = `type-badge type-badge-${isIdea ? "idea" : "bug"}`;
  typeBadge.textContent = isIdea ? "💡 Idea" : "🐛 Bug";
  const pub = document.createElement("span");
  pub.className = "pubid";
  pub.textContent = bug.public_id;
  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.textContent = STATUS_LABEL[bug.status] ?? bug.status;
  pill.style.background = `${STATUS_COLOR[bug.status] ?? "#7a7a85"}22`;
  pill.style.color = STATUS_COLOR[bug.status] ?? "#c0c0c8";
  row1.append(typeBadge, pub, pill);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = bug.title;
  const meta = document.createElement("div");
  meta.className = "meta";
  // Meta line varies by type: bugs show category · severity, ideas show
  // app · created-at. Guard every field — an undefined slipping into
  // labelize() throws and would kill the whole render.
  const parts: string[] = [];
  if (isIdea) {
    if (bug.app) parts.push(String(bug.app));
  } else {
    if (bug.category) parts.push(labelize(String(bug.category)));
    if (bug.severity) parts.push(labelize(String(bug.severity)));
  }
  parts.push(formatRelative(bug.created_at));
  meta.textContent = parts.join(" · ");
  li.append(row1, title, meta);

  // Delivery banner: shows only when something didn't land on Telegram.
  // The chip's own click resubmits inline WITHOUT expanding the detail view,
  // so a stuck report can be retried from the list with one tap.
  const missing = bug.telegram_posted === false || bug.report_posted === false;
  if (missing) {
    const banner = document.createElement("div");
    banner.className = "delivery-banner";
    const label = document.createElement("span");
    label.className = "delivery-label";
    label.textContent = bug.telegram_posted === false
      ? "⚠ Not sent to Telegram yet"
      : "⚠ Report didn't finish posting";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "resend-chip";
    btn.textContent = "Resend";
    btn.onclick = (ev) => {
      ev.stopPropagation();
      void resendFromRow(bug.id, btn, label);
    };
    banner.append(label, btn);
    li.appendChild(banner);
  }

  const open = () => void openDetail(bug.id);
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(); });
  return li;
}

// Inline resend triggered from the History row's ⚠ chip.
async function resendFromRow(id: number, btn: HTMLButtonElement, label: HTMLElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const res = await fetch(`/api/mybugs/${id}/resubmit`, { method: "POST", headers: authHeaders() });
    const data = await res.json() as { ok: boolean; error?: string; telegram?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || "resubmit");
    label.textContent = "✓ Sent to Telegram";
    btn.textContent = "Sent";
  } catch (e) {
    const code = e instanceof Error ? e.message : "resubmit";
    label.textContent = friendlyResubmitError(code);
    btn.disabled = false;
    btn.textContent = "Retry";
  }
}
async function openDetail(id: number): Promise<void> {
  const list = requireEl("#history-list");
  const detail = requireEl("#history-detail");
  const loading = requireEl("#history-detail-loading");
  const content = requireEl("#history-detail-content");
  list.classList.add("hidden");
  detail.classList.remove("hidden");
  loading.classList.remove("hidden");
  content.classList.add("hidden");

  try {
    const res = await fetch(`/api/mybugs/${id}`, { headers: authHeaders() });
    const data = await res.json() as { ok: boolean; bug?: BugDetail; attachments?: AttachmentDetail[] };
    if (!res.ok || !data.ok || !data.bug) throw new Error("detail");
    renderDetail(data.bug, data.attachments ?? []);
    loading.classList.add("hidden");
    content.classList.remove("hidden");
  } catch {
    loading.textContent = "Couldn't load this report.";
  }
}

function renderDetail(bug: BugDetail, attachments: AttachmentDetail[]): void {
  setText("#detail-public-id", bug.public_id);
  setText("#detail-title", bug.title);
  setText("#detail-status", STATUS_LABEL[bug.status] ?? labelize(bug.status));
  setText("#detail-app", bug.app);
  setText("#detail-version", bug.app_version || "Not provided");
  setText("#detail-build", bug.app_build || "Not provided");
  setText("#detail-device", bug.device || "Not provided");
  setText("#detail-os", bug.os || "Not provided");
  setText("#detail-category", labelize(bug.category));
  setText("#detail-severity", labelize(bug.severity));
  setText("#detail-actual", bug.actual_behavior);
  setText("#detail-expected", bug.expected_behavior || "Not provided");
  setText("#detail-steps", bug.reproduction_steps || "Not provided");
  setText("#detail-frequency", bug.frequency ? labelize(bug.frequency) : "Not specified");
  setText("#detail-notes", bug.notes || "None");
  setText("#detail-submitted", new Date(bug.created_at * 1000).toLocaleString());

  const attachmentList = requireEl<HTMLUListElement>("#detail-attachments");
  attachmentList.innerHTML = "";
  if (!attachments.length) {
    const li = document.createElement("li");
    li.className = "detail-attachment empty-attachment";
    li.textContent = "No attachments";
    attachmentList.appendChild(li);
  } else {
    for (const a of attachments) attachmentList.appendChild(renderAttachment(a));
  }

  const button = requireEl<HTMLButtonElement>("#detail-resubmit");
  button.onclick = () => void resubmitBug(bug.id, button);
}
function renderAttachment(a: AttachmentDetail): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "detail-attachment";
  const name = document.createElement("span");
  name.className = "attachment-name";
  name.textContent = a.file_name || labelize(a.kind);
  const meta = document.createElement("span");
  meta.className = "attachment-meta";
  const size = a.size_bytes ? formatBytes(a.size_bytes) : "size unknown";
  meta.textContent = `${labelize(a.kind)} · ${size}`;
  li.append(name, meta);
  return li;
}

async function resubmitBug(id: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "Resubmitting…";
  const feedback = requireEl("#detail-resubmit-feedback");
  feedback.textContent = "";
  try {
    const res = await fetch(`/api/mybugs/${id}/resubmit`, { method: "POST", headers: authHeaders() });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || "resubmit");
    feedback.textContent = "Report details and any pending attachments were sent to the Telegram comments.";
    button.textContent = "Resubmitted";
  } catch (e) {
    const code = e instanceof Error ? e.message : "resubmit";
    feedback.classList.remove("success");
    feedback.classList.add("error");
    feedback.textContent = friendlyResubmitError(code);
    button.disabled = false;
    button.textContent = "Resubmit to Telegram";
  }
}
function friendlyResubmitError(code: string): string {
  switch (code) {
    case "discussion_mirror_missing":
    case "discussion_mirror_missing_after_repost":
      return "Telegram didn't return a comment thread for the channel post in time. Try again in a minute.";
    case "missing_channel_post":
      return "The original Telegram channel post is missing.";
    case "auth":
      return "Telegram couldn't verify this Mini App session. Reopen Vox Bugs from Telegram, then try again.";
    default:
      return "Couldn't send this report to Telegram. Please try again.";
  }
}

function authHeaders(): HeadersInit {
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initHistoryDetailBack(): void {
  requireEl<HTMLButtonElement>("#history-detail-back").addEventListener("click", () => {
    requireEl("#history-detail").classList.add("hidden");
    requireEl("#history-list").classList.remove("hidden");
  });
}
