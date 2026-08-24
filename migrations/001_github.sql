-- Migration 001: add GitHub Issue cross-reference columns to `bugs`.
-- Safe to run on an existing production DB. `IF NOT EXISTS` is not supported
-- on ALTER TABLE ADD COLUMN in SQLite, so this migration will error if a
-- column already exists — run it exactly once per environment.
--
-- Apply locally:  wrangler d1 execute vox_bugs --local  --file=migrations/001_github.sql
-- Apply remote:   wrangler d1 execute vox_bugs --remote --file=migrations/001_github.sql

ALTER TABLE bugs ADD COLUMN github_repo         TEXT;
ALTER TABLE bugs ADD COLUMN github_issue_number INTEGER;
ALTER TABLE bugs ADD COLUMN github_issue_url    TEXT;
ALTER TABLE bugs ADD COLUMN github_status       TEXT;
ALTER TABLE bugs ADD COLUMN github_error        TEXT;
ALTER TABLE bugs ADD COLUMN github_created_at   INTEGER;

CREATE INDEX IF NOT EXISTS idx_bugs_github_issue ON bugs(github_issue_number);
