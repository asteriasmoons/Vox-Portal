// Populates category / severity / frequency selects from /api/config
// and wires the small "hint" line under category/severity.
import { requireEl } from "./dom";
import { getConfig } from "./api";
import { showTopError } from "./ui";

export async function loadFormConfig(): Promise<void> {
  const appSelect = requireEl<HTMLSelectElement>("#app-select");
  const catSelect = requireEl<HTMLSelectElement>("#category-select");
  const sevSelect = requireEl<HTMLSelectElement>("#severity-select");
  const freqSelect = requireEl<HTMLSelectElement>("#frequency-select");
  const catHint = requireEl("#category-hint");
  const sevHint = requireEl("#severity-hint");

  let cfg;
  try {
    cfg = await getConfig();
  } catch {
    showTopError("Couldn't load the form options. Please close and reopen.");
    return;
  }

  for (const name of cfg.apps) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    appSelect.appendChild(opt);
  }
  for (const c of cfg.categories) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label;
    if (c.hint) opt.dataset.hint = c.hint;
    catSelect.appendChild(opt);
  }
  for (const s of cfg.severities) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.hint) opt.dataset.hint = s.hint;
    sevSelect.appendChild(opt);
  }
  for (const f of cfg.frequencies) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    freqSelect.appendChild(opt);
  }

  const wireHint = (sel: HTMLSelectElement, hint: HTMLElement) => {
    const upd = () => {
      const opt = sel.selectedOptions[0];
      hint.textContent = opt?.dataset.hint ?? "";
    };
    sel.addEventListener("change", upd);
    upd();
  };
  wireHint(catSelect, catHint);
  wireHint(sevSelect, sevHint);
}
