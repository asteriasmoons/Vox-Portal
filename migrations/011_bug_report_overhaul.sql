ALTER TABLE bugs ADD COLUMN bug_type TEXT;
ALTER TABLE bugs ADD COLUMN feature TEXT;
ALTER TABLE bugs ADD COLUMN affected_areas TEXT;
ALTER TABLE bugs ADD COLUMN github_issue_id INTEGER;
ALTER TABLE bugs ADD COLUMN github_issue_node_id TEXT;
ALTER TABLE bugs ADD COLUMN github_sub_issue_number INTEGER;
ALTER TABLE bugs ADD COLUMN github_sub_issue_id INTEGER;
ALTER TABLE bugs ADD COLUMN github_sub_issue_node_id TEXT;
ALTER TABLE bugs ADD COLUMN github_sub_issue_url TEXT;
ALTER TABLE bugs ADD COLUMN github_parent_issue_number INTEGER;
ALTER TABLE bugs ADD COLUMN github_parent_issue_url TEXT;

UPDATE bugs SET bug_type = category WHERE bug_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_bugs_github_sub_issue ON bugs(github_sub_issue_number);
