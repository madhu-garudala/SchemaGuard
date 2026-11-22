-- Schema Guard core tables. All timestamps are UTC (timestamptz). Money is BIGINT minor units
-- inside JSONB documents as decimal strings; nothing monetary is stored as a float.

CREATE TABLE environments (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('main','sandbox')),
  dataset             TEXT NOT NULL,
  active_contracts    JSONB NOT NULL,           -- {"orders":1,"payments":1,"shipping":1}
  active_mapping_rev  TEXT NOT NULL,            -- commit sha in the fixture repo
  baseline_rev        TEXT NOT NULL,
  current_snapshot_id BIGINT,
  current_revision    INT NOT NULL DEFAULT 0,
  health              TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','at_risk','delayed')),
  health_detail       TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contracts (
  env_id     TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  version    INT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active','superseded','candidate','rejected','withdrawn','pending_clarification')),
  body       JSONB NOT NULL,
  run_id     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (env_id, source, version)
);

CREATE TABLE feed_batches (
  id               BIGSERIAL PRIMARY KEY,
  env_id           TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,
  batch_id         TEXT NOT NULL,
  seq              INT NOT NULL,
  contract_version INT NOT NULL,
  rows             JSONB NOT NULL,
  row_count        INT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('received','applied','quarantined','ignored')),
  reason           TEXT,
  run_id           TEXT,
  received_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (env_id, source, batch_id)
);

CREATE TABLE snapshots (
  id                BIGSERIAL PRIMARY KEY,
  env_id            TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  revision          INT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('candidate','published','rejected')),
  data_as_of        TIMESTAMPTZ NOT NULL,
  contract_versions JSONB NOT NULL,
  mapping_rev       TEXT NOT NULL,
  input_batches     JSONB NOT NULL,
  totals            JSONB NOT NULL,
  validation        JSONB NOT NULL,
  run_id            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at      TIMESTAMPTZ
);
-- One published snapshot per revision; rejected candidates may reuse the number.
CREATE UNIQUE INDEX snapshots_published_rev ON snapshots (env_id, revision) WHERE status = 'published';

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  env_id      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('rehearsal','scenario')),
  plan_id     TEXT,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  outcome     TEXT,
  options     JSONB NOT NULL DEFAULT '{}',
  agent_mode  TEXT NOT NULL,
  snapshot_before_id BIGINT,
  snapshot_after_id  BIGINT,
  publish_status TEXT NOT NULL DEFAULT 'pending',
  timings     JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX runs_created ON runs (created_at DESC);

CREATE TABLE jobs (
  id               BIGSERIAL PRIMARY KEY,
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempt          INT NOT NULL DEFAULT 0,
  max_attempts     INT NOT NULL DEFAULT 3,
  available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token      UUID,
  lease_expires_at TIMESTAMPTZ,
  serial_key       TEXT,                 -- jobs sharing a key never run concurrently
  dedup_key        TEXT UNIQUE,          -- one job per logical operation
  last_error       TEXT,
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim ON jobs (status, available_at);

CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  version        INT NOT NULL,
  type           TEXT NOT NULL,
  source         TEXT NOT NULL,
  event_time     TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL,
  run_id         TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  dedup_key      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('accepted','duplicate','ignored')),
  note           TEXT,
  payload        JSONB NOT NULL
);
CREATE INDEX events_run ON events (run_id, event_time);
-- The first delivery of a logical event wins; later copies are stored as 'duplicate'.
CREATE UNIQUE INDEX events_dedup ON events (run_id, dedup_key) WHERE status <> 'duplicate';

CREATE TABLE incidents (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  env_id           TEXT NOT NULL,
  correlation_id   TEXT NOT NULL,
  source           TEXT NOT NULL,
  status           TEXT NOT NULL,
  risk_kind        TEXT NOT NULL,
  severity         TEXT NOT NULL,
  title            TEXT NOT NULL,
  what_breaks      TEXT NOT NULL DEFAULT '',
  cause_status     TEXT,
  cause_category   TEXT,
  cause_text       TEXT,
  watcher_category TEXT,
  affected_assets  TEXT[] NOT NULL DEFAULT '{}',
  owner            JSONB NOT NULL,
  freshness        JSONB NOT NULL,
  has_verified_fix BOOLEAN NOT NULL DEFAULT false,
  next_action      TEXT NOT NULL DEFAULT '',
  evidence_ids     TEXT[] NOT NULL DEFAULT '{}',
  history          JSONB NOT NULL DEFAULT '[]',
  finding          JSONB,
  repair           JSONB,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, correlation_id)
);

CREATE TABLE evidence (
  run_id      TEXT NOT NULL,
  id          TEXT NOT NULL,
  incident_id TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, id)
);

CREATE TABLE timeline (
  id           BIGSERIAL PRIMARY KEY,
  run_id       TEXT NOT NULL,
  key          TEXT NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  sim_at       TIMESTAMPTZ NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  incident_id  TEXT,
  evidence_ids TEXT[] NOT NULL DEFAULT '{}',
  tone         TEXT NOT NULL DEFAULT 'neutral',
  data         JSONB,
  UNIQUE (run_id, key)
);

CREATE TABLE agent_runs (
  id              BIGSERIAL PRIMARY KEY,
  run_id          TEXT,                  -- NULL for scenario generation and live checks
  batch_id        TEXT,
  role            TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('live','fixture')),
  fallback_reason TEXT,
  provider        TEXT,
  model           TEXT,
  session_key     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('ok','error')),
  error_category  TEXT,
  error_message   TEXT,
  elapsed_ms      INT NOT NULL DEFAULT 0,
  attempt         INT NOT NULL DEFAULT 1,
  usage           JSONB,
  input_excerpt   TEXT NOT NULL DEFAULT '',
  output_excerpt  TEXT NOT NULL DEFAULT '',
  output          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_run ON agent_runs (run_id, id);

CREATE TABLE scenario_plans (
  id            TEXT PRIMARY KEY,
  origin        TEXT NOT NULL CHECK (origin IN ('catalog','agent')),
  case_no       INT,
  batch_id      TEXT,
  author_role   TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  team          TEXT NOT NULL,
  seed          BIGINT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('accepted','invalid')),
  reasons       JSONB NOT NULL DEFAULT '[]',
  attempt       INT NOT NULL DEFAULT 1,
  title         TEXT,
  summary       TEXT,
  quick         BOOLEAN NOT NULL DEFAULT false,
  plan          JSONB,                   -- the plan WITHOUT its expected outcome
  raw_output    TEXT,
  agent_run_id  BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Private answer key. Only the scorer reads this table; evidence assembly never does.
CREATE TABLE scenario_expectations (
  plan_id  TEXT PRIMARY KEY REFERENCES scenario_plans(id) ON DELETE CASCADE,
  expected JSONB NOT NULL
);

CREATE TABLE scores (
  run_id TEXT PRIMARY KEY,
  body   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE worker_heartbeat (
  id        TEXT PRIMARY KEY,
  last_beat TIMESTAMPTZ NOT NULL,
  info      JSONB NOT NULL DEFAULT '{}'
);
