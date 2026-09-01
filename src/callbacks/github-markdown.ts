type MdNode =
  | { type: "text"; text: string }
  | { type: "element"; tag: string; attrs: Record<string, string>; children: MdNode[] };

const SELF_CLOSING = new Set(["br", "hr"]);

export function callbackEditorHtmlToGitHubMarkdown(html: string | null | undefined, fallbackText = ""): string {
  const source = html?.trim();
  if (!source) return escapeMarkdownText(fallbackText).trim();
  const nodes = parseHtml(source);
  const markdown = renderNodes(nodes, "block").replace(/\n{3,}/g, "\n\n").trim();
  return markdown || escapeMarkdownText(fallbackText).trim();
}

function parseHtml(html: string): MdNode[] {
  const root: MdNode = { type: "element", tag: "root", attrs: {}, children: [] };
  const stack: MdNode[] = [root];
  const tokenRe = /<\/?[a-zA-Z][^>]*>|[^<]+|</g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html))) {
    const token = match[0];
    const parent = stack[stack.length - 1] as Extract<MdNode, { type: "element" }>;
    if (token === "<") {
      parent.children.push({ type: "text", text: token });
      continue;
    }
    if (!token.startsWith("<")) {
      parent.children.push({ type: "text", text: decodeHtml(token) });
      continue;
    }
    if (/^<\//.test(token)) {
      const closing = tagName(token);
      while (stack.length > 1) {
        const current = stack.pop();
        if (current?.type === "element" && current.tag === closing) break;
      }
      continue;
    }
    const tag = tagName(token);
    if (!tag) continue;
    const node: MdNode = { type: "element", tag, attrs: parseAttrs(token), children: [] };
    parent.children.push(node);
    if (!SELF_CLOSING.has(tag) && !token.endsWith("/>")) stack.push(node);
  }
  return root.children;
}

function tagName(token: string): string {
  return token.replace(/^<\/?\s*/, "").match(/^([a-zA-Z0-9-]+)/)?.[1]?.toLowerCase() ?? "";
}

function parseAttrs(token: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = token.replace(/^<\s*[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  const attrRe = /([a-zA-Z0-9-:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(body))) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function renderNodes(nodes: MdNode[], context: "block" | "inline"): string {
  return nodes.map((node) => renderNode(node, context)).join("");
}

function renderNode(node: MdNode, context: "block" | "inline"): string {
  if (node.type === "text") return escapeMarkdownText(node.text);
  const tag = node.tag;
  if (tag === "br") return "\n";
  if (tag === "div" || tag === "p") return `${renderNodes(node.children, "inline").trimEnd()}\n`;
  if (tag === "b" || tag === "strong") return wrapInline("**", renderNodes(node.children, "inline"));
  if (tag === "i" || tag === "em") return wrapInline("*", renderNodes(node.children, "inline"));
  if (tag === "u" || tag === "ins") return `<ins>${renderPlainHtml(node.children)}</ins>`;
  if (tag === "s" || tag === "strike" || tag === "del") return wrapInline("~~", renderNodes(node.children, "inline"));
  if (tag === "tg-spoiler" || (tag === "span" && node.attrs["data-tg-spoiler"] === "true")) {
    const inner = renderNodes(node.children, "inline").trim();
    return inner ? `\n<details><summary>Spoiler</summary>\n\n${inner}\n\n</details>\n` : "";
  }
  if (tag === "code") return inlineCode(textContent(node.children));
  if (tag === "pre") return fencedCode(textContent(node.children));
  if (tag === "blockquote") {
    const text = renderNodes(node.children, "block").trim();
    if (!text) return "";
    return `\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n`;
  }
  if (tag === "a") {
    const href = safeMarkdownUrl(node.attrs.href ?? "");
    const label = renderNodes(node.children, "inline").trim() || escapeMarkdownText(href);
    return href ? `[${label}](${href})` : label;
  }
  if (tag === "ul" || tag === "ol") return renderList(node, tag === "ol");
  if (tag === "li") return renderNodes(node.children, "inline").trim();
  return renderNodes(node.children, context);
}

function renderList(node: Extract<MdNode, { type: "element" }>, ordered: boolean): string {
  let index = 1;
  const lines: string[] = [];
  for (const child of node.children) {
    if (child.type !== "element" || child.tag !== "li") continue;
    const text = renderNodes(child.children, "inline").trim();
    if (!text) continue;
    lines.push(`${ordered ? `${index++}.` : "-"} ${text}`);
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

function wrapInline(marker: string, value: string): string {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const body = value.slice(leading.length, value.length - trailing.length);
  return body ? `${leading}${marker}${body}${marker}${trailing}` : value;
}

function inlineCode(value: string): string {
  const ticks = longestBacktickRun(value) + 1;
  const marker = "`".repeat(Math.max(1, ticks));
  return `${marker}${value}${marker}`;
}

function fencedCode(value: string): string {
  const ticks = longestBacktickRun(value) + 1;
  const marker = "`".repeat(Math.max(3, ticks));
  return `\n${marker}\n${value.replace(/\n+$/, "")}\n${marker}\n`;
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), (m) => m[0].length));
}

function textContent(nodes: MdNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.text : textContent(node.children)).join("");
}

function renderPlainHtml(nodes: MdNode[]): string {
  return textContent(nodes)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMarkdownText(text: string): string {
  return text.split("\n").map((line) => {
    if (line.trim() === "---") return "---";
    return line
      .replace(/\\/g, "\\\\")
      .replace(/([`*_{}\[\]()#+.!|-])/g, "\\$1")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }).join("\n");
}

function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\)/g, "%29");
  } catch {
    return "";
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
