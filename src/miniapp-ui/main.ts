// Mini App bootstrap. Entry point bundled to public/app/app.js.

import { initTelegram, INIT_DATA } from "./tg";
import { loadFormConfig } from "./config";
import { initAttachments } from "./attachments";
import { initSubmit, resetForm } from "./submit";
import { loadHistory, initHistoryDetailBack } from "./history";
import { initSteps } from "./steps";
import { initIdeaPage } from "./idea";
import { $ } from "./dom";
import { showTopError, clearErrors } from "./ui";

initTelegram();

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

if (page === "history") {
  initHistoryDetailBack();
  void loadHistory();
}
