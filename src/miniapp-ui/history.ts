// History view — fetches /api/mybugs and renders a list of the current
// user's reports with status pills.

import { requireEl, $ } from "./dom";
import { INIT_DATA } from "./tg";

interface BugSummary {
  public_id: string;
  title: string;
  status: string;
  severity: string;
  category: string;
  created_at: number;
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

let loadedOnce = false;

export async function loadHistory(force = false): Promise<void> {
  const loading = requireEl("#history-loading");
  const empty = requireEl("#history-empty");
  const list = requireEl<HTMLUListElement>("#history-list");

  if (loadedOnce && !force) {
    // still refresh silently — cheap enough
  }
  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  list.classList.add("hidden");
  list.innerHTML = "";

  let data: { ok: boolean; bugs?: BugSummary[] } = { ok: false };
  try {
    const res = await fetch("/api/mybugs", {
      headers: { "x-telegram-init-data": INIT_DATA },
    });
    data = (await res.json()) as { ok: boolean; bugs?: BugSummary[] };
  } catch { /* handled by empty state below */ }

  loading.classList.add("hidden");
  const bugs = data.ok && data.bugs ? data.bugs : [];
  loadedOnce = true;

  if (!bugs.length) {
    empty.classList.remove("hidden");
    return;
  }

  for (const b of bugs) list.appendChild(renderRow(b));
  list.classList.remove("hidden");
}

function renderRow(b: BugSummary): HTMLLIElement {
  const li = document.createElement("li");

  const row1 = document.createElement("div");
  row1.className = "row1";
  const pub = document.createElement("span");
  pub.className = "pubid";
  pub.textContent = b.public_id;
  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.textContent = STATUS_LABEL[b.status] ?? b.status;
  pill.style.background = `${STATUS_COLOR[b.status] ?? "#7a7a85"}22`;
  pill.style.color = STATUS_COLOR[b.status] ?? "#c0c0c8";
  row1.append(pub, pill);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = b.title;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${labelize(b.category)} · ${labelize(b.severity)} · ${formatRelative(b.created_at)}`;

  li.append(row1, title, meta);
  return li;
}

function labelize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRelative(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
