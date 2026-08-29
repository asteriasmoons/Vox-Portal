-- Migration 006: Reporter editing support for Beta Feedback.
--
-- Additive only. Stores the reporter's previous submitted payload before
-- canonical beta_feedback rows are overwritten by an edit.
--
-- Apply:
--   wrangler d1 execute vox_bugs --local  --file=migrations/006_beta_feedback_editing.sql
--   wrangler d1 execute vox_bugs --remote --file=migrations/006_beta_feedback_editing.sql

ALTER TABLE beta_feedback ADD COLUMN last_edited_at INTEGER;

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
