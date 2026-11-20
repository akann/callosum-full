# CLAUDE.md

Complete rehearsal build of "API key management with live propagation" (the scaffold plus the solution). The brief is `../Callosum_FullStack_Engineering_Assignment.pdf`; the design it implements is `docs/DESIGN.md`; `README.md` maps the code.

## Commands

- `pnpm dev`: Postgres + migrations + gateway mock (4001) + metering mock (4002) + API (3000) + worker + web (5173), all with reload
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (Vitest; needs `pnpm db:up`), `PW_CHANNEL=chrome pnpm e2e` (Playwright)
- `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset`
- `TIME_SCALE=20 pnpm dev` speeds the mocks up 20x

## Conventions

- pnpm only. TypeScript strict, ESM, imports use explicit `.ts` / `.tsx` extensions (run with tsx, no build step).
- Postgres via `postgres` (postgres.js) tagged templates: `createDb()` in `apps/server/src/db.ts`. Transactions with `sql.begin(async (tx) => ...)`.
- Lock order in every write transaction: the `api_keys` row first (`lockKey`), then tasks. The worker claim takes task locks only and never a key lock.
- Every visible change must go through `touchKey` (version bump + NOTIFY) or the page will not update.
- Schema changes are new numbered files in `db/migrations/`; never edit `001_api_keys.sql` (it is the given table).
- API routes are Fastify handlers; request and response shapes belong in `packages/shared` as zod schemas so the page reuses the types.
- The page uses TanStack Query and Tailwind v4. `/api` is proxied to the API, including SSE.
- Mocks are in `mocks/`. Do not change their behaviour to make a test pass; toggle chaos through `/__admin/config` or the `config` option of `buildGateway` / `buildMetering`.

## Rules from the brief that are easy to break

- The secret is shown once and never stored, logged or queued. Downstreams and tables get only `key_hash`.
- Revoke works from `provisioning` or `active`, beats an in-flight create, and is never rolled back.
- The gateway may apply operations on one `key_id` out of order.
- Metering has no idempotency: a 409 may be our own earlier call; a timeout may have applied.
- The server must reject member writes; hiding buttons is not enough.
