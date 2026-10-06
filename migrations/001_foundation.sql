-- Milestone 1: identity, moves, rooms, boxes, items, audit, idempotency.
-- Timestamps are ISO-8601 UTC strings. Booleans are 0/1 integers.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL
);

-- id is the SHA-256 of the cookie token; the raw token is never stored.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE moves (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  source      TEXT NOT NULL,
  destination TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'packing', 'in_transit', 'delivered', 'completed')),
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE move_members (
  move_id    TEXT NOT NULL REFERENCES moves(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('mover', 'reviewer', 'owner')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (move_id, user_id, role)
);
CREATE INDEX move_members_user ON move_members(user_id);

CREATE TABLE rooms (
  id         TEXT PRIMARY KEY,
  move_id    TEXT NOT NULL REFERENCES moves(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (move_id, name COLLATE NOCASE),
  UNIQUE (id, move_id)
);

-- The composite foreign key makes the database reject a room from another move.
CREATE TABLE boxes (
  id         TEXT PRIMARY KEY,
  move_id    TEXT NOT NULL REFERENCES moves(id),
  room_id    TEXT,
  label      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sealed', 'delivered')),
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (move_id, label COLLATE NOCASE),
  UNIQUE (id, move_id),
  FOREIGN KEY (room_id, move_id) REFERENCES rooms(id, move_id)
);

CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  move_id     TEXT NOT NULL REFERENCES moves(id),
  box_id      TEXT,
  description TEXT NOT NULL,
  category    TEXT,
  fragile     INTEGER NOT NULL DEFAULT 0 CHECK (fragile IN (0, 1)),
  valuable    INTEGER NOT NULL DEFAULT 0 CHECK (valuable IN (0, 1)),
  status      TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'packed', 'delivered')),
  revision    INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (box_id, move_id) REFERENCES boxes(id, move_id)
);
CREATE INDEX items_move_box ON items(move_id, box_id);

CREATE TABLE audit_events (
  id          TEXT PRIMARY KEY,
  move_id     TEXT REFERENCES moves(id),
  actor_id    TEXT NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  action_id   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX audit_events_record ON audit_events(record_type, record_id);
CREATE INDEX audit_events_move_actor ON audit_events(move_id, actor_id, created_at);

-- One row per client action ID. Replays with the same payload return outcome_json.
CREATE TABLE submitted_actions (
  action_id    TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  operation    TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'failed')),
  outcome_json TEXT,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);
