-- Vox Bugs Bot — D1 schema
-- Safe to run multiple times.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bugs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  public_number         INTEGER NOT NULL UNIQUE,           -- monotonic, drives BUG-####
  reporter_tg_id        INTEGER NOT NULL,
  reporter_username     TEXT,
  reporter_display_name TEXT,
  app                   TEXT NOT NULL,
  app_version           TEXT,
  app_build             TEXT,
  device                TEXT,
  os                    TEXT,
  category              TEXT NOT NULL,
  bug_type              TEXT,
  feature               TEXT,
  affected_areas        TEXT,
  severity              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  actual_behavior       TEXT NOT NULL,
  expected_behavior     TEXT,
  reproduction_steps    TEXT,
  frequency             TEXT,
  notes                 TEXT,
  status                TEXT NOT NULL DEFAULT 'new',
  fixed_in_version      TEXT,
  fixed_in_build        TEXT,

  -- Telegram linkage. channel_message_id is the ticket message in the channel.
  -- discussion_message_id is the AUTOMIRRORED copy Telegram creates in the linked
  -- discussion group; that message's message_thread_id is the comment thread id
  -- and is what we reply_to when posting the full report / attachments.
  channel_message_id       INTEGER,
  discussion_message_id    INTEGER,
  discussion_thread_id     INTEGER,

  -- GitHub Issue cross-reference. Populated by src/github/service.ts.
  -- `github_status` values: 'created' | 'failed' | 'skipped_no_mapping' | 'skipped_disabled'
  github_repo           TEXT,
  github_issue_number   INTEGER,
  github_issue_url      TEXT,
  github_issue_id       INTEGER,
  github_issue_node_id  TEXT,
  github_sub_issue_number  INTEGER,
  github_sub_issue_id      INTEGER,
  github_sub_issue_node_id TEXT,
  github_sub_issue_url     TEXT,
  github_parent_issue_number INTEGER,
  github_parent_issue_url    TEXT,
  github_status         TEXT,
  github_error          TEXT,
  github_created_at     INTEGER,

  -- Bot API 10.3 Rich Message id inside the discussion thread. Live-updated
  -- via editMessageText(rich_message) on every state change.
  report_message_id     INTEGER,

  duplicate_of_id       INTEGER REFERENCES bugs(id) ON DELETE SET NULL,

  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_bugs_github_issue ON bugs(github_issue_number);
CREATE INDEX IF NOT EXISTS idx_bugs_github_sub_issue ON bugs(github_sub_issue_number);

-- One row per logical GitHub management action that has been synced.
-- action_key is `<bug_id>:<verb>[:<version>]`; UNIQUE prevents retry / replay
-- from double-posting comments or double-closing an issue.
CREATE TABLE IF NOT EXISTS github_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id      INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  action_key  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_github_actions_bug ON github_actions(bug_id);

CREATE INDEX IF NOT EXISTS idx_bugs_reporter  ON bugs(reporter_tg_id);
CREATE INDEX IF NOT EXISTS idx_bugs_status    ON bugs(status);
CREATE INDEX IF NOT EXISTS idx_bugs_duplicate ON bugs(duplicate_of_id);

-- Sequence table for atomic public BUG-#### generation.
-- We UPDATE ... RETURNING inside a transaction so two simultaneous submissions
-- can never receive the same number.
CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO sequences (name, value) VALUES ('bug', 0);

CREATE TABLE IF NOT EXISTS attachments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id         INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,        -- 'photo' | 'video' | 'document' | 'animation'
  telegram_file_id TEXT,               -- if forwarded from Telegram
  r2_key         TEXT,                 -- if uploaded via Mini App
  mime_type      TEXT,
  file_name      TEXT,
  size_bytes     INTEGER,
  width          INTEGER,
  height         INTEGER,
  posted_message_id INTEGER,           -- discussion-thread message id after relay
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_attachments_bug ON attachments(bug_id);

CREATE TABLE IF NOT EXISTS status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id      INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_by  INTEGER,                 -- Telegram user id of admin
  note        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_status_history_bug ON status_history(bug_id);

