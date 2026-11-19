-- Solution schema: everything the console needs on top of the existing api_keys table.

ALTER TABLE api_keys
  ADD COLUMN version             BIGINT      NOT NULL DEFAULT 1,   -- bumped on every visible change; orders live events
  ADD COLUMN updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN revoke_requested_at TIMESTAMPTZ,                      -- revoked_at is set when both systems confirm
  ADD COLUMN created_by          TEXT,
  ADD COLUMN revoked_by          TEXT,
  ADD COLUMN create_request_id   TEXT,                             -- client Idempotency-Key for POST /keys
  ADD CONSTRAINT api_keys_status_check
    CHECK (status IN ('provisioning', 'active', 'revoking', 'revoked', 'failed'));

CREATE INDEX api_keys_customer_created ON api_keys (customer_id, created_at DESC);
CREATE UNIQUE INDEX api_keys_create_request ON api_keys (customer_id, create_request_id)
  WHERE create_request_id IS NOT NULL;

-- The outbox. One row per (key, system, action); inserted in the same transaction as the
-- api_keys change that caused it. Holds no secret and no key_hash: workers read the hash from api_keys.
CREATE TABLE propagation_tasks (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id            TEXT        NOT NULL REFERENCES api_keys (key_id),
  system            TEXT        NOT NULL CHECK (system IN ('gateway', 'metering')),
  action            TEXT        NOT NULL CHECK (action IN ('create', 'delete')),
  -- queued: waiting to be (re)sent. submitted: gateway accepted it, we are polling the operation.
  state             TEXT        NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued', 'submitted', 'succeeded', 'failed', 'cancelled')),
  attempts          INT         NOT NULL DEFAULT 0,      -- send attempts (polls are not attempts)
  last_error        TEXT,
  -- True from the moment a send is claimed until the downstream gives a definite answer.
  -- A task that is queued and not uncertain has provably had no effect downstream.
  outcome_uncertain BOOLEAN     NOT NULL DEFAULT false,
  idempotency_key   UUID        NOT NULL DEFAULT gen_random_uuid(),  -- gateway Idempotency-Key, stable across retries
  operation_id      TEXT,                                            -- gateway operation being polled
  next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until      TIMESTAMPTZ,                                     -- worker lease
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ
);

CREATE INDEX propagation_tasks_due ON propagation_tasks (system, next_run_at)
  WHERE state IN ('queued', 'submitted');
CREATE INDEX propagation_tasks_key ON propagation_tasks (key_id, system, id);
