-- Migration 003: Feature Idea submissions.
--
-- Ideas live in their OWN table (not `bugs`) so the two workflows stay
-- semantically distinct: bugs → GitHub Issues, ideas → GitHub Discussions
-- comments. Sequences also live separately so IDEA-#### numbering is
-- independent of BUG-####.
--
-- Apply:
--   wrangler d1 execute vox_bugs --local  --file=migrations/003_ideas.sql
--   wrangler d1 execute vox_bugs --remote --file=migrations/003_ideas.sql

CREATE TABLE IF NOT EXISTS ideas (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  public_number            INTEGER NOT NULL UNIQUE,
  reporter_tg_id           INTEGER NOT NULL,
  reporter_username        TEXT,
  reporter_display_name    TEXT,

  app                      TEXT NOT NULL,
  title                    TEXT NOT NULL,
  what_i_want              TEXT NOT NULL,
  why_useful               TEXT,
  how_it_works             TEXT,
  where_it_belongs         TEXT,
  notes                    TEXT,

  -- Idea lifecycle. Values: 'new' | 'accepted' | 'rejected'
  -- | 'in_progress' | 'in_testing' | 'shipped'
  status                   TEXT NOT NULL DEFAULT 'new',
  decision_reason          TEXT,

  -- Telegram linkage (same shape as bugs).
  channel_message_id       INTEGER,
  discussion_message_id    INTEGER,
  discussion_thread_id     INTEGER,
  report_message_id        INTEGER,

  -- GitHub Discussion linkage.
  github_repo              TEXT,
  github_discussion_id     TEXT,   -- GraphQL node id (base64)
  github_discussion_url    TEXT,
  github_comment_id        TEXT,   -- GraphQL node id of the added comment
  github_comment_url       TEXT,
  github_status            TEXT,   -- 'created' | 'failed' | 'skipped_no_mapping' | 'skipped_disabled'
  github_error             TEXT,
  github_created_at        INTEGER,

  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ideas_reporter ON ideas(reporter_tg_id);
CREATE INDEX IF NOT EXISTS idx_ideas_status   ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_app      ON ideas(app);

INSERT OR IGNORE INTO sequences (name, value) VALUES ('idea', 0);

-- Idea attachments (mirrors bug attachments).
CREATE TABLE IF NOT EXISTS idea_attachments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id        INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_idea_attachments_idea ON idea_attachments(idea_id);

-- Idea lifecycle history (parallel to status_history).
CREATE TABLE IF NOT EXISTS idea_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_by  INTEGER,
  note        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_idea_status_history_idea ON idea_status_history(idea_id);
