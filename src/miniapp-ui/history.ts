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
  bug_type?: string;
  bug_type_label?: string;
  feature?: string | null;
  feature_label?: string | null;
  affected_areas?: string | null;
  affected_area_labels?: string[];
  created_at: number;
  // Delivery state (added by handleMyBugs). Missing on older API responses.
  telegram_posted?: boolean;
  report_posted?: boolean;
  can_resubmit?: boolean;
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
  github_url?: string | null;
  work_id?: string;
}
interface AttachmentDetail {
  id: number;
  kind: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  posted_message_id: number | null;
}

interface WorkHistoryEntry {
  id: number;
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
  actor_telegram_id: number | null;
  actor_username: string | null;
  created_at: number;
}

let workFiltersBound = false;
let isHistoryAdmin = false;

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  confirmed: "Confirmed",
  investigating: "Investigating",
  in_progress: "In Progress",
  fix_in_testing: "Fix In Testing",
  fixed: "Fixed",
  closed: "Closed",
  cannot_reproduce: "Cannot Repro",
  accepted: "Accepted",
  rejected: "Rejected",
  in_testing: "In Testing",
  shipped: "Shipped",
  reviewed: "Reviewed",
  noted: "Noted",
  needs_follow_up: "Needs Follow-Up",
  incorporated: "Incorporated",
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
  accepted: "#4ade80",
  rejected: "#ff5c73",
  in_testing: "#b46bf7",
  shipped: "#77e08c",
  reviewed: "#a58ad9",
  noted: "#c99ac0",
  needs_follow_up: "#3ea1f7",
  incorporated: "#77e08c",
};
export async function loadHistory(): Promise<void> {
  isHistoryAdmin = await loadAdminState();
  setupHistoryModeSwitch(isHistoryAdmin);
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
    type: "bug" | "idea" | "beta";
    id: number;
    public_id: string;
    title: string;
    app?: string;
    status: string;
    created_at: number;
    telegram_posted?: boolean;
    report_posted?: boolean;
    can_resubmit?: boolean;
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
  for (const it of items) list.appendChild(renderRow(it as unknown as BugSummary & { type?: "bug" | "idea" | "beta"; app?: string }));
  list.classList.remove("hidden");
}

function setupHistoryModeSwitch(isAdmin: boolean): void {
  const switcher = document.getElementById("history-mode-switch");
  const postsTab = document.getElementById("posts-history-tab") as HTMLButtonElement | null;
  const workTab = document.getElementById("work-history-tab") as HTMLButtonElement | null;
  const postsPanel = document.getElementById("posts-history-panel");
  const workPanel = document.getElementById("work-history-panel");
  if (!switcher || !postsTab || !workTab || !postsPanel || !workPanel) return;
  switcher.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) {
    postsPanel.classList.remove("hidden");
    workPanel.classList.add("hidden");
    return;
  }
  postsTab.onclick = () => {
    postsTab.classList.add("active");
    postsTab.setAttribute("aria-selected", "true");
    workTab.classList.remove("active");
    workTab.setAttribute("aria-selected", "false");
    postsPanel.classList.remove("hidden");
    workPanel.classList.add("hidden");
    requireEl("#history-detail").classList.add("hidden");
  };
  workTab.onclick = () => {
    workTab.classList.add("active");
    workTab.setAttribute("aria-selected", "true");
    postsTab.classList.remove("active");
    postsTab.setAttribute("aria-selected", "false");
    postsPanel.classList.add("hidden");
    workPanel.classList.remove("hidden");
    requireEl("#history-detail").classList.add("hidden");
    bindWorkHistoryFilters();
    void loadWorkHistory();
  };
}

