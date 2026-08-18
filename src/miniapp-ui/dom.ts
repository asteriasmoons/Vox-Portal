// Tiny DOM helpers used by every UI module.

export function $<T extends Element = HTMLElement>(sel: string, root?: ParentNode): T | null {
  return (root ?? document).querySelector<T>(sel);
}

export function $$<T extends Element = HTMLElement>(sel: string, root?: ParentNode): T[] {
  return Array.from((root ?? document).querySelectorAll<T>(sel));
}

export function requireEl<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
