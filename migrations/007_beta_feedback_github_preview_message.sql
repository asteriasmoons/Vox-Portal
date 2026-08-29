-- Migration 007: Persist the Telegram GitHub-preview message for Beta Feedback.
-- This lets reporter edits update the existing preview message in place.

ALTER TABLE beta_feedback ADD COLUMN github_preview_message_id INTEGER;
