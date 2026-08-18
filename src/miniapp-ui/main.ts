// Mini App bootstrap. Entry point bundled to public/app/app.js.
import { initTelegram, closeMiniApp } from "./tg";
import { loadFormConfig } from "./config";
import { initAttachments } from "./attachments";
import { initSubmit } from "./submit";
import { $, requireEl } from "./dom";
import { showTopError } from "./ui";
import { INIT_DATA } from "./tg";

initTelegram();

if (!INIT_DATA) {
  showTopError("This form must be opened from inside Telegram.");
}

void loadFormConfig();
initAttachments();
initSubmit();

const closeBtn = $<HTMLButtonElement>("#close-btn");
closeBtn?.addEventListener("click", () => closeMiniApp());

// A hidden self-check: fail loud if a required element is missing so we
// catch template drift during dev instead of silently mis-wiring.
requireEl("#form");
