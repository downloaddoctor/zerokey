-- ZeroKey state. Applied idempotently on every open.
--
-- Two tables: users and sessions. The nesting is provider -> user -> sessions,
-- mirroring the old temp/users.json shape. Credentials (parsed_fetch) live on
-- the user row; session state lives on the session row.
--
-- Rule: lifecycle data only, never prompt or response content.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per (provider, username). id is a UUID generated at wizard time.
-- Column names are snake_case; the JS layer sees camelCase via the proxy in
-- core/state/users.js and core/state/sessions.js.
CREATE TABLE IF NOT EXISTS users (
  id                      TEXT    PRIMARY KEY,
  provider                TEXT    NOT NULL,
  username                TEXT    NOT NULL,
  parsed_fetch            TEXT    NOT NULL,
  instructions_hash       TEXT,
  instructions_applied_at INTEGER,
  wait_until              INTEGER,
  wait_reason             TEXT,
  state_json              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (provider, username)
);

-- One row per (user, session name). user_id -> users.id, cascade on delete.
-- id and parent_id are the provider conversation UUID and last-message UUID.
-- state_json holds any key that is not in the column map above.
CREATE TABLE IF NOT EXISTS sessions (
  user_id            TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  id                 TEXT,
  parent_id          TEXT,
  generation         INTEGER NOT NULL DEFAULT 0,
  tool_calling       INTEGER,
  vision             INTEGER,
  model              TEXT,
  todos_json         TEXT,
  turn_count         INTEGER,
  dynamic_tools_hash TEXT,
  mcp_injected_json  TEXT,
  state              TEXT,
  metadata_json      TEXT,
  last_token_usage   INTEGER,
  usage_totals_json  TEXT,
  last_used          INTEGER,
  created_at         INTEGER,
  state_json         TEXT,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id, last_used DESC);
