// Small UI helpers: top-of-form error banner, field errors, success view.
import { $, $$, requireEl } from "./dom";
import { haptic } from "./tg";

export function clearErrors(): void {
  $$(".field-error").forEach((n) => n.remove());
  $$(".top-error").forEach((n) => n.remove());
}

export function showTopError(msg: string): void {
  const form = $("#form");
  if (!form) return;
  $$(".top-error").forEach((n) => n.remove());
  const d = document.createElement("div");
  d.className = "top-error";
  d.textContent = msg;
  form.parentNode!.insertBefore(d, form);
}

export function showFieldErrors(errs: [string, string][]): void {
  const form = requireEl<HTMLFormElement>("#form");
  for (const [name, msg] of errs) {
    const el = form.querySelector<HTMLElement>(`[name="${name}"]`);
    if (!el) continue;
    const label = (el.closest("label") ?? el.parentNode) as HTMLElement;
    const s = document.createElement("div");
    s.className = "field-error";
    s.textContent = msg;
    label.appendChild(s);
  }
  showTopError("Please fix the highlighted fields.");
}

export function showSuccess(publicId: string): void {
  requireEl("#success-id").textContent = publicId;
  requireEl("#form").classList.add("hidden");
  requireEl("#success").classList.remove("hidden");
  haptic("success");
}
