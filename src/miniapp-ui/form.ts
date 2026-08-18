// Form reader + client-side validator. The Worker re-validates authoritatively.
import { requireEl } from "./dom";
import type { SubmitPayload } from "./api";

export function readForm(): SubmitPayload {
  const form = requireEl<HTMLFormElement>("#form");
  const fd = new FormData(form);
  const obj: Record<string, string> = {};
  for (const [k, v] of fd.entries()) obj[k] = typeof v === "string" ? v : "";
  return obj as unknown as SubmitPayload;
}

export function validate(d: SubmitPayload): [string, string][] {
  const errs: [string, string][] = [];
  if (!nonEmpty(d.app))             errs.push(["app", "Required"]);
  if (!d.category)                  errs.push(["category", "Required"]);
  if (!d.severity)                  errs.push(["severity", "Required"]);
  if (!nonEmpty(d.title))           errs.push(["title", "Required"]);
  if (!nonEmpty(d.actual_behavior)) errs.push(["actual_behavior", "Required"]);
  return errs;
}

function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}
