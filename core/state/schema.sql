-- ZeroKey state. Applied idempotently on every open.
--
-- Rule: lifecycle data only, never content. Prompt text, response text, and
-- attachment bytes have no columns here on purpose.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per (provider, session id). The session id is whatever the client
-- considers its own session key; the provider name namespaces it so a
-- DeepSeek session and a ChatGPT session with the same id do not collide.
--
-- compaction_generation tracks the client's compaction counter. When the
-- client reports a higher generation, the upstream conversation is rebound:
-- upstream_* are cleared and the old conversation ID is moved into
-- metadata_json.pendingPreviousConversationIds for retirement on the next
-- successful turn.
CREATE TABLE IF NOT EXISTS sessions (
  provider                TEXT    NOT NULL,
  session_id              TEXT    NOT NULL,
  upstream_conversation_id TEXT,
  upstream_parent_message_id TEXT,
  compaction_generation   INTEGER NOT NULL DEFAULT 0,
  state                   TEXT    NOT NULL DEFAULT 'idle',
  metadata_json           TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  PRIMARY KEY (provider, session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated
  ON sessions(updated_at DESC);

-- One row per (provider, session id) -> user mapping imported from the legacy
-- temp/users.json the first time the database is opened. Read-only thereafter.
CREATE TABLE IF NOT EXISTS legacy_import (
  provider   TEXT    NOT NULL,
  username   TEXT    NOT NULL,
  session_id TEXT    NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (provider, username, session_id)
);
