// Small UI helpers: top-of-form error banner, field errors, success view.
import { $, $$, requireEl } from "./dom";
import { haptic } from "./tg";
import type { GitHubResult } from "./api";

export function clearErrors(): void {
  $$(".field-error").forEach((n) => n.remove());
  $$(".top-error").forEach((n) => n.remove());
}

export function showTopError(msg: string): void {
  const form = $("#form");
  if (!form) return;
  $$(".top-error").forEach((n) => n.remove());
  const d = document.createElement("div");
  d.className = "top-error";
  d.textContent = msg;
  form.parentNode!.insertBefore(d, form);
}

export function showFieldErrors(errs: [string, string][]): void {
  const form = requireEl<HTMLFormElement>("#form");
  for (const [name, msg] of errs) {
    const el = form.querySelector<HTMLElement>(`[name="${name}"]`);
    if (!el) continue;
    const label = (el.closest("label") ?? el.parentNode) as HTMLElement;
    const s = document.createElement("div");
    s.className = "field-error";
    s.textContent = msg;
    label.appendChild(s);
  }
  showTopError("Please fix the highlighted fields.");
}

export function showSuccess(
  publicId: string,
  telegram: { status: "sent" },
  github: GitHubResult,
): void {
  requireEl("#success-id").textContent = publicId;
  requireEl("#form").classList.add("hidden");
  requireEl("#success").classList.remove("hidden");

  // Populate the per-destination result rows. #success-destinations must
  // exist in the template; we do not add it here to keep DOM structure
  // authoritative to the HTML file.
  const dest = $("#success-destinations");
  if (dest) {
    dest.innerHTML = "";
    dest.appendChild(destRow("ok", "Sent to Telegram"));
    dest.appendChild(gitHubRow(github));
  }
  haptic("success");
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
    label.href = href;
    label.target = "_blank";
    label.rel = "noopener noreferrer";
  }
  li.append(mark, label);
  return li;
}

function gitHubRow(g: GitHubResult): HTMLElement {
  switch (g.status) {
    case "created":
      return destRow("ok", `GitHub Issue #${g.issue_number} created`, g.issue_url);
    case "skipped_no_mapping":
      return destRow("muted", "No GitHub repo configured for this app");
    case "skipped_disabled":
      return destRow("muted", "GitHub integration disabled");
    case "failed":
      return destRow("warn", "GitHub issue could not be created");
    case "not_attempted":
    default:
      return destRow("muted", "GitHub: not attempted");
  }
}
