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

  duplicate_of_id       INTEGER REFERENCES bugs(id) ON DELETE SET NULL,

  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

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