-- Idempotency for Telegram webhook updates (avoid double-processing on retries).
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id  INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Beta Feedback submissions. Mirrors the ideas table shape: independent
-- public numbering, Telegram linkage, attachments, and status history.
CREATE TABLE IF NOT EXISTS beta_feedback (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  public_number            INTEGER NOT NULL UNIQUE,
  reporter_tg_id           INTEGER NOT NULL,
  reporter_username        TEXT,
  reporter_display_name    TEXT,

  app                      TEXT NOT NULL,
  app_version              TEXT,
  app_build                TEXT,
  testing                  TEXT NOT NULL,
  feedback_types           TEXT NOT NULL,
  what_did_you_do          TEXT NOT NULL,
  what_happened            TEXT NOT NULL,
  expected_behavior        TEXT,
  overall_experience       TEXT NOT NULL,
  would_use_feature        TEXT NOT NULL,
  changes                  TEXT,
  notes                    TEXT,

  status                   TEXT NOT NULL DEFAULT 'new',

  channel_message_id       INTEGER,
  discussion_message_id    INTEGER,
  discussion_thread_id     INTEGER,
  report_message_id        INTEGER,

  github_repo              TEXT,
  github_discussion_id     TEXT,
  github_discussion_url    TEXT,
  github_comment_id        TEXT,
  github_comment_url       TEXT,
  github_status            TEXT,
  github_error             TEXT,
  github_created_at        INTEGER,

  last_edited_at           INTEGER,

  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_reporter ON beta_feedback(reporter_tg_id);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_status   ON beta_feedback(status);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_app      ON beta_feedback(app);

INSERT OR IGNORE INTO sequences (name, value) VALUES ('beta', 0);

CREATE TABLE IF NOT EXISTS beta_feedback_attachments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  beta_feedback_id INTEGER NOT NULL REFERENCES beta_feedback(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  telegram_file_id TEXT,
  r2_key         TEXT,
  mime_type      TEXT,
  file_name      TEXT,
  size_bytes     INTEGER,
  width          INTEGER,
  height         INTEGER,
  posted_message_id INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_attachments_feedback ON beta_feedback_attachments(beta_feedback_id);

CREATE TABLE IF NOT EXISTS beta_feedback_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  beta_feedback_id INTEGER NOT NULL REFERENCES beta_feedback(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_by  INTEGER,
  note        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_status_history_feedback ON beta_feedback_status_history(beta_feedback_id);

CREATE TABLE IF NOT EXISTS beta_feedback_revisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  beta_feedback_id INTEGER NOT NULL REFERENCES beta_feedback(id) ON DELETE CASCADE,
  public_number    INTEGER NOT NULL,
  revision_number  INTEGER NOT NULL,
  previous_data    TEXT NOT NULL,
  edited_by        INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(beta_feedback_id, revision_number)
);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_revisions_feedback ON beta_feedback_revisions(beta_feedback_id);

-- Internal Deviverse work tracking. Work IDs are private operational
-- identifiers and must not replace or appear beside public BUG/IDEA/BETA IDs
-- in public reporter/GitHub/Telegram surfaces.
CREATE TABLE IF NOT EXISTS work_refs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id              TEXT NOT NULL UNIQUE,
  submission_type      TEXT NOT NULL CHECK (submission_type IN ('bug', 'idea', 'beta')),
  submission_record_id INTEGER NOT NULL,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(submission_type, submission_record_id)
);
CREATE INDEX IF NOT EXISTS idx_work_refs_lookup ON work_refs(work_id);
CREATE INDEX IF NOT EXISTS idx_work_refs_submission ON work_refs(submission_type, submission_record_id);

CREATE TABLE IF NOT EXISTS work_assignments (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_type           TEXT NOT NULL CHECK (submission_type IN ('bug', 'idea', 'beta')),
  submission_record_id      INTEGER NOT NULL,
  work_ref_id               INTEGER NOT NULL REFERENCES work_refs(id) ON DELETE CASCADE,
  assigned_username         TEXT NOT NULL,
  assigned_telegram_user_id INTEGER,
  assigned_by               INTEGER NOT NULL,
  assigned_by_username      TEXT,
  note                      TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'released', 'cancelled')),
  assigned_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at                  INTEGER,
  created_at                INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at                INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_assignments_active_submission
ON work_assignments(submission_type, submission_record_id)
WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_work_assignments_ref ON work_assignments(work_ref_id);
CREATE INDEX IF NOT EXISTS idx_work_assignments_assignee ON work_assignments(assigned_username, status);

CREATE TABLE IF NOT EXISTS work_history (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type           TEXT NOT NULL,
  submission_type      TEXT NOT NULL CHECK (submission_type IN ('bug', 'idea', 'beta')),
  submission_record_id INTEGER NOT NULL,
  work_ref_id          INTEGER NOT NULL REFERENCES work_refs(id) ON DELETE CASCADE,
  assignment_id        INTEGER REFERENCES work_assignments(id) ON DELETE SET NULL,
  actor_telegram_id    INTEGER,
  actor_username       TEXT,
  metadata             TEXT NOT NULL DEFAULT '{}',
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_work_history_created ON work_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_history_submission ON work_history(submission_type, submission_record_id);
CREATE INDEX IF NOT EXISTS idx_work_history_work_ref ON work_history(work_ref_id);
