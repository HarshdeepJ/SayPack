-- Milestone 3: voice requests, confirmable proposals, AI usage and budget.

-- One row per submitted voice or typed command; id is the client action ID.
-- It is written as 'pending' before the provider call, so a retry cannot dispatch twice.
CREATE TABLE voice_requests (
  id                   TEXT PRIMARY KEY,
  move_id              TEXT NOT NULL REFERENCES moves(id),
  user_id              TEXT NOT NULL REFERENCES users(id),
  input_kind           TEXT NOT NULL CHECK (input_kind IN ('audio', 'text')),
  input_hash           TEXT NOT NULL,
  audio_seconds        REAL,
  context_json         TEXT NOT NULL,
  clarifies_request_id TEXT REFERENCES voice_requests(id),
  status               TEXT NOT NULL CHECK (status IN ('pending', 'proposed', 'clarification', 'failed')),
  transcript           TEXT,
  result_json          TEXT,
  error_reason         TEXT,
  created_at           TEXT NOT NULL,
  completed_at         TEXT
);
CREATE INDEX voice_requests_pending ON voice_requests(status, user_id, move_id);

-- A validated operation waiting for the mover's yes or no. Nothing is saved before confirmation.
CREATE TABLE voice_proposals (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES voice_requests(id),
  move_id        TEXT NOT NULL REFERENCES moves(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  operation      TEXT NOT NULL CHECK (operation IN ('record_item', 'assign_item_to_box', 'record_condition', 'report_damage')),
  args_json      TEXT NOT NULL,
  readback       TEXT NOT NULL,
  context_box_id TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  outcome_json   TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);
CREATE INDEX voice_proposals_user ON voice_proposals(user_id, move_id, status);

-- Money is stored in micro-SGD (1 SGD = 1,000,000) to avoid floating-point drift.
CREATE TABLE ai_usage (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES voice_requests(id),
  operation           TEXT NOT NULL,
  model               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'uncertain', 'released')),
  reserved_micro_sgd  INTEGER NOT NULL,
  cost_micro_sgd      INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  pricing_version     TEXT NOT NULL,
  usd_to_sgd          REAL NOT NULL,
  created_at          TEXT NOT NULL,
  settled_at          TEXT
);
CREATE INDEX ai_usage_status ON ai_usage(status);

-- Single row: the application allowance and the provider circuit breaker.
CREATE TABLE ai_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  allowance_micro_sgd  INTEGER NOT NULL,
  usd_to_sgd           REAL NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  breaker_open_until   TEXT,
  updated_at           TEXT NOT NULL,
  updated_by           TEXT REFERENCES users(id)
);
-- Defaults: the S$5 allowance agreed for the MVP, and an assumed exchange rate that an
-- administrator must check. Both are editable on the admin page.
INSERT INTO ai_settings (id, allowance_micro_sgd, usd_to_sgd, updated_at) VALUES (1, 5000000, 1.35, '2026-10-06T00:00:00.000Z');
