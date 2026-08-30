-- Migration 008: Rich Message callback management.
--
-- Stores published Rich Message callback buttons, their editable follow-up
-- configuration, tap history, and manual updates sent later from the Mini App.
--
-- Apply:
--   wrangler d1 execute vox_bugs --local  --file=migrations/008_callbacks.sql
--   wrangler d1 execute vox_bugs --remote --file=migrations/008_callbacks.sql

CREATE TABLE IF NOT EXISTS callback_records (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  callback_data            TEXT NOT NULL UNIQUE,
  button_label             TEXT NOT NULL,
  source_kind              TEXT NOT NULL,
  source_id                INTEGER,
  source_public_id         TEXT,
  source_title             TEXT,
  app                      TEXT,
  source_chat_id           INTEGER,
  source_message_id        INTEGER,
  source_thread_id         INTEGER,
  followup_destination     TEXT NOT NULL DEFAULT 'dm',
  followup_message         TEXT NOT NULL DEFAULT '',
  followup_enabled         INTEGER NOT NULL DEFAULT 0,
  active                   INTEGER NOT NULL DEFAULT 1,
  tap_count                INTEGER NOT NULL DEFAULT 0,
  last_tapped_at           INTEGER,
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_callback_records_active ON callback_records(active);
CREATE INDEX IF NOT EXISTS idx_callback_records_source ON callback_records(source_kind, source_id);

CREATE TABLE IF NOT EXISTS callback_interactions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  callback_id              INTEGER NOT NULL REFERENCES callback_records(id) ON DELETE CASCADE,
  interaction_type         TEXT NOT NULL DEFAULT 'tap',
  callback_query_id        TEXT,
  telegram_user_id         INTEGER,
  telegram_username        TEXT,
  telegram_first_name      TEXT,
  telegram_last_name       TEXT,
  private_chat_id          INTEGER,
  source_chat_id           INTEGER,
  source_message_id        INTEGER,
  source_thread_id         INTEGER,
  response_destination     TEXT,
  response_message         TEXT,
  response_chat_id         INTEGER,
  response_message_id      INTEGER,
  delivery_status          TEXT NOT NULL,
  delivery_error           TEXT,
  sent_by_tg_id            INTEGER,
  created_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_callback_interactions_callback ON callback_interactions(callback_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_callback_interactions_user ON callback_interactions(callback_id, telegram_user_id);