async function loadAdminState(): Promise<boolean> {
  if (!INIT_DATA) return false;
  try {
    const res = await fetch("/api/me", { headers: authHeaders() });
    const data = await res.json() as { ok: boolean; is_admin?: boolean };
    return !!(res.ok && data.ok && data.is_admin);
  } catch {
    return false;
  }
}
function renderRow(bug: BugSummary & { type?: "bug" | "idea" | "beta"; app?: string }): HTMLLIElement {
  const li = document.createElement("li");
  const isIdea = bug.type === "idea";
  const isBeta = bug.type === "beta";
  li.className = `history-item${isIdea ? " history-item-idea" : ""}${isBeta ? " history-item-beta" : ""}`;
  li.setAttribute("role", "button");
  li.tabIndex = 0;

  const row1 = document.createElement("div");
  row1.className = "row1";
  // Type badge distinguishes bugs from ideas at a glance.
  // Uses the same monochrome SVGs as the Create landing cards, tinted to
  // match the badge color via CSS filter — no emojis anywhere in the UI.
  const typeBadge = document.createElement("span");
  typeBadge.className = `type-badge type-badge-${isIdea ? "idea" : isBeta ? "beta" : "bug"}`;
  const badgeIcon = document.createElement("img");
  badgeIcon.className = "type-badge-glyph";
  badgeIcon.alt = "";
  badgeIcon.src = isIdea ? "/icons/decorbulb.svg" : isBeta ? "/icons/starchat.svg" : "/icons/cutebug.svg";
  const badgeText = document.createElement("span");
  badgeText.textContent = isIdea ? "Idea" : isBeta ? "Beta" : "Bug";
  typeBadge.append(badgeIcon, badgeText);
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
  if (isIdea || isBeta) {
    if (bug.app) parts.push(String(bug.app));
  } else {
    if (bug.bug_type_label || bug.bug_type || bug.category) parts.push(String(bug.bug_type_label || labelize(String(bug.bug_type || bug.category))));
    if (bug.severity) parts.push(labelize(String(bug.severity)));
    if (bug.feature_label || bug.feature) parts.push(String(bug.feature_label || labelize(String(bug.feature))));
  }
  parts.push(formatRelative(bug.created_at));
  meta.textContent = parts.join(" · ");
  li.append(row1, title, meta);

  // Delivery banner: shows when this specific submission did not fully land on Telegram.
  // Bug and idea ids live in separate tables, so resubmission MUST remain type-aware.
  const missing = bug.telegram_posted === false || bug.report_posted === false;
  if (missing) {
    const banner = document.createElement("div");
    banner.className = "delivery-banner";
    const label = document.createElement("span");
    label.className = "delivery-label";
    label.textContent = bug.telegram_posted === false
      ? "⚠ Not sent to Telegram yet"
      : "⚠ Report didn't finish posting";
    banner.append(label);
    if (bug.can_resubmit === true) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "resend-chip";
      btn.textContent = "Resend";
      btn.onclick = (ev) => {
        ev.stopPropagation();
        void resendFromRow(bug.id, isIdea ? "idea" : isBeta ? "beta" : "bug", btn, label);
      };
      banner.append(btn);
    }
    li.appendChild(banner);
  }

  const open = () => void openDetail(bug.id, isIdea ? "idea" : isBeta ? "beta" : "bug");
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(); });
  return li;
}

function bindWorkHistoryFilters(): void {
  if (workFiltersBound) return;
  workFiltersBound = true;
  for (const id of ["work-history-search","work-history-type","work-history-app","work-history-assignee","work-history-event","work-history-state"]) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
      void loadWorkHistory();
    });
  }
}

