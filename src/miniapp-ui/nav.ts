// Bottom nav + view switching. Views are <section class="view"> with ids
// view-home / view-create / view-history.

import { $, $$, requireEl } from "./dom";
import { loadHistory } from "./history";

export type ViewName = "home" | "create" | "history";

export function initNav(): void {
  for (const btn of $$<HTMLElement>("[data-goto]")) {
    btn.onclick = () => {
      const to = btn.dataset.goto as ViewName | undefined;
      if (to) goto(to);
    };
  }
  goto("home");
}

export function goto(view: ViewName): void {
  for (const name of ["home", "create", "history"] as const) {
    const section = requireEl<HTMLElement>(`#view-${name}`);
    section.classList.toggle("active-view", name === view);
  }

  for (const btn of $$<HTMLButtonElement>(".nav-btn")) {
    const active = btn.dataset.goto === view;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }

  requireEl("#app").scrollTop = 0;
  window.scrollTo(0, 0);

  if (view === "history") void loadHistory();
}
