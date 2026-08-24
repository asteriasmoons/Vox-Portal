import type { CategoryId, SeverityId, StatusId, FrequencyId } from "../bugs/constants";

export interface BugRow {
  id: number;
  public_number: number;
  reporter_tg_id: number;
  reporter_username: string | null;
  reporter_display_name: string | null;
  app: string;
  app_version: string | null;
  app_build: string | null;
  device: string | null;
  os: string | null;
  category: CategoryId;
  severity: SeverityId;
  title: string;
  actual_behavior: string;
  expected_behavior: string | null;
  reproduction_steps: string | null;
  frequency: FrequencyId | null;
  notes: string | null;
  status: StatusId;
  fixed_in_version: string | null;
  fixed_in_build: string | null;
  channel_message_id: number | null;
  discussion_message_id: number | null;
  discussion_thread_id: number | null;
  // GitHub Issue cross-reference — populated by src/github/service.ts.
  github_repo: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_status: string | null;
  github_error: string | null;
  github_created_at: number | null;
  duplicate_of_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface AttachmentRow {
  id: number;
  bug_id: number;
  kind: "photo" | "video" | "document" | "animation";
  telegram_file_id: string | null;
  r2_key: string | null;
  mime_type: string | null;
  file_name: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  posted_message_id: number | null;
  created_at: number;
}

export interface StatusHistoryRow {
  id: number;
  bug_id: number;
  from_status: StatusId | null;
  to_status: StatusId;
  changed_by: number | null;
  note: string | null;
  created_at: number;
}

// Input shape for creating a bug (before we assign a public number).
export interface NewBugInput {
  reporter_tg_id: number;
  reporter_username?: string | null;
  reporter_display_name?: string | null;
  app: string;
  app_version?: string | null;
  app_build?: string | null;
  device?: string | null;
  os?: string | null;
  category: CategoryId;
  severity: SeverityId;
  title: string;
  actual_behavior: string;
  expected_behavior?: string | null;
  reproduction_steps?: string | null;
  frequency?: FrequencyId | null;
  notes?: string | null;
}

export interface NewAttachmentInput {
  bug_id: number;
  kind: AttachmentRow["kind"];
  telegram_file_id?: string | null;
  r2_key?: string | null;
  mime_type?: string | null;
  file_name?: string | null;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
}