async function loadWorkHistory(): Promise<void> {
  if (!isHistoryAdmin) return;
  const loading = requireEl("#work-history-loading");
  const empty = requireEl("#work-history-empty");
  const list = requireEl<HTMLUListElement>("#work-history-list");
  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  list.classList.add("hidden");
  list.innerHTML = "";

  let data: {
    ok: boolean;
    entries?: WorkHistoryEntry[];
    filters?: { apps?: string[]; assignees?: string[]; event_types?: string[]; states?: string[] };
  } = { ok: false };
  try {
    const res = await fetch(`/api/work-history?${workHistoryQuery()}`, { headers: authHeaders() });
    data = await res.json() as typeof data;
  } catch { /* empty state below */ }

  loading.classList.add("hidden");
  if (!data.ok) {
    empty.classList.remove("hidden");
    const p = empty.querySelector("p");
    if (p) p.textContent = "Couldn't load internal work history.";
    return;
  }
  hydrateWorkFilterOptions(data.filters ?? {});
  const entries = data.entries ?? [];
  if (!entries.length) {
    empty.classList.remove("hidden");
    const p = empty.querySelector("p");
    if (p) p.textContent = "No internal work activity yet.";
    return;
  }
  for (const entry of entries) list.appendChild(renderWorkHistoryRow(entry));
  list.classList.remove("hidden");
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

function renderWorkHistoryRow(entry: WorkHistoryEntry): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `history-item work-entry history-item-${entry.submission_type}`;

  const row1 = document.createElement("div");
  row1.className = "row1";
  const typeBadge = document.createElement("span");
  typeBadge.className = `type-badge type-badge-${entry.submission_type}`;
  const badgeIcon = document.createElement("img");
  badgeIcon.className = "type-badge-glyph";
  badgeIcon.alt = "";
  badgeIcon.src = entry.submission_type === "idea" ? "/icons/decorbulb.svg" : entry.submission_type === "beta" ? "/icons/starchat.svg" : "/icons/cutebug.svg";
  const badgeText = document.createElement("span");
  badgeText.textContent = entry.submission_type === "bug" ? "Bug" : entry.submission_type === "idea" ? "Idea" : "Beta";
  typeBadge.append(badgeIcon, badgeText);
  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.textContent = labelize(entry.activity_status || "active");
  row1.append(typeBadge, pill);

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
  note.textContent = entry.note || "No note recorded.";
  li.append(row1, title, meta, note);
  return li;
}

