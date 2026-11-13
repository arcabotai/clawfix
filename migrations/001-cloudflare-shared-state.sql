BEGIN;

ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS conversations (
  route TEXT NOT NULL,
  id TEXT NOT NULL,
  diagnostic_id TEXT,
  messages JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (route, id)
);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, key, window_start)
);

CREATE TABLE IF NOT EXISTS concurrency_leases (
  scope TEXT NOT NULL,
  lease_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_touched ON conversations(touched_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_expires ON rate_limit_windows(expires_at);
CREATE INDEX IF NOT EXISTS idx_concurrency_leases_expires ON concurrency_leases(expires_at);

COMMIT;
