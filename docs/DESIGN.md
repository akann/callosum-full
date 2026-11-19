# Design: API key management with live propagation

The one diagram to present is [diagram.svg](diagram.svg). This document is the reasoning behind it and the answers to the follow-up questions it invites.

## The problem in one paragraph

A key change must reach two systems we do not control. The gateway is asynchronous, slow (p99 60 s) and may apply operations on one key out of order. Metering is synchronous, fails 5% of the time, sometimes times out after applying, and has no idempotency. Either can be down for an hour. The console must stay fast (p95 < 200 ms), lose nothing, show per-system progress within 2 s, and make a revoke win over an in-flight create.

## Core idea

**The request path never calls a downstream.** A write is one Postgres transaction that changes `api_keys` and inserts rows into `propagation_tasks`, a transactional outbox. Workers drain the outbox at-least-once, and every downstream call is made idempotent from our side. Every visible change bumps a per-key `version` and issues `pg_notify`; the API fans that out over server-sent events.

Consequences:

- The API is as fast and as available as Postgres, whatever the downstreams are doing.
- "No change lost" is a property of one database commit, not of a distributed protocol.
- There is no second piece of infrastructure (broker, workflow engine) and so no dual-write problem.

## Data model

`api_keys` gains `version`, `updated_at`, `revoke_requested_at`, `created_by`, `revoked_by`, `create_request_id`, and an index on `(customer_id, created_at DESC)`.

`propagation_tasks`, one row per key × system × action:

| Column | Purpose |
|---|---|
| `key_id`, `system`, `action` | `gateway` or `metering`; `create` or `delete` |
| `state` | `queued` → (`submitted`) → `succeeded` / `failed` / `cancelled` |
| `attempts`, `last_error` | shown on the page |
| `outcome_uncertain` | true from the moment a send is claimed until the downstream gives a definite answer |
| `idempotency_key` | gateway `Idempotency-Key`, generated with the row, stable across retries |
| `operation_id` | gateway operation being polled |
| `next_run_at`, `locked_until` | scheduling and worker lease |

Tasks carry only `key_id`. The worker reads `key_hash` from `api_keys` when it sends. The secret is generated in the create handler, returned in that one response, and exists nowhere else: not in a table, a task, a log line or a notification.

## Key status

```
provisioning ──both systems confirm──▶ active ──revoke──▶ revoking ──both removed──▶ revoked
     │  └────────────────revoke (beats the create)────────────▲
     └──gateway rejects──▶ failed   (then remove its meter)
```

Status is derived by one pure function from the key's tasks, and every transition is a guarded update on the current status. Nothing ever leaves `revoking` or `revoked` for an earlier state, so a create result that arrives late cannot resurrect a key.

## The worker

1. **Claim** in a short transaction: due tasks for one system, `FOR UPDATE SKIP LOCKED`, take a 30 s lease. Claiming a send increments `attempts` and sets `outcome_uncertain` *before* any request leaves.
2. **Call** the downstream with no transaction open.
3. **Apply** the outcome in a transaction that locks the key row, updates the task, re-derives key status, bumps `version` and notifies.

A task is runnable only when every earlier task for the same key and system has settled. Deletes are claimed before creates.

Transient failures retry forever with jittered exponential backoff capped at 30 s. A per-downstream circuit breaker stops sending during an outage and probes with a single task, so recovery does not stampede. Nothing is ever abandoned for being old; task age is an alert, not a deadline.

### Gateway: out-of-order application

The gateway may apply a PUT after a later DELETE. The defence is per-key serialisation: **we never have two gateway operations for one key in flight.** A DELETE is not submitted until the PUT before it is terminal.

On revoke, inside the revoke transaction:

- A create that is `queued` and not `outcome_uncertain` has provably had no effect. It is cancelled and never sent.
- Any other unfinished create must be settled first. If its outcome is unknown (a timeout before the 202), the worker resubmits with the same `Idempotency-Key` to recover the operation, polls it to terminal, and only then sends the DELETE.

Cost: a revoke that races an in-flight create can take the PUT tail plus the DELETE tail. That is rare enough not to move the overall p99. The alternative worth discussing is an eager DELETE followed by a confirming DELETE once the PUT is terminal: faster in the common race, more operations, same guarantee.

`failed` on a PUT is a permanent rejection: the key becomes `failed` and a metering delete is queued as compensation. `failed` on a DELETE should not happen; revocation is never abandoned, so a fresh DELETE is queued after a delay and it should page someone.

### Metering: making a non-idempotent API idempotent

- Timeout 3 s. p99 is 2 s, so this cuts off roughly the hung 1%.
- `POST`: 201 or **409** is success. `key_id` is ours and unique, so a 409 can only be our own earlier call.
- `DELETE`: 204 or **404** is success.
- 503 retries and is *certain* (nothing was applied). A timeout retries and is *uncertain*.

