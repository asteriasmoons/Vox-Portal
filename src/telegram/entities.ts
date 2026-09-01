import type { TelegramMessageEntity } from "./api";
import { esc } from "../util/html";

interface EntitySpan extends TelegramMessageEntity {
  end: number;
}

export function telegramEntitiesToHtml(
  text: string,
  entities: readonly TelegramMessageEntity[] | null | undefined,
): string {
  const spans = normalizeEntities(entities, text.length);
  return renderRange(text, spans, 0, text.length);
}

export function telegramEntitiesSliceToHtml(
  text: string,
  entities: readonly TelegramMessageEntity[] | null | undefined,
  start: number,
  end = text.length,
): string {
  const from = clamp(start, 0, text.length);
  const to = clamp(end, from, text.length);
  const slice = text.slice(from, to);
  const spans = normalizeEntities(entities, text.length)
    .filter((entity) => entity.offset < to && entity.end > from)
    .map((entity) => ({
      ...entity,
      offset: clamp(entity.offset - from, 0, slice.length),
      length: clamp(entity.end - from, 0, slice.length) - clamp(entity.offset - from, 0, slice.length),
      end: clamp(entity.end - from, 0, slice.length),
    }))
    .filter((entity) => entity.length > 0);
  return renderRange(slice, spans, 0, slice.length);
}

function normalizeEntities(
  entities: readonly TelegramMessageEntity[] | null | undefined,
  textLength: number,
): EntitySpan[] {
  return (entities ?? [])
    .filter((entity) => entity.type !== "bot_command")
    .map((entity) => ({
      ...entity,
      offset: clamp(entity.offset, 0, textLength),
      length: clamp(entity.length, 0, textLength),
      end: clamp(entity.offset + entity.length, 0, textLength),
    }))
    .filter((entity) => entity.end > entity.offset)
    .sort((a, b) => a.offset - b.offset || b.end - a.end);
}

function renderRange(text: string, entities: readonly EntitySpan[], start: number, end: number): string {
  let out = "";
  let cursor = start;

  while (cursor < end) {
    const next = entities.find((entity) => entity.offset >= cursor && entity.offset < end && entity.end <= end);
    if (!next) {
      out += esc(text.slice(cursor, end));
      break;
    }

    if (next.offset > cursor) out += esc(text.slice(cursor, next.offset));
    const children = entities.filter((entity) =>
      entity !== next &&
      entity.offset >= next.offset &&
      entity.end <= next.end
    );
    const inner = renderRange(text, children, next.offset, next.end);
    out += wrapEntity(next, inner, text.slice(next.offset, next.end));
    cursor = next.end;
  }

  return out;
}

function wrapEntity(entity: EntitySpan, inner: string, rawText: string): string {
  switch (entity.type) {
    case "bold":
      return `<b>${inner}</b>`;
    case "italic":
      return `<i>${inner}</i>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "strikethrough":
      return `<s>${inner}</s>`;
    case "spoiler":
      return `<tg-spoiler>${inner}</tg-spoiler>`;
    case "code":
      return `<code>${esc(rawText)}</code>`;
    case "pre":
      return entity.language
        ? `<pre><code class="language-${escAttr(entity.language)}">${esc(rawText)}</code></pre>`
        : `<pre>${esc(rawText)}</pre>`;
    case "blockquote":
      return `<blockquote>${inner}</blockquote>`;
    case "expandable_blockquote":
      return `<blockquote expandable>${inner}</blockquote>`;
    case "text_link":
      return entity.url ? `<a href="${escAttr(entity.url)}">${inner}</a>` : inner;
    default:
      return inner;
  }
}

function escAttr(value: string): string {
  return esc(value).replace(/"/g, "&quot;");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
