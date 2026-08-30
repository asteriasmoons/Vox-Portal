// Populates bug-report app/type/severity/reproducibility controls and
// app-specific feature/area pickers.
import { requireEl } from "./dom";
import { getConfig, type BugAppConfig, type ConfigOption } from "./api";

export async function loadFormConfig(): Promise<void> {
  const app = requireEl<HTMLSelectElement>("#app-select");
  const cat = requireEl<HTMLSelectElement>("#category-select");
  const catHidden = requireEl<HTMLInputElement>("#category-hidden");
  const sev = requireEl<HTMLInputElement>("#severity-select");
  const sevTiles = requireEl<HTMLElement>("#severity-tiles");
  const freq = requireEl<HTMLSelectElement>("#frequency-select");
  const feature = requireEl<HTMLSelectElement>("#feature-select");
  const areas = requireEl<HTMLElement>("#affected-areas");
  const catHint = requireEl("#category-hint");
  const sevHint = requireEl("#severity-hint");
  const featureHint = requireEl("#feature-hint");

  const cfg = await getConfig();
  const appConfigs = new Map(cfg.bug_apps.map((a) => [a.id, a]));

  app.innerHTML = '<option value="">Choose an app…</option>';
  cat.innerHTML = '<option value="">Choose a bug type…</option>';
  sev.value = "";
  sevTiles.innerHTML = "";
  freq.innerHTML = '<option value="">Choose reproducibility…</option>';
  feature.innerHTML = '<option value="">Choose an app first…</option>';
  areas.innerHTML = '<p class="hint">Choose an app first.</p>';

  for (const name of cfg.apps) addOption(app, name, name);
  for (const c of cfg.categories) addOption(cat, c.id, c.label, c.hint);
  for (const [index, s] of cfg.severities.entries()) addSeverityTile(sevTiles, sev, sevHint, s, index + 1);
  for (const f of cfg.frequencies) addOption(freq, f.id, f.label);

  const wireHint = (sel: HTMLSelectElement, hint: HTMLElement) => {
    const update = () => {
      hint.textContent = sel.selectedOptions[0]?.dataset.hint ?? "";
    };
    sel.addEventListener("change", update);
    update();
  };

  wireHint(cat, catHint);
  cat.addEventListener("change", () => { catHidden.value = cat.value; });
  catHidden.value = cat.value;
  app.addEventListener("change", () => updateAppScopedControls(appConfigs.get(app.value), feature, areas, featureHint));
  updateAppScopedControls(appConfigs.get(app.value), feature, areas, featureHint);
}

function addOption(sel: HTMLSelectElement, value: string, label: string, hint?: string): void {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  if (hint) opt.dataset.hint = hint;
  sel.appendChild(opt);
}

function addSeverityTile(
  host: HTMLElement,
  hidden: HTMLInputElement,
  hint: HTMLElement,
  option: ConfigOption,
  number: number,
): void {
  const label = document.createElement("label");
  label.className = "severity-tile";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "severity-choice";
  input.value = option.id;
  const num = document.createElement("span");
  num.className = "severity-number";
  num.textContent = String(number);
  const text = document.createElement("span");
  text.className = "severity-name";
  text.textContent = option.label;
  label.append(input, num, text);
  input.addEventListener("change", () => {
    hidden.value = input.value;
    hint.textContent = option.hint ?? "";
  });
  host.appendChild(label);
}

function updateAppScopedControls(
  cfg: BugAppConfig | undefined,
  feature: HTMLSelectElement,
  areas: HTMLElement,
  featureHint: HTMLElement,
): void {
  feature.innerHTML = "";
  areas.innerHTML = "";
  featureHint.textContent = "";
  if (!cfg) {
    addOption(feature, "", "Choose an app first…");
    areas.innerHTML = '<p class="hint">Choose an app first.</p>';
    return;
  }
  addOption(feature, "", "Choose a feature…");
  for (const f of cfg.features) addOption(feature, f.id, f.label, f.hint);
  feature.addEventListener("change", () => {
    featureHint.textContent = feature.selectedOptions[0]?.dataset.hint ?? "";
  }, { once: true });
  feature.onchange = () => {
    featureHint.textContent = feature.selectedOptions[0]?.dataset.hint ?? "";
  };

  for (const area of cfg.affected_areas) {
    const label = document.createElement("label");
    label.className = "check-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "affected_areas";
    input.value = area.id;
    const span = document.createElement("span");
    span.textContent = area.label;
    if (area.hint) label.title = area.hint;
    label.append(input, span);
    areas.appendChild(label);
  }
}
