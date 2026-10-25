CREATE SCHEMA IF NOT EXISTS auth;
ALTER TABLE business.sessions ADD COLUMN IF NOT EXISTS verified_at timestamptz;
CREATE TABLE IF NOT EXISTS business.invitations (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES business.branches(id),
  email text NOT NULL,
  access text NOT NULL CHECK (access IN ('READ','WRITE')),
  token_hash text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  email_status text NOT NULL CHECK (email_status IN ('QUEUED','SENT','FAILED')),
  email_attempts integer NOT NULL DEFAULT 0,
  last_email_error text,
  created_by uuid NOT NULL REFERENCES business.users(id),
  accepted_by uuid REFERENCES business.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  request_key text NOT NULL,
  UNIQUE(branch_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_invitation_per_email
  ON business.invitations(branch_id,email) WHERE state='PENDING';
