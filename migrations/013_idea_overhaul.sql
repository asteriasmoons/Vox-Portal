-- Migration 013: detailed Idea submissions.
-- Additive only; old Idea rows keep their existing public IDs and legacy fields.

ALTER TABLE ideas ADD COLUMN idea_type TEXT;
ALTER TABLE ideas ADD COLUMN user_flow TEXT;
ALTER TABLE ideas ADD COLUMN key_features TEXT;
ALTER TABLE ideas ADD COLUMN expected_experience TEXT;
ALTER TABLE ideas ADD COLUMN anything_to_avoid TEXT;
