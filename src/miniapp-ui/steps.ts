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

  const resizeStep = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 46), 120)}px`;
  };

  const addStep = (value = "") => {
    const row = document.createElement("div");
    row.className = "step-row";

    const textarea = document.createElement("textarea");
    textarea.className = "step-input";
    textarea.rows = 1;
    textarea.placeholder = `Step ${list.children.length + 1}`;
    textarea.value = value;
    textarea.addEventListener("input", () => {
      resizeStep(textarea);
      sync();
    });
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
    resizeStep(textarea);
    sync();
  };

  addStep();
}
