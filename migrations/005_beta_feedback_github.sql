-- Migration 005: GitHub Discussion linkage for Beta Feedback.
--
-- Mirrors the Feature Ideas github_* metadata columns so each beta feedback
-- submission can post one comment into the mapped app discussion and keep
-- resubmits idempotent.
--
-- Apply:
--   wrangler d1 execute vox_bugs --local  --file=migrations/005_beta_feedback_github.sql
--   wrangler d1 execute vox_bugs --remote --file=migrations/005_beta_feedback_github.sql

ALTER TABLE beta_feedback ADD COLUMN github_repo TEXT;
ALTER TABLE beta_feedback ADD COLUMN github_discussion_id TEXT;
ALTER TABLE beta_feedback ADD COLUMN github_discussion_url TEXT;
ALTER TABLE beta_feedback ADD COLUMN github_comment_id TEXT;
ALTER TABLE beta_feedback ADD COLUMN github_comment_url TEXT;
ALTER TABLE beta_feedback ADD COLUMN github_status TEXT;
ALTER TABLE beta_feedback ADD COLUMN github_error TEXT;
ALTER TABLE beta_feedback ADD COLUMN github_created_at INTEGER;
