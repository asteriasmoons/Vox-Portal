-- Migration 009: backfill callback interactions from existing status history.
--
-- Callback management was added after status buttons were already being used.
-- This preserves those real prior taps as callback_interactions so the
-- Callbacks dashboard can show interacted callbacks without showing untouched
-- registry-only buttons.

INSERT OR IGNORE INTO callback_records (
  callback_data, button_label, source_kind, source_id, source_public_id,
  source_title, app, source_chat_id, source_message_id, source_thread_id,
  created_at, updated_at
)
SELECT
  'rich:act:' || h.bug_id || ':status:' || h.to_status,
  CASE h.to_status
    WHEN 'confirmed' THEN 'Confirmed'
    WHEN 'investigating' THEN 'Investigating'
    WHEN 'in_progress' THEN 'In Progress'
    WHEN 'fix_in_testing' THEN 'Fix In Testing'
    WHEN 'fixed' THEN 'Mark Fixed'
    WHEN 'closed' THEN 'Close'
    WHEN 'cannot_reproduce' THEN 'Cannot Reproduce'
    ELSE 'Status'
  END,
  'bug',
  b.id,
  'BUG-' || printf('%04d', b.public_number),
  b.title,
  b.app,
  (
    SELECT cr.source_chat_id
    FROM callback_records cr
    WHERE cr.source_kind = 'bug'
      AND cr.source_id = b.id
      AND cr.source_chat_id IS NOT NULL
    LIMIT 1
  ),
  b.report_message_id,
  b.discussion_thread_id,
  h.created_at,
  unixepoch()
FROM status_history h
JOIN bugs b ON b.id = h.bug_id
WHERE NOT EXISTS (
  SELECT 1 FROM callback_records r
  WHERE r.callback_data = 'rich:act:' || h.bug_id || ':status:' || h.to_status
);

INSERT OR IGNORE INTO callback_records (
  callback_data, button_label, source_kind, source_id, source_public_id,
  source_title, app, source_chat_id, source_message_id, source_thread_id,
  created_at, updated_at
)
SELECT
  'idea:act:' || h.idea_id || ':status:' || h.to_status,
  CASE h.to_status
    WHEN 'accepted' THEN 'Accept'
    WHEN 'rejected' THEN 'Reject'
    WHEN 'in_progress' THEN 'In Progress'
    WHEN 'in_testing' THEN 'In Testing'
    WHEN 'shipped' THEN 'Mark Shipped'
    ELSE 'Status'
  END,
  'idea',
  i.id,
  'IDEA-' || printf('%04d', i.public_number),
  i.title,
  i.app,
  (
    SELECT cr.source_chat_id
    FROM callback_records cr
    WHERE cr.source_kind = 'idea'
      AND cr.source_id = i.id
      AND cr.source_chat_id IS NOT NULL
    LIMIT 1
  ),
  i.report_message_id,
  i.discussion_thread_id,
  h.created_at,
  unixepoch()
FROM idea_status_history h
JOIN ideas i ON i.id = h.idea_id
WHERE NOT EXISTS (
  SELECT 1 FROM callback_records r
  WHERE r.callback_data = 'idea:act:' || h.idea_id || ':status:' || h.to_status
);

INSERT OR IGNORE INTO callback_records (
  callback_data, button_label, source_kind, source_id, source_public_id,
  source_title, app, source_chat_id, source_message_id, source_thread_id,
  created_at, updated_at
)
SELECT
  'beta:menu:' || h.beta_feedback_id || ':status',
  'Status',
  'beta',
  b.id,
  'BETA-' || printf('%04d', b.public_number),
  substr(replace(b.testing, char(10), ' '), 1, 160),
  b.app,
  (
    SELECT cr.source_chat_id
    FROM callback_records cr
    WHERE cr.source_kind = 'beta'
      AND cr.source_id = b.id
      AND cr.source_chat_id IS NOT NULL
    LIMIT 1
  ),
  b.report_message_id,
  b.discussion_thread_id,
  h.created_at,
  unixepoch()
