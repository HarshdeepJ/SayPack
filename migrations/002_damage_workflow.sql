-- Milestone 2: condition observations, photos, damage incidents, holds, evidence requests, decisions.

CREATE TABLE condition_observations (
  id          TEXT PRIMARY KEY,
  move_id     TEXT NOT NULL REFERENCES moves(id),
  item_id     TEXT NOT NULL REFERENCES items(id),
  stage       TEXT NOT NULL CHECK (stage IN ('packing', 'delivery')),
  condition   TEXT NOT NULL CHECK (condition IN ('no_visible_damage', 'existing_wear')),
  note        TEXT,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX condition_observations_item ON condition_observations(item_id, created_at);

CREATE TABLE damage_incidents (
  id                TEXT PRIMARY KEY,
  move_id           TEXT NOT NULL REFERENCES moves(id),
  item_id           TEXT REFERENCES items(id),
  stage             TEXT NOT NULL CHECK (stage IN ('packing', 'delivery')),
  report            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'resolved')),
  latest_decision   TEXT CHECK (latest_decision IN ('continue', 'repack', 'escalate', 'close')),
  repacked_at       TEXT,
  repacked_by       TEXT REFERENCES users(id),
  reported_by       TEXT NOT NULL REFERENCES users(id),
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  resolved_at       TEXT
);
CREATE INDEX damage_incidents_move_status ON damage_incidents(move_id, status, created_at);
CREATE INDEX damage_incidents_item ON damage_incidents(item_id);

-- item_id NULL means a whole-move hold. A hold is active while released_at IS NULL.
CREATE TABLE holds (
  id             TEXT PRIMARY KEY,
  move_id        TEXT NOT NULL REFERENCES moves(id),
  item_id        TEXT REFERENCES items(id),
  incident_id    TEXT REFERENCES damage_incidents(id),
  reason         TEXT NOT NULL,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  released_at    TEXT,
  released_by    TEXT REFERENCES users(id),
  release_reason TEXT,
  revision       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX holds_active ON holds(move_id, item_id) WHERE released_at IS NULL;
CREATE INDEX holds_incident ON holds(incident_id);

CREATE TABLE evidence_requests (
  id           TEXT PRIMARY KEY,
  move_id      TEXT NOT NULL REFERENCES moves(id),
  incident_id  TEXT NOT NULL REFERENCES damage_incidents(id),
  request_text TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  closed_by    TEXT REFERENCES users(id),
  revision     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);
CREATE INDEX evidence_requests_incident ON evidence_requests(incident_id, status);

CREATE TABLE decisions (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES damage_incidents(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('continue', 'repack', 'escalate', 'close')),
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX decisions_incident ON decisions(incident_id, created_at);

-- storage_key is a generated relative path; user-supplied names are never used on disk.
CREATE TABLE photos (
  id                  TEXT PRIMARY KEY,
  move_id             TEXT NOT NULL REFERENCES moves(id),
  kind                TEXT NOT NULL CHECK (kind IN ('baseline', 'incident')),
  item_id             TEXT REFERENCES items(id),
  incident_id         TEXT REFERENCES damage_incidents(id),
  evidence_request_id TEXT REFERENCES evidence_requests(id),
  storage_key         TEXT NOT NULL UNIQUE,
  media_type          TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  sha256              TEXT NOT NULL,
  uploaded_by         TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  CHECK ((kind = 'baseline' AND item_id IS NOT NULL) OR (kind = 'incident' AND incident_id IS NOT NULL))
);
CREATE INDEX photos_item ON photos(item_id, kind);
CREATE INDEX photos_incident ON photos(incident_id);
