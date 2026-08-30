-- Migration 012: internal Deviverse work identifiers and assignment history.
-- Work IDs are private operational identifiers; public BUG/IDEA/BETA IDs remain unchanged.

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
