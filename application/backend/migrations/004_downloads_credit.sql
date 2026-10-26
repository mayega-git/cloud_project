-- Daily writing credit: one row per user and UTC day, shared by every device,
-- document and branch. The conditional upsert in credit.ts keeps `used` within the limit.
CREATE TABLE IF NOT EXISTS business.write_credit (
  user_id uuid NOT NULL REFERENCES business.users(id),
  quota_day date NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY (user_id, quota_day)
);

-- Limited download links. The visitor token is never stored, only its hash.
-- `remaining` is decremented by a conditional UPDATE, so it never goes below zero.
CREATE TABLE IF NOT EXISTS business.download_links (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES business.branches(id),
  created_by uuid NOT NULL REFERENCES business.users(id),
  token_hash text NOT NULL UNIQUE,
  max_downloads integer NOT NULL CHECK (max_downloads BETWEEN 1 AND 1000000),
  remaining integer NOT NULL CHECK (remaining >= 0 AND remaining <= max_downloads),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS download_links_branch ON business.download_links(branch_id);
