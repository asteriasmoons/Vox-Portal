// Thin wrapper around fetch() so the Mini App talks to the Worker
// with the initData header attached uniformly.
import { INIT_DATA } from "./tg";

const H_INIT = "x-telegram-init-data";

export interface ConfigOption { id: string; label: string; hint?: string }
export interface ConfigResponse {
  ok: true;
  apps: string[];
  categories: ConfigOption[];
  severities: ConfigOption[];
  frequencies: ConfigOption[];
  beta_feedback_types: ConfigOption[];
  beta_overall_experiences: ConfigOption[];
  beta_would_use_options: ConfigOption[];
}

export interface UploadResponse {
  ok: true;
  key: string;
  mime: string;
  name: string;
  size: number;
}

export interface SubmitAttachment { key: string; name: string; mime: string; size?: number }
export interface SubmitPayload {
  app: string;
  app_version?: string;
  app_build?: string;
  device?: string;
  os?: string;
  category: string;
  severity: string;
  title: string;
  actual_behavior: string;
  expected_behavior?: string;
  reproduction_steps?: string;
  frequency?: string;
  notes?: string;
  attachments?: SubmitAttachment[];
  submit_token?: string;
}
export type GitHubResult =
  | { status: "created"; issue_number: number; issue_url: string; repo: string }
  | { status: "skipped_no_mapping"; reason: string | null }
  | { status: "skipped_disabled"; reason: string | null }
  | { status: "failed"; reason: string | null }
  | { status: "not_attempted" };

export interface SubmitResponse {
  ok: true;
  public_id: string;
  id: number;
  telegram: { status: "sent" };
  github: GitHubResult;
}

export async function getConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("config");
  const data = (await res.json()) as ConfigResponse & { ok: boolean };
  if (!data.ok) throw new Error("config");
  return data;
}

export async function uploadFile(file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { [H_INIT]: INIT_DATA },
    body: fd,
  });
  const data = (await res.json().catch(() => ({}))) as UploadResponse & { ok: boolean; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? "upload");
  return data;
}

export async function submitReport(payload: SubmitPayload): Promise<SubmitResponse> {
  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", [H_INIT]: INIT_DATA },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as SubmitResponse & { ok: boolean; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? "submit");
  return data;
}
