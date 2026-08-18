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
  document.body.dataset.view = view;

  for (const btn of $$<HTMLButtonElement>(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.goto === view);
    btn.setAttribute("aria-selected", String(btn.dataset.goto === view));
  }

  requireEl("#app").scrollTop = 0;
  window.scrollTo(0, 0);

  if (view === "history") void loadHistory();
}
