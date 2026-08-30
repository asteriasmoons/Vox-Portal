// Form reader + client-side validator. The Worker re-validates authoritatively.
import { requireEl } from "./dom";
import type { SubmitPayload } from "./api";

export function readForm(): SubmitPayload {
  const form = requireEl<HTMLFormElement>("#form");
  const fd = new FormData(form);
  const obj: Record<string, string> = {};
  for (const [k, v] of fd.entries()) obj[k] = typeof v === "string" ? v : "";
  return {
    ...obj,
    affected_areas: fd.getAll("affected_areas").filter((v): v is string => typeof v === "string"),
  } as unknown as SubmitPayload;
}

export function validate(d: SubmitPayload): [string, string][] {
  const errs: [string, string][] = [];
  if (!nonEmpty(d.app))             errs.push(["app", "Required"]);
  if (!d.bug_type)                  errs.push(["bug_type", "Required"]);
  if (!nonEmpty(d.app_version))     errs.push(["app_version", "Required"]);
  if (!nonEmpty(d.app_build))       errs.push(["app_build", "Required"]);
  if (!nonEmpty(d.device))          errs.push(["device", "Required"]);
  if (!nonEmpty(d.os))              errs.push(["os", "Required"]);
  if (!nonEmpty(d.feature))         errs.push(["feature", "Required"]);
  if (!d.affected_areas?.length)    errs.push(["affected_areas", "Required"]);
  if (!d.severity)                  errs.push(["severity", "Required"]);
  if (!nonEmpty(d.reproduction_steps)) errs.push(["reproduction_steps", "Required"]);
  if (!d.frequency)                 errs.push(["frequency", "Required"]);
  if (!nonEmpty(d.expected_behavior)) errs.push(["expected_behavior", "Required"]);
  if (!nonEmpty(d.actual_behavior)) errs.push(["actual_behavior", "Required"]);
  return errs;
}

function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}
