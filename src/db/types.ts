import type { CategoryId, SeverityId, StatusId, FrequencyId } from "../bugs/constants";
import type {
  BetaFeedbackTypeId,
  BetaOverallExperienceId,
  BetaStatusId,
  BetaWouldUseId,
} from "../beta/constants";

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
  // Bot API 10.3 Rich Message id inside the discussion thread.
  report_message_id: number | null;
  duplicate_of_id: number | null;
  created_at: number;
  updated_at: number;
}

// ── Feature Ideas ───────────────────────────────────────
export interface IdeaRow {
  id: number;
  public_number: number;
  reporter_tg_id: number;
  reporter_username: string | null;
  reporter_display_name: string | null;
  app: string;
  title: string;
  what_i_want: string;
  why_useful: string | null;
  how_it_works: string | null;
  where_it_belongs: string | null;
  notes: string | null;
  status: string;
  decision_reason: string | null;
  channel_message_id: number | null;
  discussion_message_id: number | null;
  discussion_thread_id: number | null;
  report_message_id: number | null;
  github_repo: string | null;
  github_discussion_id: string | null;
  github_discussion_url: string | null;
  github_comment_id: string | null;
  github_comment_url: string | null;
  github_status: string | null;
  github_error: string | null;
  github_created_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface IdeaAttachmentRow {
  id: number;
  idea_id: number;
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

export interface NewIdeaInput {
  reporter_tg_id: number;
  reporter_username?: string | null;
  reporter_display_name?: string | null;
  app: string;
  title: string;
  what_i_want: string;
  why_useful?: string | null;
  how_it_works?: string | null;
  where_it_belongs?: string | null;
  notes?: string | null;
}

// ── Beta Feedback ──────────────────────────────────────
export interface BetaFeedbackRow {
  id: number;
  public_number: number;
  reporter_tg_id: number;
  reporter_username: string | null;
  reporter_display_name: string | null;
  app: string;
  app_version: string | null;
  app_build: string | null;
  testing: string;
  feedback_types: string;
  what_did_you_do: string;
  what_happened: string;
  expected_behavior: string | null;
  overall_experience: BetaOverallExperienceId;
  would_use_feature: BetaWouldUseId;
  changes: string | null;
  notes: string | null;
  status: BetaStatusId;
  channel_message_id: number | null;
  discussion_message_id: number | null;
  discussion_thread_id: number | null;
  report_message_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface BetaFeedbackAttachmentRow {
  id: number;
  beta_feedback_id: number;
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

export interface NewBetaFeedbackInput {
  reporter_tg_id: number;
  reporter_username?: string | null;
  reporter_display_name?: string | null;
  app: string;
  app_version?: string | null;
  app_build?: string | null;
  testing: string;
  feedback_types: BetaFeedbackTypeId[];
  what_did_you_do: string;
  what_happened: string;
  expected_behavior?: string | null;
  overall_experience: BetaOverallExperienceId;
  would_use_feature: BetaWouldUseId;
  changes?: string | null;
  notes?: string | null;
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
