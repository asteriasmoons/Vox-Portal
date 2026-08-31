export function initTapToDismissTextFields(): void {
  const syncTextFieldFocus = () => {
    document.body.classList.toggle("text-field-focused", isEditableTextField(document.activeElement));
  };

  document.addEventListener("focusin", syncTextFieldFocus);
  document.addEventListener("focusout", () => {
    window.setTimeout(syncTextFieldFocus, 0);
  });

  document.addEventListener("click", (ev) => {
    const active = document.activeElement;
    if (!isEditableTextField(active)) return;

    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (isEditableTextField(target)) return;
    if (target.closest("label")?.contains(active)) return;

    active.blur();
    syncTextFieldFocus();
  }, { passive: true });
}

function isEditableTextField(value: unknown): value is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (value instanceof HTMLTextAreaElement) return true;
  if (value instanceof HTMLElement && value.isContentEditable) return true;
  if (!(value instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "file", "hidden", "radio", "reset", "submit"].includes(value.type);
}
