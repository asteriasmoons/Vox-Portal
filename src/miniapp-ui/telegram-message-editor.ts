interface TelegramMessageDoc {
  version: 1;
  html: string;
}

type InlineCommand = "bold" | "italic" | "underline" | "strikeThrough";

interface EditorValue {
  text: string;
  html: string;
  doc: string;
}

const TOOLBAR_ITEMS = [
  ["bold", "B", "Bold"],
  ["italic", "I", "Italic"],
  ["underline", "U", "Underline"],
  ["strikeThrough", "S", "Strikethrough"],
  ["spoiler", "Spoiler", "Spoiler"],
  ["code", "Code", "Inline code"],
  ["pre", "Pre", "Code block"],
  ["quote", "Quote", "Blockquote"],
  ["expandableQuote", "More", "Expandable blockquote"],
  ["divider", "---", "Divider"],
  ["link", "Link", "Link"],
] as const;

export class TelegramMessageEditor {
  private root: HTMLElement;
  private editable!: HTMLDivElement;
  private toolbar!: HTMLDivElement;
  private linkPanel!: HTMLDivElement;
  private linkInput!: HTMLInputElement;
  private savedRange: Range | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
  }

  setValue(input: { text?: string | null; html?: string | null; doc?: string | null }): void {
    const docHtml = parseDocHtml(input.doc);
    const html = docHtml || input.html || "";
    if (html.trim()) {
      this.editable.innerHTML = editorHtmlFromTelegramHtml(html);
    } else {
      this.editable.textContent = input.text ?? "";
    }
    this.ensureContent();
    this.resetPendingInlineFormattingIfEmpty();
    this.updateToolbarState();
  }

  clear(): void {
    this.editable.innerHTML = "";
    this.ensureContent();
    this.resetPendingInlineFormattingIfEmpty();
    this.updateToolbarState();
  }

  getValue(): EditorValue {
    const html = serializeTelegramHtml(this.editable).trim();
    const text = serializeEditorText(this.editable).replace(/\u200b/g, "").trim();
    const doc: TelegramMessageDoc = {
      version: 1,
      html: sanitizeEditorHtml(this.editable),
    };
    return { text, html, doc: JSON.stringify(doc) };
  }

  focus(): void {
    this.editable.focus();
  }

  private build(): void {
    this.root.classList.add("tg-editor-shell");
    this.toolbar = document.createElement("div");
    this.toolbar.className = "tg-editor-toolbar";
    this.toolbar.setAttribute("role", "toolbar");

    for (const [action, text, title] of TOOLBAR_ITEMS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tg-editor-tool";
      btn.dataset.action = action;
      btn.textContent = text;
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.rememberSelection();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this.applyAction(action);
      });
      this.toolbar.appendChild(btn);
    }

    this.linkPanel = document.createElement("div");
    this.linkPanel.className = "tg-editor-link-panel hidden";
    this.linkInput = document.createElement("input");
    this.linkInput.type = "url";
    this.linkInput.placeholder = "https://example.com";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Apply";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    apply.addEventListener("click", () => this.applyLink());
    remove.addEventListener("click", () => this.removeLink());
    close.addEventListener("click", () => this.hideLinkPanel());
    this.linkPanel.append(this.linkInput, apply, remove, close);

    this.editable = document.createElement("div");
    this.editable.className = "tg-editor-surface";
    this.editable.contentEditable = "true";
    this.editable.spellcheck = true;
    this.editable.dataset.placeholder = this.root.dataset.placeholder ?? "Message";
    this.editable.addEventListener("input", () => {
      this.ensureContent();
      this.updateToolbarState();
    });
    this.editable.addEventListener("keyup", () => this.updateToolbarState());
    this.editable.addEventListener("mouseup", () => this.updateToolbarState());
    this.editable.addEventListener("focus", () => this.updateToolbarState());
    this.editable.addEventListener("focusin", () => this.resetPendingInlineFormattingIfEmpty());
    this.editable.addEventListener("paste", (e) => this.handlePaste(e));

    this.root.replaceChildren(this.toolbar, this.linkPanel, this.editable);
    this.ensureContent();
  }

  private applyAction(action: string): void {
    this.restoreSelection();
    this.editable.focus();
    if (action === "bold" || action === "italic" || action === "underline" || action === "strikeThrough") {
      document.execCommand(action as InlineCommand, false);
    } else if (action === "spoiler") {
      this.toggleSpoiler();
    } else if (action === "code") {
      this.toggleInlineWrapper("code", "code");
    } else if (action === "pre") {
      this.toggleBlock("pre");
    } else if (action === "quote") {
      this.applyBlockquote(false);
    } else if (action === "expandableQuote") {
      this.applyBlockquote(true);
    } else if (action === "divider") {
      this.insertDivider();
    } else if (action === "link") {
      this.showLinkPanel();
      return;
    }
    this.ensureContent();
    this.rememberSelection();
    this.updateToolbarState();
  }

  private wrapSelection(tagName: string, attrs: Record<string, string> = {}): void {
    const range = this.currentRange();
    if (!range) return;
    const selected = range.toString();
    const el = document.createElement(tagName);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (selected) {
      el.appendChild(range.extractContents());
    } else {
      el.textContent = "\u200b";
    }
    range.insertNode(el);
    const next = document.createRange();
    next.selectNodeContents(el);
    next.collapse(false);
    this.setRange(next);
  }

  private toggleInlineWrapper(selector: string, tagName: string, attrs: Record<string, string> = {}): void {
    const existing = closestElement(this.currentRange()?.startContainer ?? null, selector, this.editable);
    if (existing) {
      this.unwrapElement(existing);
      return;
    }
    this.wrapSelection(tagName, attrs);
  }

  private toggleSpoiler(): void {
    const range = this.currentRange();
    if (!range) return;

    const selectedSpoilers = elementsIntersectingRange(this.editable, "[data-tg-spoiler]", range);
    if (selectedSpoilers.length) {
      for (const spoiler of selectedSpoilers) this.unwrapElement(spoiler);
      return;
    }

    if (range.collapsed) {
      this.wrapSelection("span", { "data-tg-spoiler": "true", class: "tg-editor-spoiler" });
      return;
    }

    const marker = document.createTextNode("");
    const fragment = range.extractContents();
    applySpoilerToTextNodes(fragment);
    fragment.appendChild(marker);
    range.insertNode(fragment);

    const next = document.createRange();
    next.setStartAfter(marker);
    next.collapse(true);
    marker.remove();
    this.setRange(next);
  }

  private unwrapElement(el: Element): void {
    const parent = el.parentNode;
    if (!parent) return;
    const marker = document.createTextNode("");
    parent.insertBefore(marker, el);
    el.replaceWith(...Array.from(el.childNodes));
    const range = document.createRange();
    range.setStartAfter(marker);
    range.collapse(true);
    marker.remove();
    this.setRange(range);
  }

  private applyBlockquote(expandable: boolean): void {
    const current = closestElement(this.currentRange()?.startContainer ?? null, "blockquote", this.editable);
    if (current) {
      const isExpandable = current.hasAttribute("data-expandable");
      if (isExpandable === expandable) {
        this.toggleBlock("div");
        return;
      }
    }
    document.execCommand("formatBlock", false, "blockquote");
    const block = closestElement(this.currentRange()?.startContainer ?? null, "blockquote", this.editable);
    if (!block) return;
    if (expandable) {
      block.setAttribute("data-expandable", "true");
      block.classList.add("tg-editor-expandable-quote");
    } else {
      block.removeAttribute("data-expandable");
      block.classList.remove("tg-editor-expandable-quote");
    }
  }

  private toggleBlock(tagName: "pre" | "div"): void {
    const current = this.currentRange()?.startContainer ?? null;
    const matching = tagName === "pre"
      ? closestElement(current, "pre", this.editable)
      : closestElement(current, "blockquote, pre", this.editable);
    document.execCommand("formatBlock", false, matching ? "div" : tagName);
  }

  private insertDivider(): void {
    const range = this.currentRange();
    if (!range) return;
    range.deleteContents();

    const divider = document.createElement("hr");
    divider.className = "tg-editor-divider";
    divider.setAttribute("data-divider", "true");

    const after = document.createElement("div");
    after.appendChild(document.createElement("br"));

    range.insertNode(after);
    range.insertNode(divider);

    const next = document.createRange();
    next.setStart(after, 0);
    next.collapse(true);
    this.setRange(next);
  }

  private showLinkPanel(): void {
    this.rememberSelection();
    const link = closestElement(this.savedRange?.startContainer ?? null, "a", this.editable) as HTMLAnchorElement | null;
    this.linkInput.value = link?.href ?? "";
    this.linkPanel.classList.remove("hidden");
    this.linkInput.focus();
  }

  private hideLinkPanel(): void {
    this.linkPanel.classList.add("hidden");
    this.editable.focus();
  }

  private applyLink(): void {
    const href = this.linkInput.value.trim();
    if (!href) {
      this.removeLink();
      return;
    }
    this.restoreSelection();
    this.editable.focus();
    document.execCommand("createLink", false, href);
    this.hideLinkPanel();
    this.updateToolbarState();
  }

  private removeLink(): void {
    this.restoreSelection();
    this.editable.focus();
    document.execCommand("unlink", false);
    this.hideLinkPanel();
    this.updateToolbarState();
  }

  private handlePaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    document.execCommand("insertText", false, text);
  }

  private ensureContent(): void {
    this.editable.classList.toggle("is-empty", !this.editable.innerText.replace(/\u200b/g, "").trim());
  }

  private updateToolbarState(): void {
    const range = this.currentRange();
    const node = range?.startContainer ?? null;
    this.setActive("bold", !!closestFormatting(node, this.editable, ["b", "strong"], isInlineBold));
    this.setActive("italic", !!closestFormatting(node, this.editable, ["i", "em"], (el) => el.style.fontStyle === "italic"));
    this.setActive("underline", !!closestFormatting(node, this.editable, ["u"], (el) => el.style.textDecorationLine.includes("underline") || el.style.textDecoration.includes("underline")));
    this.setActive("strikeThrough", !!closestFormatting(node, this.editable, ["s", "strike", "del"], (el) => el.style.textDecorationLine.includes("line-through") || el.style.textDecoration.includes("line-through")));
    this.setActive("spoiler", !!closestElement(node, "[data-tg-spoiler]", this.editable));
    this.setActive("code", !!closestElement(node, "code", this.editable));
    this.setActive("pre", !!closestElement(node, "pre", this.editable));
    this.setActive("quote", !!closestElement(node, "blockquote", this.editable));
    this.setActive("expandableQuote", !!closestElement(node, "blockquote[data-expandable]", this.editable));
    this.setActive("divider", false);
    this.setActive("link", !!closestElement(node, "a", this.editable));
  }

  private setActive(action: string, active: boolean): void {
    this.toolbar.querySelector<HTMLElement>(`[data-action="${action}"]`)?.classList.toggle("active", active);
  }

  private rememberSelection(): void {
    const range = this.currentRange();
    this.savedRange = range ? range.cloneRange() : null;
  }

  private restoreSelection(): void {
    if (!this.savedRange) return;
    this.setRange(this.savedRange);
  }

  private currentRange(): Range | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return this.editable.contains(range.commonAncestorContainer) ? range : null;
  }

  private setRange(range: Range): void {
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private resetPendingInlineFormattingIfEmpty(): void {
    if (this.editable.innerText.replace(/\u200b/g, "").trim()) return;
    try {
      for (const command of ["bold", "italic", "underline", "strikeThrough"] as const) {
        if (document.queryCommandState?.(command)) document.execCommand(command, false);
      }
    } catch {
      // Some WebViews expose execCommand but not reliable query state. Empty
      // editor content still serializes as plain text.
    }
  }
}

