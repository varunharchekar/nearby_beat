-- Nearby core schema. Times are epoch milliseconds (bigint).
-- Personal location data (addresses, centers, drawn shapes) lives only in the `sealed` columns,
-- encrypted by the application with ADDRESS_ENCRYPTION_KEY (AES-256-GCM).

CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL);

CREATE TABLE drafts (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  sealed text NOT NULL
);
CREATE INDEX drafts_expires_idx ON drafts (expires_at);

CREATE TABLE previews (
  id text PRIMARY KEY,
  draft_id text REFERENCES drafts(id) ON DELETE CASCADE,
  account_id text,
  prefs_key_hash text NOT NULL,
  snapshot_id text NOT NULL,
  status text NOT NULL,
  partial boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  sealed text NOT NULL
);
CREATE INDEX previews_owner_idx ON previews (draft_id, account_id, prefs_key_hash, snapshot_id);

CREATE TABLE waitlist (
  id text PRIMARY KEY,
  email text NOT NULL,
  area text NOT NULL,
  consent_at bigint NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at bigint NOT NULL,
  email_state text NOT NULL,
  data jsonb NOT NULL,
  sealed text NOT NULL
);

CREATE TABLE magic_links (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  purpose text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at bigint NOT NULL,
  used_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX magic_links_email_idx ON magic_links (email, created_at);

CREATE TABLE source_observations (
  id text PRIMARY KEY,
  adapter text NOT NULL,
  record_id text NOT NULL,
  family text NOT NULL,
  canonical_url text NOT NULL,
  content_hash text NOT NULL,
  published_at bigint NOT NULL,
  observed_at bigint NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX source_observations_record_idx ON source_observations (adapter, record_id, observed_at);

CREATE TABLE observation_state (
  adapter text NOT NULL,
  record_id text NOT NULL,
  content_hash text NOT NULL,
  facts jsonb NOT NULL,
  last_observation_id text NOT NULL REFERENCES source_observations(id),
  PRIMARY KEY (adapter, record_id)
);

CREATE TABLE entities (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  data jsonb NOT NULL
);

CREATE TABLE change_events (
  id text PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  entity_id text NOT NULL REFERENCES entities(id),
  review_state text NOT NULL,
  observed_at bigint NOT NULL,
  approved_at bigint,
  data jsonb NOT NULL
);
CREATE INDEX change_events_approved_idx ON change_events (review_state, approved_at);
CREATE INDEX change_events_observed_idx ON change_events (observed_at);

CREATE TABLE snapshots (
  id text PRIMARY KEY,
  at bigint NOT NULL,
  change_ids jsonb NOT NULL
);

CREATE TABLE newsletter_issues (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  schedule_key text NOT NULL,
  sunday bigint NOT NULL,
  status text NOT NULL,
  provider_message_id text,
  data jsonb NOT NULL,
  UNIQUE (account_id, schedule_key)
);
CREATE INDEX newsletter_issues_msg_idx ON newsletter_issues (provider_message_id);

-- Kept after account deletion (no personal data) so credits cannot be re-earned.
CREATE TABLE entitlement_ledger (
  account_id text NOT NULL,
  issue_key text NOT NULL,
  credit_type text NOT NULL,
  consumed_at bigint NOT NULL,
  restored_at bigint,
  PRIMARY KEY (account_id, issue_key)
);

CREATE TABLE billing (
  account_id text PRIMARY KEY,
  customer_id text,
  data jsonb NOT NULL
);
CREATE INDEX billing_customer_idx ON billing (customer_id);

CREATE TABLE adapter_runs (
  id bigserial PRIMARY KEY,
  adapter text NOT NULL,
  at bigint NOT NULL,
  ok boolean NOT NULL,
  count integer NOT NULL,
  error text
);
CREATE INDEX adapter_runs_at_idx ON adapter_runs (at DESC);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at bigint NOT NULL,
  actor text NOT NULL,
  op text NOT NULL,
  detail text NOT NULL
);

CREATE TABLE kv (k text PRIMARY KEY, v jsonb NOT NULL);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  type text NOT NULL,
  key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  run_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  last_error text
);
CREATE INDEX jobs_due_idx ON jobs (status, run_at);
