-- Migration 002: Rich Message live report support + GitHub action idempotency.
--
-- `bugs.report_message_id` — id of the sendRichMessage returned message that
--   lives inside the bug's discussion thread. We editMessageText(rich_message)
--   on it whenever the bug's live state changes, so the report block always
--   shows current Status / Severity / Category.
--
-- `github_actions` — one row per logical management action that has been
--   synced to GitHub. `action_key` is `<bug_id>:<verb>:<version>` so retries
--   / duplicate deliveries cannot double-post comments or double-close issues.
--
-- Apply:
--   wrangler d1 execute vox_bugs --local  --file=migrations/002_rich_message.sql
--   wrangler d1 execute vox_bugs --remote --file=migrations/002_rich_message.sql

ALTER TABLE bugs ADD COLUMN report_message_id INTEGER;

CREATE TABLE IF NOT EXISTS github_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id      INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  action_key  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_github_actions_bug ON github_actions(bug_id);
