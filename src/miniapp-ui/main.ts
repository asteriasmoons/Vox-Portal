// Mini App bootstrap. Entry point bundled to public/app/app.js.

import { initTelegram, INIT_DATA } from "./tg";
import { loadFormConfig } from "./config";
import { initAttachments } from "./attachments";
import { initSubmit, resetForm } from "./submit";
import { loadHistory, initHistoryDetailBack } from "./history";
import { initSteps } from "./steps";
import { initIdeaPage } from "./idea";
import { initBetaFeedbackPage } from "./beta";
import { initCallbackDetailBack, loadCallbacks } from "./callbacks";
import { $ } from "./dom";
import { showTopError, clearErrors } from "./ui";
import { initTapToDismissTextFields } from "./webview";

initTelegram();
initTapToDismissTextFields();
const adminAccess = applyAdminAccess();

const page = document.body.dataset.page;

// The Create tab is now a landing screen; the bug form lives on create-bug.html
// and the idea form on create-idea.html. Each page's data-page attribute picks
// which wiring runs.
if (page === "create-bug") {
  if (!INIT_DATA) showTopError("This form must be opened from inside Telegram.");
  void loadFormConfig();
  initAttachments();
  initSteps();
  initSubmit();

  $<HTMLButtonElement>("#new-btn")?.addEventListener("click", () => {
    clearErrors();
    resetForm();
    window.scrollTo(0, 0);
  });
}

if (page === "create-idea") {
  void initIdeaPage();
}

if (page === "create-beta-feedback") {
  void initBetaFeedbackPage();
}

if (page === "history") {
  initHistoryDetailBack();
  void loadHistory();
}

if (page === "callbacks") {
  initCallbackDetailBack();
  void adminAccess.then((isAdmin) => {
    if (isAdmin) {
      void loadCallbacks();
    } else {
      showTopError("Callbacks are admin-only.");
      $("#callbacks-loading")?.classList.add("hidden");
      const empty = $("#callbacks-empty");
      empty?.classList.remove("hidden");
      const emptyText = empty?.querySelector("p");
      if (emptyText) emptyText.textContent = "Callbacks are only available to admins.";
    }
  });
}

async function applyAdminAccess(): Promise<boolean> {
  const adminLinks = Array.from(document.querySelectorAll<HTMLElement>(".admin-only-nav"));
  adminLinks.forEach((el) => el.classList.add("hidden"));
  if (!INIT_DATA) return false;

  try {
    const res = await fetch("/api/me", { headers: { "x-telegram-init-data": INIT_DATA } });
    const data = await res.json() as { ok: boolean; is_admin?: boolean };
    const isAdmin = !!(res.ok && data.ok && data.is_admin);
    document.body.classList.toggle("is-admin", isAdmin);
    adminLinks.forEach((el) => el.classList.toggle("hidden", !isAdmin));
    return isAdmin;
  } catch {
    document.body.classList.remove("is-admin");
    return false;
  }
}