FROM beta_feedback_status_history h
JOIN beta_feedback b ON b.id = h.beta_feedback_id
WHERE NOT EXISTS (
  SELECT 1 FROM callback_records r
  WHERE r.callback_data = 'beta:menu:' || h.beta_feedback_id || ':status'
);

INSERT INTO callback_interactions (
  callback_id, interaction_type, callback_query_id, telegram_user_id,
  telegram_username, telegram_first_name, telegram_last_name, private_chat_id,
  source_chat_id, source_message_id, source_thread_id, response_destination,
  response_message, response_chat_id, response_message_id, delivery_status,
  delivery_error, sent_by_tg_id, created_at
)
SELECT
  r.id,
  'tap',
  'history:status_history:' || h.id,
  h.changed_by,
  NULL,
  NULL,
  NULL,
  h.changed_by,
  r.source_chat_id,
  r.source_message_id,
  r.source_thread_id,
  NULL,
  NULL,
  NULL,
  NULL,
  'backfilled',
  NULL,
  NULL,
  h.created_at
FROM status_history h
JOIN callback_records r
  ON r.callback_data = 'rich:act:' || h.bug_id || ':status:' || h.to_status
WHERE NOT EXISTS (
  SELECT 1 FROM callback_interactions i
  WHERE i.callback_query_id = 'history:status_history:' || h.id
);

INSERT INTO callback_interactions (
  callback_id, interaction_type, callback_query_id, telegram_user_id,
  telegram_username, telegram_first_name, telegram_last_name, private_chat_id,
  source_chat_id, source_message_id, source_thread_id, response_destination,
  response_message, response_chat_id, response_message_id, delivery_status,
  delivery_error, sent_by_tg_id, created_at
)
SELECT
  r.id,
  'tap',
  'history:idea_status_history:' || h.id,
  h.changed_by,
  NULL,
  NULL,
  NULL,
  h.changed_by,
  r.source_chat_id,
  r.source_message_id,
  r.source_thread_id,
  NULL,
  NULL,
  NULL,
  NULL,
  'backfilled',
  NULL,
  NULL,
  h.created_at
FROM idea_status_history h
JOIN callback_records r
  ON r.callback_data = 'idea:act:' || h.idea_id || ':status:' || h.to_status
WHERE NOT EXISTS (
  SELECT 1 FROM callback_interactions i
  WHERE i.callback_query_id = 'history:idea_status_history:' || h.id
);

INSERT INTO callback_interactions (
  callback_id, interaction_type, callback_query_id, telegram_user_id,
  telegram_username, telegram_first_name, telegram_last_name, private_chat_id,
  source_chat_id, source_message_id, source_thread_id, response_destination,
  response_message, response_chat_id, response_message_id, delivery_status,
  delivery_error, sent_by_tg_id, created_at
)
SELECT
  r.id,
  'tap',
  'history:beta_feedback_status_history:' || h.id,
  h.changed_by,
  NULL,
  NULL,
  NULL,
  h.changed_by,
  r.source_chat_id,
  r.source_message_id,
  r.source_thread_id,
  NULL,
  NULL,
  NULL,
  NULL,
  'backfilled',
  NULL,
  NULL,
  h.created_at
FROM beta_feedback_status_history h
JOIN callback_records r
  ON r.callback_data = 'beta:menu:' || h.beta_feedback_id || ':status'
WHERE NOT EXISTS (
  SELECT 1 FROM callback_interactions i
  WHERE i.callback_query_id = 'history:beta_feedback_status_history:' || h.id
);

UPDATE callback_records
SET tap_count = (
    SELECT COUNT(*)
    FROM callback_interactions i
    WHERE i.callback_id = callback_records.id
      AND i.interaction_type = 'tap'
  ),
  last_tapped_at = (
    SELECT MAX(i.created_at)
    FROM callback_interactions i
    WHERE i.callback_id = callback_records.id
      AND i.interaction_type = 'tap'
  ),
  updated_at = unixepoch()
WHERE EXISTS (
  SELECT 1
  FROM callback_interactions i
  WHERE i.callback_id = callback_records.id
    AND i.interaction_type = 'tap'
);
