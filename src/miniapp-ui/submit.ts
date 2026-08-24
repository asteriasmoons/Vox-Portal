// Wires the form's submit event: validate → gather attachments → POST /api/submit.
import { requireEl } from "./dom";
import { readForm, validate } from "./form";
import { attachments, hasPending } from "./attachments";
import { clearErrors, showFieldErrors, showTopError, showSuccess } from "./ui";
import { submitReport } from "./api";

export function resetForm(): void {
  const form = requireEl<HTMLFormElement>("#form");
  const btn = requireEl<HTMLButtonElement>("#submit-btn");
  const success = requireEl("#success");
  form.reset();
  form.classList.remove("hidden");
  success.classList.add("hidden");
  btn.disabled = false;
  btn.textContent = "Submit report";
}

export function initSubmit(): void {
  const form = requireEl<HTMLFormElement>("#form");
  const btn = requireEl<HTMLButtonElement>("#submit-btn");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearErrors();

    const data = readForm();
    const errs = validate(data);
    if (errs.length) { showFieldErrors(errs); return; }
    if (hasPending()) { showTopError("Please wait for attachments to finish uploading."); return; }

    data.attachments = attachments();
    data.submit_token =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : String(Date.now());

    btn.disabled = true;
    btn.textContent = "Submitting…";
    try {
      const out = await submitReport(data);
      showSuccess(out.public_id, out.telegram, out.github);
    } catch {
      btn.disabled = false;
      btn.textContent = "Submit report";
      showTopError("Couldn't submit your report. Please try again.");
    }
  });
}
