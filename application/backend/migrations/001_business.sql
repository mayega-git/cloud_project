CREATE SCHEMA IF NOT EXISTS business;
CREATE TABLE IF NOT EXISTS business.users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS business.sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES business.users(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS business.documents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES business.users(id),
  owner_timezone text NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('PROVISIONING','READY')),
  initial_pad_id text NOT NULL UNIQUE,
  creation_key text NOT NULL,
  next_daily_at timestamptz,
  UNIQUE (owner_id, creation_key)
);
CREATE TABLE IF NOT EXISTS business.branches (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES business.documents(id),
  number integer NOT NULL CHECK (number > 0),
  active_version_id uuid,
  source_branch_id uuid REFERENCES business.branches(id),
  source_version_id uuid,
  source_revision integer,
  UNIQUE (document_id, number)
);
CREATE TABLE IF NOT EXISTS business.versions (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES business.branches(id),
  number integer NOT NULL CHECK (number > 0),
  pad_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('OPEN','CLOSING','FROZEN')),
  final_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_version_per_branch
  ON business.versions(branch_id) WHERE state IN ('OPEN','CLOSING');
ALTER TABLE business.branches DROP CONSTRAINT IF EXISTS branches_active_version_fk;
ALTER TABLE business.branches ADD CONSTRAINT branches_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES business.versions(id);
ALTER TABLE business.branches DROP CONSTRAINT IF EXISTS branches_source_version_fk;
ALTER TABLE business.branches ADD CONSTRAINT branches_source_version_fk
  FOREIGN KEY (source_version_id) REFERENCES business.versions(id);
CREATE TABLE IF NOT EXISTS business.permissions (
  branch_id uuid NOT NULL REFERENCES business.branches(id),
  user_id uuid NOT NULL REFERENCES business.users(id),
  access text NOT NULL CHECK (access IN ('READ','WRITE')),
  PRIMARY KEY (branch_id, user_id)
);
CREATE TABLE IF NOT EXISTS business.closures (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES business.branches(id),
  source_version_id uuid NOT NULL UNIQUE REFERENCES business.versions(id),
  cause text NOT NULL CHECK (cause IN ('MANUAL','DAILY')),
  state text NOT NULL CHECK (state IN ('WAITING','DRAINING','COPYING','COMPLETED','FAILED')),
  requested_at timestamptz NOT NULL,
  admission_deadline timestamptz NOT NULL,
  final_revision integer,
  destination_pad_id text NOT NULL UNIQUE,
  successor_version_id uuid UNIQUE REFERENCES business.versions(id),
  request_key text,
  last_error text,
  UNIQUE (branch_id, request_key)
);
CREATE TABLE IF NOT EXISTS business.restorations (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES business.documents(id),
  source_version_id uuid NOT NULL REFERENCES business.versions(id),
  source_revision integer NOT NULL,
  destination_pad_id text NOT NULL UNIQUE,
  destination_branch_id uuid UNIQUE REFERENCES business.branches(id),
  state text NOT NULL CHECK (state IN ('COPYING','COMPLETED','FAILED')),
  request_key text NOT NULL,
  last_error text,
  UNIQUE (document_id, request_key)
);
CREATE TABLE IF NOT EXISTS business.orphan_pads (
  pad_id text PRIMARY KEY,
  operation_id uuid NOT NULL,
  noted_at timestamptz NOT NULL DEFAULT now()
);
