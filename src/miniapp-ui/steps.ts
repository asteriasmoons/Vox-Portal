import { requireEl } from "./dom";

export function initSteps(): void {
  const list = requireEl<HTMLElement>("#steps-list");
  const hidden = requireEl<HTMLInputElement>("#reproduction-steps");

  const sync = () => {
    const values = Array.from(list.querySelectorAll<HTMLTextAreaElement>(".step-input"))
      .map((el) => el.value.trim())
      .filter(Boolean);
    hidden.value = values.map((text, index) => `${index + 1}. ${text}`).join("\n");
  };

  const addStep = (value = "") => {
    const row = document.createElement("div");
    row.className = "step-row";

    const textarea = document.createElement("textarea");
    textarea.className = "step-input";
    textarea.rows = 2;
    textarea.placeholder = `Step ${list.children.length + 1}`;
    textarea.value = value;
    textarea.addEventListener("input", sync);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "step-add";
    add.setAttribute("aria-label", "Add another step");
    add.innerHTML = '<img src="/icons/create.svg" alt="" />';
    add.addEventListener("click", () => {
      addStep();
      const inputs = list.querySelectorAll<HTMLTextAreaElement>(".step-input");
      inputs[inputs.length - 1]?.focus();
    });

    row.append(textarea, add);
    list.appendChild(row);
    sync();
  };

  addStep();
}