Known residual risk: a POST we gave up on could in principle land after a later DELETE returned 404, leaving an orphan meter. Serialisation makes this very unlikely, because an uncertain POST is retried to a definite 201/409 before the DELETE runs. The belt-and-braces answer is a periodic reconciliation sweep that re-deletes meters for revoked keys.

### Create ordering: a trade-off to raise

Both systems are propagated in parallel, as the brief's mock shows, and `active` requires both. That leaves a window in which the gateway accepts a key that has no meter yet (unmetered usage). Gating the gateway PUT on metering success closes the window at the price of slower activation during a metering outage. It is one extra predicate in the claim query. Which is right is a product question: is brief unmetered usage worse than a key that will not activate?

## Console API

| Endpoint | Behaviour |
|---|---|
| `GET /api/v1/keys` | Caller's keys, each with the latest task per system |
| `POST /api/v1/keys` | `{ name }`, optional `Idempotency-Key`. 201 `{ key, secret }`, `Cache-Control: no-store`. A replay returns 409 with the key and no secret |
| `POST /api/v1/keys/{id}/revoke` | 202 on first call, 200 on repeats. 404 for another customer's key. 409 for a `failed` key |
| `GET /api/v1/keys/events` | SSE: `snapshot` on connect, then `key` events with `id: <version>` |

Auth is stubbed (a dev cookie or headers carrying `customer_id` and `role`). Writes require `admin` and are rejected with 403 on the server; hiding buttons for members is cosmetic. Every query is scoped by `customer_id`.

Create cannot be fully idempotent, because the secret is not stored and so cannot be returned twice. A replay therefore gets a 409 that says so, rather than a second key.

## Live updates

- One `LISTEN` connection per API instance, regardless of viewer count. 500 SSE connections is small.
- A notification carries `{customer_id, key_id}` only. The hub re-reads the key and pushes the snapshot to that customer's subscribers, coalescing bursts over 25 ms.
- **State transfer, not an event log.** A missed notification is repaired by the next one. A reconnect, by the browser or by our listener, is repaired by sending a full snapshot. Nothing needs replaying, so there is no event table to retain.
- The client keeps the highest `version` per key and drops anything older, which makes the snapshot/event race harmless.
- Elapsed timers tick in the browser from task timestamps, corrected by the server clock offset in the snapshot.
- Gateway operations are polled every 1 s, which bounds how stale "in progress" can be.

## Volumetrics

| Requirement | How it is met |
|---|---|
| 2,000 revokes in 10 min | 3.3/s. With 20 concurrent slots per downstream the queue wait is negligible |
| Revocation effective p99 ≤ 90 s | Our overhead is milliseconds, leaving the gateway's own 60 s p99 |
| Status on page ≤ 2 s | NOTIFY → SSE is tens of ms; gateway completion is seen within the 1 s poll |
| Outage up to 1 h, nothing lost | Tasks stay queued in Postgres; backoff has no give-up |
| API p95 < 200 ms | Single-transaction writes, indexed reads, no downstream calls |
| 50,000 keys, 500 viewers | About 10 keys per customer per snapshot; one LISTEN per instance |

## Likely follow-up questions

**What if a worker dies mid-call?** Its lease expires and another worker repeats the call. That is safe because the gateway call reuses the stored `Idempotency-Key` and metering treats 409/404 as success. The task was marked uncertain before the call, so a revoke will not wrongly cancel it.

**What if NOTIFY is lost?** NOTIFY is only an accelerator. Workers also poll for due tasks every 250 ms. The SSE hub resends full snapshots when its listener reconnects, and each client gets a snapshot when it reconnects.

**Why not a queue or a workflow engine?** At 2,000 operations a day Postgres is far from a bottleneck, and the outbox has to exist anyway to avoid a dual write. A broker would add a system to operate without removing one. I would revisit at several orders of magnitude more volume or with many more downstreams.

**How does it scale out?** API instances are stateless apart from their SSE connections. Workers coordinate only through `SKIP LOCKED`. The first limit would be Postgres write volume from poll bookkeeping, addressed by batching polls or widening the poll interval for old operations.

**A third downstream?** Add a value to `system`, a client that maps responses to the same small outcome type, and its term in the status function. Claiming, retries, the breaker and the page are already generic.

**Where could the secret leak?** Request logging records metadata only, never bodies. The response is `no-store`. The page keeps the secret in component state only, so reload drops it.

**What would you add for production?** Real authn/authz, an audit trail, a reconciliation sweep against both downstreams, metrics (queue depth, task age, revoke latency histogram) with alerts, rate limiting on create, and retention for old tasks.
