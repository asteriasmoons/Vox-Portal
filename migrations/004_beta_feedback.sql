-- Migration 004: Beta Feedback submissions.
--
-- Mirrors the Feature Ideas migration shape: independent submission table,
-- independent BETA-#### sequence, matching attachment table, and matching
-- status history table.
--
-- Apply:
--   wrangler d1 execute vox_bugs --local  --file=migrations/004_beta_feedback.sql
--   wrangler d1 execute vox_bugs --remote --file=migrations/004_beta_feedback.sql

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

  -- Beta feedback lifecycle. Values: 'new' | 'reviewed' | 'noted'
  -- | 'needs_follow_up' | 'incorporated' | 'closed'
  status                   TEXT NOT NULL DEFAULT 'new',

  -- Telegram linkage (same shape as bugs and ideas).
  channel_message_id       INTEGER,
  discussion_message_id    INTEGER,
  discussion_thread_id     INTEGER,
  report_message_id        INTEGER,

  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_reporter ON beta_feedback(reporter_tg_id);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_status   ON beta_feedback(status);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_app      ON beta_feedback(app);

CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO sequences (name, value) VALUES ('beta', 0);

-- Beta attachments (mirrors bug and idea attachments).
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

-- Beta lifecycle history (parallel to bugs and ideas).
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
