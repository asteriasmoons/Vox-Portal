// Bottom nav + view switching. Views are <section class="view"> with ids
// view-home / view-create / view-history.

import { $, $$, requireEl } from "./dom";
import { loadHistory } from "./history";

export type ViewName = "home" | "create" | "history";

export function initNav(): void {
  // Wire every data-goto button (nav bar, hero CTAs, empty-state buttons).
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLElement>("[data-goto]");
    if (!btn) return;
    const to = btn.dataset.goto as ViewName | undefined;
    if (!to) return;
    ev.preventDefault();
    goto(to);
  });

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
  requireEl("main").scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  window.scrollTo({ top: 0 });
  if (view === "history") void loadHistory();
}
