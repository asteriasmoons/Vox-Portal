// Populates app/category/severity/frequency selects and wires hints.
import { requireEl } from "./dom";
import { getConfig } from "./api";

export async function loadFormConfig(): Promise<void> {
  const app = requireEl<HTMLSelectElement>("#app-select");
  const cat = requireEl<HTMLSelectElement>("#category-select");
  const sev = requireEl<HTMLSelectElement>("#severity-select");
  const freq = requireEl<HTMLSelectElement>("#frequency-select");
  const catHint = requireEl("#category-hint");
  const sevHint = requireEl("#severity-hint");

  const cfg = await getConfig();

  app.innerHTML = '<option value="">Choose an app…</option>';
  cat.innerHTML = '<option value="">Choose a category…</option>';
  sev.innerHTML = '<option value="">Choose a severity…</option>';
  freq.innerHTML = '<option value="">Not specified</option>';

  for (const name of cfg.apps) addOption(app, name, name);
  for (const c of cfg.categories) addOption(cat, c.id, c.label, c.hint);
  for (const s of cfg.severities) addOption(sev, s.id, s.label, s.hint);
  for (const f of cfg.frequencies) addOption(freq, f.id, f.label);

  const wireHint = (sel: HTMLSelectElement, hint: HTMLElement) => {
    const update = () => {
      hint.textContent = sel.selectedOptions[0]?.dataset.hint ?? "";
    };
    sel.addEventListener("change", update);
    update();
  };

  wireHint(cat, catHint);
  wireHint(sev, sevHint);
}

function addOption(sel: HTMLSelectElement, value: string, label: string, hint?: string): void {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  if (hint) opt.dataset.hint = hint;
  sel.appendChild(opt);
}