function parseDocHtml(doc: string | null | undefined): string {
  if (!doc) return "";
  try {
    const parsed = JSON.parse(doc) as Partial<TelegramMessageDoc>;
    return parsed.version === 1 && typeof parsed.html === "string" ? parsed.html : "";
  } catch {
    return "";
  }
}

function editorHtmlFromTelegramHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  normalizeImportedNode(template.content);
  return sanitizeFragment(template.content);
}

function normalizeImportedNode(root: ParentNode): void {
  const spoilers = Array.from(root.querySelectorAll("tg-spoiler, span.tg-spoiler"));
  for (const spoiler of spoilers) {
    const span = document.createElement("span");
    span.className = "tg-editor-spoiler";
    span.setAttribute("data-tg-spoiler", "true");
    span.append(...Array.from(spoiler.childNodes));
    spoiler.replaceWith(span);
  }
  pushSpoilersInsideBlocks(root);
  for (const quote of Array.from(root.querySelectorAll("blockquote[expandable]"))) {
    quote.setAttribute("data-expandable", "true");
    quote.classList.add("tg-editor-expandable-quote");
    quote.removeAttribute("expandable");
  }
}

function sanitizeEditorHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  removeUnsafeNodes(clone);
  return clone.innerHTML;
}

function sanitizeFragment(root: DocumentFragment): string {
  removeUnsafeNodes(root);
  const div = document.createElement("div");
  div.append(root.cloneNode(true));
  return div.innerHTML;
}

