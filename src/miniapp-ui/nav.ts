// Page navigation for the three separate Mini App destinations.

export type PageName = "home" | "create" | "callbacks" | "history";

const PAGE_PATHS: Record<PageName, string> = {
  home: "./index.html",
  create: "./create.html",
  callbacks: "./callbacks.html",
  history: "./history.html",
};

export function goto(page: PageName): void {
  window.location.href = PAGE_PATHS[page];
}
