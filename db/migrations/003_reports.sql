-- The website now produces on-demand research reports. Subscriptions move to a separate service,
-- so the in-app trial, account, issue, ledger and billing tables are removed (they were never used in production).
DROP TABLE IF EXISTS previews;
DROP TABLE IF EXISTS waitlist;
DROP TABLE IF EXISTS newsletter_issues;
DROP TABLE IF EXISTS entitlement_ledger;
DROP TABLE IF EXISTS billing;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS accounts;

CREATE TABLE reports (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  visitor_key text NOT NULL,
  prefs_key_hash text NOT NULL,
  status text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  data jsonb NOT NULL,
  sealed text NOT NULL
);
CREATE INDEX reports_draft_idx ON reports (draft_id, prefs_key_hash, created_at);
CREATE INDEX reports_visitor_idx ON reports (visitor_key, created_at);
CREATE INDEX reports_created_idx ON reports (created_at);

-- Hand-off to the subscription service. Email + filters (sealed), confirmed by a single-use link.
CREATE TABLE subscription_requests (
  id text PRIMARY KEY,
  email text NOT NULL,
  status text NOT NULL,
  created_at bigint NOT NULL,
  data jsonb NOT NULL,
  sealed text NOT NULL
);
CREATE INDEX subscription_requests_email_idx ON subscription_requests (email);