// Inline resend triggered from the History row's ⚠ chip.
async function resendFromRow(id: number, type: "bug" | "idea" | "beta", btn: HTMLButtonElement, label: HTMLElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const base = type === "idea" ? "/api/myideas" : type === "beta" ? "/api/mybeta-feedback" : "/api/mybugs";
    const res = await fetch(`${base}/${id}/resubmit`, { method: "POST", headers: authHeaders() });
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
async function openDetail(id: number, type: "bug" | "idea" | "beta" = "bug"): Promise<void> {
  const list = requireEl("#history-list");
  const detail = requireEl("#history-detail");
  const loading = requireEl("#history-detail-loading");
  const content = requireEl("#history-detail-content");
  list.classList.add("hidden");
  detail.classList.remove("hidden");
  loading.classList.remove("hidden");
  content.classList.add("hidden");

  try {
    if (type === "idea") {
      const res = await fetch(`/api/myideas/${id}`, { headers: authHeaders() });
      const data = await res.json() as { ok: boolean; idea?: Record<string, unknown>; attachments?: AttachmentDetail[] };
      if (!res.ok || !data.ok || !data.idea) throw new Error("detail");
      renderIdeaDetail(data.idea, data.attachments ?? []);
      loading.classList.add("hidden");
      content.classList.remove("hidden");
      return;
    }
    if (type === "beta") {
      const res = await fetch(`/api/mybeta-feedback/${id}`, { headers: authHeaders() });
      const data = await res.json() as { ok: boolean; beta_feedback?: Record<string, unknown>; attachments?: AttachmentDetail[] };
      if (!res.ok || !data.ok || !data.beta_feedback) throw new Error("detail");
      renderBetaFeedbackDetail(data.beta_feedback, data.attachments ?? []);
      loading.classList.add("hidden");
      content.classList.remove("hidden");
      return;
    }
    const res = await fetch(`/api/mybugs/${id}`, { headers: authHeaders() });
    const data = await res.json() as { ok: boolean; bug?: BugDetail; attachments?: AttachmentDetail[] };
    if (!res.ok || !data.ok || !data.bug) throw new Error("detail");
    renderDetail(data.bug, data.attachments ?? []);
    loading.classList.add("hidden");
    content.classList.remove("hidden");
  } catch {
    loading.textContent = "Couldn't load this record.";
  }
}

// Detail renderer for ideas. The detail template is shared with bugs, so
// we hide bug-only grid cells (Version, Build, Device, OS, Category,
// Severity, Frequency) and relabel the copy-card headings to idea terms.
function renderIdeaDetail(idea: Record<string, unknown>, attachments: AttachmentDetail[]): void {
  const get = (k: string) => (idea[k] as string | null | undefined) ?? "";
  setText("#detail-public-id", String(idea.public_id ?? ""));
  setText("#detail-title", String(idea.title ?? ""));
  setText("#detail-status", labelize(String(idea.status ?? "")));
  setText("#detail-app", String(idea.app ?? ""));

  // Hide bug-only grid cells for ideas and let the App cell span the full
  // width so long app names aren't truncated.
  for (const id of ["detail-version","detail-build","detail-device","detail-os","detail-frequency","detail-feature","detail-affected-areas","detail-github"]) {
    const el = document.getElementById(id);
    const cell = el?.parentElement as HTMLElement | null | undefined;
    if (cell) cell.style.display = "none";
  }
  for (const id of ["detail-category","detail-severity"]) {
    const el = document.getElementById(id);
    const cell = el?.parentElement as HTMLElement | null | undefined;
    if (cell) cell.style.display = "";
  }
  const appCell = document.getElementById("detail-app")?.parentElement as HTMLElement | null;
  if (appCell) {
    appCell.style.gridColumn = "1 / -1";
    appCell.style.maxWidth = "none";
  }
  const appStrong = document.getElementById("detail-app") as HTMLElement | null;
  if (appStrong) {
    appStrong.style.whiteSpace = "normal";
    appStrong.style.overflow = "visible";
    appStrong.style.textOverflow = "clip";
  }

  // Relabel the copy-card headings to match idea field names, and populate.
  const copyCard = document.querySelector<HTMLElement>(".detail-copy-card");
  if (copyCard) {
    removeIdeaDynamicSections();
    const headings = copyCard.querySelectorAll("h2, h3");
    const labels = ["MY VISION", "WHY IT WOULD BE USEFUL", "USER FLOW", "EXPECTED EXPERIENCE"];
    headings.forEach((h, i) => { if (labels[i]) h.textContent = labels[i]; });
  }
  relabelGridCell("detail-category", "Idea Type");
  relabelGridCell("detail-severity", "Where It Belongs");
  setText("#detail-category", String((idea.idea_type_label ?? labelize(get("idea_type"))) || "Not provided"));
  setText("#detail-severity", String((idea.where_it_belongs_label ?? get("where_it_belongs")) || "Not provided"));
  setText("#detail-actual",   get("what_i_want"));
  setText("#detail-expected", get("why_useful")   || "Not provided");
  setText("#detail-steps",    numberedListText(parseIdeaList(get("user_flow"), get("how_it_works"))) || "Not provided");
  setText("#detail-notes",    get("expected_experience") || "Not provided");
  renderAdminWorkId(get("work_id"));

  const existingBetaChanges = document.getElementById("detail-beta-changes");
  if (existingBetaChanges) existingBetaChanges.previousElementSibling?.remove();
  if (existingBetaChanges) existingBetaChanges.remove();
  if (copyCard) {
    insertDetailSection(copyCard, "detail-idea-key-features", "KEY FEATURES", checklistText(parseIdeaList(get("key_features"))), "#detail-notes");
    insertDetailSection(copyCard, "detail-idea-avoid", "ANYTHING TO AVOID?", get("anything_to_avoid"), null);
    insertDetailSection(copyCard, "detail-idea-extra-notes", "EXTRA NOTES", get("notes"), null);
  }

  const createdAt = Number(idea.created_at ?? 0);
  setText("#detail-submitted", createdAt ? new Date(createdAt * 1000).toLocaleString() : "");

  const attachmentList = document.getElementById("detail-attachments");
  if (attachmentList) {
    attachmentList.innerHTML = "";
    if (!attachments.length) {
      const li = document.createElement("li");
      li.className = "detail-attachment empty-attachment";
      li.textContent = "No attachments";
      attachmentList.appendChild(li);
    } else {
      for (const a of attachments) attachmentList.appendChild(renderAttachment(a));
    }
  }

  const rb = document.getElementById("detail-resubmit") as HTMLButtonElement | null;
  const eb = document.getElementById("detail-edit-beta") as HTMLAnchorElement | null;
  if (eb) eb.classList.add("hidden");
  if (rb) {
    if (idea.can_resubmit !== true) {
      rb.style.display = "none";
      rb.onclick = null;
      return;
    }
    rb.style.display = "";
    rb.textContent = "Resubmit to Telegram";
    rb.disabled = false;
    rb.onclick = () => void resubmitIdea(Number(idea.id), rb);
  }
}

function renderBetaFeedbackDetail(beta: Record<string, unknown>, attachments: AttachmentDetail[]): void {
  const get = (k: string) => (beta[k] as string | null | undefined) ?? "";
  setText("#detail-public-id", String(beta.public_id ?? ""));
  setText("#detail-title", String(beta.testing ?? ""));
  setText("#detail-status", STATUS_LABEL[String(beta.status ?? "")] ?? labelize(String(beta.status ?? "")));
  setText("#detail-app", String(beta.app ?? ""));
  setText("#detail-version", get("app_version") || "Not provided");
  setText("#detail-build", get("app_build") || "Not provided");

  for (const id of ["detail-version","detail-build","detail-category","detail-severity","detail-frequency"]) {
    const el = document.getElementById(id);
    const cell = el?.parentElement as HTMLElement | null | undefined;
    if (cell) cell.style.display = "";
  }
  for (const id of ["detail-device","detail-os"]) {
    const el = document.getElementById(id);
    const cell = el?.parentElement as HTMLElement | null | undefined;
    if (cell) cell.style.display = "none";
  }
  for (const id of ["detail-feature","detail-affected-areas","detail-github"]) {
    const el = document.getElementById(id);
    const cell = el?.parentElement as HTMLElement | null | undefined;
    if (cell) cell.style.display = "none";
  }
  relabelGridCell("detail-category", "Feedback Type");
  relabelGridCell("detail-severity", "Overall");
  relabelGridCell("detail-frequency", "Would Use");

  const feedbackTypes = parseFeedbackTypes(get("feedback_types")).map(labelize).join(", ") || "Not provided";
  setText("#detail-category", feedbackTypes);
  setText("#detail-severity", labelize(get("overall_experience")));
  setText("#detail-frequency", labelize(get("would_use_feature")));

  const appCell = document.getElementById("detail-app")?.parentElement as HTMLElement | null;
  if (appCell) { appCell.style.gridColumn = ""; appCell.style.maxWidth = ""; }
  const appStrong = document.getElementById("detail-app") as HTMLElement | null;
  if (appStrong) { appStrong.style.whiteSpace = ""; appStrong.style.overflow = ""; appStrong.style.textOverflow = ""; }

  const copyCard = document.querySelector<HTMLElement>(".detail-copy-card");
  if (copyCard) {
    removeIdeaDynamicSections();
    const headings = copyCard.querySelectorAll("h2, h3");
    const labels = ["What Did You Do?", "What Happened?", "What Did You Expect?", "Additional Notes"];
    headings.forEach((h, i) => { if (labels[i]) h.textContent = labels[i]; });
  }
  setText("#detail-actual", get("what_did_you_do"));
  setText("#detail-expected", get("what_happened"));
  setText("#detail-steps", get("expected_behavior") || "Not provided");
  setText("#detail-notes", get("notes") || "None");
  renderAdminWorkId(get("work_id"));

  const existingWhere = document.getElementById("detail-where-belongs");
  if (existingWhere) existingWhere.previousElementSibling?.remove();
  if (existingWhere) existingWhere.remove();
  const existingChanges = document.getElementById("detail-beta-changes");
  if (existingChanges) existingChanges.remove();
  const changes = get("changes").trim();
  if (changes && copyCard) {
    const h = document.createElement("h3");
    h.textContent = "Anything You'd Change?";
    const p = document.createElement("p");
    p.id = "detail-beta-changes";
    p.textContent = changes;
    copyCard.appendChild(h);
    copyCard.appendChild(p);
  }

  const createdAt = Number(beta.created_at ?? 0);
  setText("#detail-submitted", createdAt ? new Date(createdAt * 1000).toLocaleString() : "");

  const attachmentList = document.getElementById("detail-attachments");
  if (attachmentList) {
    attachmentList.innerHTML = "";
    if (!attachments.length) {
      const li = document.createElement("li");
      li.className = "detail-attachment empty-attachment";
      li.textContent = "No attachments";
      attachmentList.appendChild(li);
    } else {
      for (const a of attachments) attachmentList.appendChild(renderAttachment(a));
    }
  }

  const rb = document.getElementById("detail-resubmit") as HTMLButtonElement | null;
  const eb = document.getElementById("detail-edit-beta") as HTMLAnchorElement | null;
  if (eb) {
    eb.classList.remove("hidden");
    eb.href = `./create-beta-feedback.html?edit=${Number(beta.id)}`;
  }
  if (rb) {
    if (beta.can_resubmit !== true) {
      rb.style.display = "none";
      rb.onclick = null;
      return;
    }
    rb.style.display = "";
    rb.textContent = "Resubmit to Telegram";
    rb.disabled = false;
    rb.onclick = () => void resubmitBetaFeedback(Number(beta.id), rb);
  }
}

function renderDetail(bug: BugDetail, attachments: AttachmentDetail[]): void {
  // Restore the bug view: un-hide any cells the idea view may have hidden,
  // restore the copy-card labels, and remove any idea-only injections.
  for (const id of ["detail-version","detail-build","detail-device","detail-os","detail-category","detail-severity","detail-frequency","detail-feature","detail-affected-areas","detail-github"]) {
    const el = document.getElementById(id);
    const cell = el?.parentElement as HTMLElement | null | undefined;
    if (cell) cell.style.display = "";
  }
  // Restore the App cell's default single-column layout for bugs.
  const appCell = document.getElementById("detail-app")?.parentElement as HTMLElement | null;
  if (appCell) { appCell.style.gridColumn = ""; appCell.style.maxWidth = ""; }
  const appStrong = document.getElementById("detail-app") as HTMLElement | null;
  if (appStrong) { appStrong.style.whiteSpace = ""; appStrong.style.overflow = ""; appStrong.style.textOverflow = ""; }
  const copyCard = document.querySelector<HTMLElement>(".detail-copy-card");
  if (copyCard) {
    removeIdeaDynamicSections();
    const headings = copyCard.querySelectorAll("h2, h3");
    const bugLabels = ["What happened?", "Expected", "Steps to reproduce", "Additional notes"];
    headings.forEach((h, i) => { if (bugLabels[i]) h.textContent = bugLabels[i]; });
  }
  const wb = document.getElementById("detail-where-belongs");
  if (wb) wb.previousElementSibling?.remove(); // remove the injected <h3>
  if (wb) wb.remove();
  const bc = document.getElementById("detail-beta-changes");
  if (bc) bc.previousElementSibling?.remove();
  if (bc) bc.remove();
  const rb = document.getElementById("detail-resubmit") as HTMLButtonElement | null;
  const eb = document.getElementById("detail-edit-beta") as HTMLAnchorElement | null;
  if (eb) eb.classList.add("hidden");
  if (rb) {
    rb.style.display = bug.can_resubmit === true ? "" : "none";
    rb.onclick = null;
  }
  relabelGridCell("detail-category", "Bug Type");
  relabelGridCell("detail-severity", "Severity");
  relabelGridCell("detail-frequency", "Reproducibility");

  setText("#detail-public-id", bug.public_id);
  setText("#detail-title", bug.title);
  setText("#detail-status", STATUS_LABEL[bug.status] ?? labelize(bug.status));
  setText("#detail-app", bug.app);
  setText("#detail-version", bug.app_version || "Not provided");
  setText("#detail-build", bug.app_build || "Not provided");
  setText("#detail-device", bug.device || "Not provided");
  setText("#detail-os", bug.os || "Not provided");
  setText("#detail-category", bug.bug_type_label || labelize(bug.bug_type || bug.category));
  setText("#detail-severity", labelize(bug.severity));
  setText("#detail-actual", bug.actual_behavior);
  setText("#detail-expected", bug.expected_behavior || "Not provided");
  setText("#detail-steps", bug.reproduction_steps || "Not provided");
  setText("#detail-frequency", bug.frequency ? labelize(bug.frequency) : "Not specified");
  setText("#detail-notes", bug.notes || "None");
  setText("#detail-submitted", new Date(bug.created_at * 1000).toLocaleString());
  renderAdminWorkId(bug.work_id || "");

  ensureDetailCell("detail-feature", "Feature", bug.feature_label || (bug.feature ? labelize(bug.feature) : "Not provided"));
  ensureDetailCell("detail-affected-areas", "Affected Areas", bug.affected_area_labels?.length ? bug.affected_area_labels.join(", ") : "Not provided");
  ensureDetailCell("detail-github", "GitHub Issue", bug.github_url || "Not created");

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
  if (bug.can_resubmit !== true) {
    button.style.display = "none";
    button.onclick = null;
    return;
  }
  button.style.display = "";
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

async function resubmitIdea(id: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "Resubmitting…";
  const feedback = requireEl("#detail-resubmit-feedback");
  feedback.textContent = "";
  feedback.classList.remove("error");
  try {
    const res = await fetch(`/api/myideas/${id}/resubmit`, { method: "POST", headers: authHeaders() });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || "resubmit");
    feedback.classList.add("success");
    feedback.textContent = "Idea details and any pending attachments were sent to the Telegram comments.";
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

async function resubmitBetaFeedback(id: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "Resubmitting...";
  const feedback = requireEl("#detail-resubmit-feedback");
  feedback.textContent = "";
  feedback.classList.remove("error");
  try {
    const res = await fetch(`/api/mybeta-feedback/${id}/resubmit`, { method: "POST", headers: authHeaders() });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || "resubmit");
    feedback.classList.add("success");
    feedback.textContent = "Beta feedback details and any pending attachments were sent to the Telegram comments.";
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

async function resubmitBug(id: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "Resubmitting…";
  const feedback = requireEl("#detail-resubmit-feedback");
  feedback.textContent = "";
  feedback.classList.remove("error");
  try {
    const res = await fetch(`/api/mybugs/${id}/resubmit`, { method: "POST", headers: authHeaders() });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || "resubmit");
    feedback.classList.add("success");
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

function relabelGridCell(strongId: string, label: string): void {
  const cell = document.getElementById(strongId)?.parentElement as HTMLElement | null;
  const span = cell?.querySelector("span");
  if (span) span.textContent = label;
}

function ensureDetailCell(strongId: string, label: string, value: string): void {
  let strong = document.getElementById(strongId) as HTMLElement | null;
  if (!strong) {
    const grid = document.querySelector<HTMLElement>(".detail-grid");
    if (!grid) return;
    const cell = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = label;
    strong = document.createElement("strong");
    strong.id = strongId;
    cell.append(span, strong);
    grid.appendChild(cell);
  } else {
    relabelGridCell(strongId, label);
    const cell = strong.parentElement as HTMLElement | null;
    if (cell) cell.style.display = "";
  }
  strong.textContent = value;
}

function renderAdminWorkId(workId: string): void {
  const value = workId.trim();
  const existing = document.getElementById("detail-work-id");
  if (!isHistoryAdmin || !value) {
    if (existing) existing.parentElement?.remove();
    return;
  }
  ensureDetailCell("detail-work-id", "Internal Work ID", value);
}

function workEventLabel(value: string): string {
  switch (value) {
    case "case_assigned": return "Case Assigned";
    case "idea_assigned": return "Idea Assigned";
    default: return labelize(value);
  }
}

function parseFeedbackTypes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch { /* fall through */ }
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function parseIdeaList(raw: string, fallback = ""): string[] {
  const source = raw.trim() ? raw : fallback;
  if (!source.trim()) return [];
  try {
    const parsed = JSON.parse(source) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch { /* fall through */ }
  return source.split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim())
    .filter(Boolean);
}

function numberedListText(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function checklistText(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function removeIdeaDynamicSections(): void {
  for (const id of ["detail-idea-key-features","detail-idea-avoid","detail-idea-extra-notes"]) {
    const el = document.getElementById(id);
    if (el) el.previousElementSibling?.remove();
    if (el) el.remove();
  }
}

function insertDetailSection(copyCard: HTMLElement, id: string, headingText: string, value: string, beforeSelector: string | null): void {
  const text = value.trim();
  if (!text) return;
  const h = document.createElement("h3");
  h.textContent = headingText;
  const p = document.createElement("p");
  p.id = id;
  p.className = "prewrap";
  p.textContent = text;
  const before = beforeSelector ? copyCard.querySelector(beforeSelector)?.previousElementSibling ?? null : null;
  if (before) {
    copyCard.insertBefore(h, before);
    copyCard.insertBefore(p, before);
  } else {
    copyCard.appendChild(h);
    copyCard.appendChild(p);
  }
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
