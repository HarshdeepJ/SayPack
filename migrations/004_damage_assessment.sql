-- Milestone 4: the AI checks damage photos. Assessments only describe; a reviewer decides.

-- ai_usage now records photo assessments as well as voice requests, so request_id
-- no longer references voice_requests. SQLite cannot drop a foreign key in place.
CREATE TABLE ai_usage_new (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL,
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
INSERT INTO ai_usage_new SELECT * FROM ai_usage;
DROP TABLE ai_usage;
ALTER TABLE ai_usage_new RENAME TO ai_usage;
CREATE INDEX ai_usage_status ON ai_usage(status);
CREATE INDEX ai_usage_request ON ai_usage(request_id);

-- One row per check of an incident's photos; id is the client action ID.
-- Written as 'pending' before the provider call, so a retry cannot dispatch twice.
CREATE TABLE ai_assessments (
  id                 TEXT PRIMARY KEY,
  incident_id        TEXT NOT NULL REFERENCES damage_incidents(id),
  move_id            TEXT NOT NULL REFERENCES moves(id),
  requested_by       TEXT NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  photo_ids_json     TEXT NOT NULL,
  baseline_photo_id  TEXT REFERENCES photos(id),
  verdict            TEXT CHECK (verdict IN ('damage_visible', 'no_damage_visible', 'inconclusive')),
  result_json        TEXT,
  model              TEXT NOT NULL,
  error_reason       TEXT,
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);
CREATE INDEX ai_assessments_incident ON ai_assessments(incident_id, created_at);
CREATE INDEX ai_assessments_pending ON ai_assessments(status);
