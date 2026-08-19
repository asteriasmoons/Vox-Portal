// Mini App bootstrap. Entry point bundled to public/app/app.js.

import { initTelegram, INIT_DATA } from "./tg";
import { loadFormConfig } from "./config";
import { initAttachments } from "./attachments";
import { initSubmit, resetForm } from "./submit";
import { loadHistory } from "./history";
import { initSteps } from "./steps";
import { $ } from "./dom";
import { showTopError, clearErrors } from "./ui";

initTelegram();

const page = document.body.dataset.page;

if (page === "create") {
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

if (page === "history") {
  void loadHistory();
}