function removeUnsafeNodes(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!isAllowedEditorElement(el)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      if (!isAllowedEditorAttr(el, attr.name)) el.removeAttribute(attr.name);
    }
  }
}

function isAllowedEditorElement(el: Element): boolean {
  return ["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "SPAN", "CODE", "PRE", "BLOCKQUOTE", "A", "BR", "DIV", "P", "HR"].includes(el.tagName);
}

function isAllowedEditorAttr(el: Element, attr: string): boolean {
  if (el.tagName === "A") return attr === "href";
  if (el.tagName === "HR") return attr === "class" || attr === "data-divider";
  if (el.tagName === "SPAN") return attr === "class" || attr === "data-tg-spoiler";
  if (el.tagName === "BLOCKQUOTE") return attr === "class" || attr === "data-expandable";
  return attr === "class";
}

export function serializeTelegramHtml(root: HTMLElement): string {
  return Array.from(root.childNodes).map((node) => serializeNode(node)).join("").replace(/\u200b/g, "");
}

function serializeEditorText(root: HTMLElement): string {
  return Array.from(root.childNodes).map((node) => serializeTextNode(node)).join("");
}

function serializeTextNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "hr" && node.hasAttribute("data-divider")) return "\n---\n\n";
  const inner = Array.from(node.childNodes).map((child) => serializeTextNode(child)).join("");
  if (tag === "blockquote" || tag === "pre" || tag === "div" || tag === "p") return `${inner.trimEnd()}\n\n`;
  return inner;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  const inner = Array.from(node.childNodes).map((child) => serializeNode(child)).join("");
  if (tag === "hr" && node.hasAttribute("data-divider")) return "\n---\n\n";
  if ((tag === "div" || tag === "p") && !inner) return "\n\n";
  if (!inner && tag !== "br") return "";
  if (tag === "br") return "\n";
  if (tag === "b" || tag === "strong") return `<b>${inner}</b>`;
  if (tag === "i" || tag === "em") return `<i>${inner}</i>`;
  if (tag === "u") return `<u>${inner}</u>`;
  if (tag === "s" || tag === "strike" || tag === "del") return `<s>${inner}</s>`;
  if (tag === "span" && node.hasAttribute("data-tg-spoiler")) {
    if (hasBlockChildren(node)) return Array.from(node.childNodes).map((child) => serializeSpoilerChild(child)).join("");
    return `<tg-spoiler>${inner}</tg-spoiler>`;
  }
  if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return `<code>${inner}</code>`;
  if (tag === "pre") return `<pre>${escapeHtml(node.innerText.replace(/\u200b/g, "").trimEnd())}</pre>\n\n`;
  if (tag === "blockquote") {
    const attr = node.hasAttribute("data-expandable") ? " expandable" : "";
    return `<blockquote${attr}>${inner.trim()}</blockquote>\n\n`;
  }
  if (tag === "a") {
    const href = safeUrl(node.getAttribute("href") ?? "");
    return href ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner;
  }
  if (tag === "div" || tag === "p") return `${inner.trimEnd()}\n\n`;
  return inner;
}

