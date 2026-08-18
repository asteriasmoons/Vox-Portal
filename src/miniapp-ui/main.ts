// Mini App bootstrap. Entry point bundled to public/app/app.js.

import { initTelegram, INIT_DATA } from "./tg";
import { loadFormConfig } from "./config";
import { initAttachments } from "./attachments";
import { initSubmit, resetForm } from "./submit";
import { initNav, goto } from "./nav";
import { $, requireEl } from "./dom";
import { showTopError, clearErrors } from "./ui";

initTelegram();

// The reserved top strip in CSS (--safe-top) is sized to cover both the
// iOS notch AND Telegram's chips shown when the Mini App is launched
// from outside a chat — no runtime detection needed.

if (!INIT_DATA) showTopError("This form must be opened from inside Telegram.");

void loadFormConfig();
initAttachments();
initSubmit();
initNav();

// "File another" resets state and takes you back to the top of the form.
$<HTMLButtonElement>("#new-btn")?.addEventListener("click", () => {
  clearErrors();
  resetForm();
  goto("create");
});

// Structure sanity check — fail loud if the template drifts.
requireEl("#form");
