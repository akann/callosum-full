# callosum-full

Private rehearsal build of the Callosum full-stack assignment: API key management with live propagation. This is the complete solution, built on top of `callosum-scaffold`. **Do not bring it to the interview**: the brief asks for no solution code beforehand.

- Design and the diagram to present: [docs/DESIGN.md](docs/DESIGN.md), [docs/diagram.svg](docs/diagram.svg)
- Mock behaviour and runtime controls: see the scaffold README (same mocks)

## Run

```bash
pnpm install
```

```bash
pnpm dev
```

Open http://localhost:5173. Postgres is on port 54330 (the scaffold uses 54329, so both can run). `pnpm db:seed` adds a few pre-existing keys. `TIME_SCALE=10 pnpm dev` makes the mocks ten times faster.

Things to try while it runs:

```bash
curl -X POST localhost:4002/__admin/config -H 'content-type: application/json' -d '{"outage": true}'
```

```bash
curl -X POST localhost:4001/__admin/config -H 'content-type: application/json' -d '{"rejectNext": 1}'
```

The first shows metering retries on the page until you set `outage` back to `false`; the second makes the next created key end as `failed` with its meter removed.

## Test

```bash
pnpm test
```

```bash
PW_CHANNEL=chrome pnpm e2e
```

`pnpm test` needs Postgres up (`pnpm db:up`); each test file creates and drops its own database. `pnpm e2e` starts the stack itself if it is not running. `PW_CHANNEL=chrome` uses the installed Chrome; without it, run `pnpm exec playwright install chromium` first.

| Suite | Covers |
|---|---|
| `apps/server/test/unit.test.ts` | key state machine, secret generation, backoff, circuit breaker |
| `apps/server/test/propagation.test.ts` | create → active, gateway reject → failed + meter removed, metering 503s and timeouts, revoke, revoke racing create, cancel of never-sent creates, outage of both downstreams, lease recovery, several workers |
| `apps/server/test/api.test.ts` | 401/403/404, validation, secret shown once, create replay, SSE snapshot + events + tenancy |
| `apps/server/test/burst.test.ts` | 2,000 revokes in 10 min at 20x speed: gateway-effective p99 and API p95 |
| `e2e/keys.spec.ts` | the page: secret once, live status, second admin sees changes within 2 s, member read-only |

## Where things are

```
db/migrations/002_propagation.sql        schema added to api_keys + the propagation_tasks outbox
packages/shared/src/index.ts             API contract (zod) shared with the page
apps/server/src/app.ts                   console API routes + SSE endpoint
apps/server/src/auth.ts                  stubbed auth, admin check
apps/server/src/keys/service.ts          create / revoke transactions, status settlement
apps/server/src/keys/status.ts           key state machine (pure)
apps/server/src/keys/repo.ts             key snapshot query, version bump + NOTIFY
apps/server/src/propagation/worker.ts    claim / call / apply loop
apps/server/src/propagation/clients.ts   gateway and metering calls reduced to outcomes
apps/server/src/live/hub.ts              LISTEN → SSE fan-out
apps/web/src/App.tsx, components/, lib/  the page
```

## Not built

- The reconciliation sweep against the downstreams described in the design (production hardening).
- Real authentication; `apps/server/src/auth.ts` trusts a dev cookie or headers.