function applySpoilerToTextNodes(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if ((current.textContent ?? "").replace(/\u200b/g, "").trim()) textNodes.push(current as Text);
    current = walker.nextNode();
  }
  for (const text of textNodes) {
    if (closestElement(text, "[data-tg-spoiler], pre, code", root as HTMLElement)) continue;
    const span = document.createElement("span");
    span.className = "tg-editor-spoiler";
    span.setAttribute("data-tg-spoiler", "true");
    text.replaceWith(span);
    span.appendChild(text);
  }
}

function pushSpoilersInsideBlocks(root: ParentNode): void {
  for (const spoiler of Array.from(root.querySelectorAll("[data-tg-spoiler]"))) {
    if (!hasBlockChildren(spoiler)) continue;
    const fragment = document.createDocumentFragment();
    while (spoiler.firstChild) fragment.appendChild(spoiler.firstChild);
    applySpoilerToTextNodes(fragment);
    spoiler.replaceWith(fragment);
  }
}

function hasBlockChildren(node: Element): boolean {
  return !!node.querySelector("blockquote, div, p, pre, hr");
}

function serializeSpoilerChild(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = escapeHtml(node.textContent ?? "");
    return text.trim() ? `<tg-spoiler>${text}</tg-spoiler>` : text;
  }
  if (!(node instanceof HTMLElement)) return "";
  return serializeNode(node);
}

function elementsIntersectingRange(root: HTMLElement, selector: string, range: Range): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((el) => {
    try {
      return range.intersectsNode(el);
    } catch {
      return false;
    }
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function closestElement(node: Node | null, selector: string, root: HTMLElement): Element | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof Element && current.matches(selector)) return current;
    current = current.parentNode;
  }
  return null;
}

function closestFormatting(
  node: Node | null,
  root: HTMLElement,
  tags: string[],
  matchesInlineStyle: (value: HTMLElement) => boolean,
): Element | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof HTMLElement) {
      if (tags.includes(current.tagName.toLowerCase())) return current;
      if (matchesInlineStyle(current)) return current;
    }
    current = current.parentNode;
  }
  return null;
}

function isInlineBold(el: HTMLElement): boolean {
  const weight = el.style.fontWeight;
  return weight === "bold" || Number(weight) >= 600;
}
