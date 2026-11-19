-- Existing table, exactly as given in section 04 of the brief.
CREATE TABLE api_keys (
  key_id      TEXT PRIMARY KEY,            -- 'key_' + ULID
  customer_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  prefix      CHAR(12) NOT NULL,           -- 'csk_live_a1b'
  key_hash    TEXT NOT NULL UNIQUE,        -- sha256
  status      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
