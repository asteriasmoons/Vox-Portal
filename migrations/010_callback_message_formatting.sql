-- Migration 010: formatted regular Telegram callback messages.
--
-- Keeps the existing plain text columns for readable previews/fallbacks, and
-- adds editor document + Telegram HTML columns for WYSIWYG callback messages.

ALTER TABLE callback_records ADD COLUMN followup_message_html TEXT;
ALTER TABLE callback_records ADD COLUMN followup_message_doc TEXT;

ALTER TABLE callback_interactions ADD COLUMN response_message_html TEXT;
ALTER TABLE callback_interactions ADD COLUMN response_message_doc TEXT;
