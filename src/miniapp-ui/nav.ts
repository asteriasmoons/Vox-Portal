// Bottom nav + view switching. Views are <section class="view"> with ids
// view-home / view-create / view-history.

import { $, $$, requireEl } from "./dom";
import { loadHistory } from "./history";

export type ViewName = "home" | "create" | "history";

export function initNav(): void {
  // Wire every navigation control directly. Telegram's iOS WebView can be
  // inconsistent with delegated click targets inside nested button content.
  for (const btn of $$<HTMLElement>("[data-goto]")) {
    btn.addEventListener("click", (ev) => {
      const to = btn.dataset.goto as ViewName | undefined;
      if (!to) return;
      ev.preventDefault();
      ev.stopPropagation();
      goto(to);
    });
  }

  goto("home");
}

export function goto(view: ViewName): void {
  for (const v of ["home", "create", "history"] as const) {
    const el = $(`#view-${v}`);
    if (!el) continue;
    el.classList.toggle("hidden", v !== view);
  }
  for (const btn of $$<HTMLButtonElement>(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.goto === view);
  }
  // Scroll to top defensively — some webviews don't implement Element.scrollTo
  // with options and would throw silently otherwise.
  try { requireEl("main").scrollTop = 0; } catch { /* noop */ }
  try { window.scrollTo(0, 0); } catch { /* noop */ }
  if (view === "history") void loadHistory();
}
