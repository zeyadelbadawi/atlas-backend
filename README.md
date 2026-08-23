# Atlas Backend

The Atlas API. This package currently implements **Backend Prompt 1 — Phase P0 (Foundation)** only, per the authoritative architecture reference:

**`../atlas frontend/Reports/ATLAS_BACKEND_MASTER_PLAN.md`**

Read that document before implementing any later phase — it is the single source of truth for architecture decisions, the database model, the API contracts, and the full phase-by-phase roadmap (P0–P18). Nothing in this README repeats content that lives there; this file only covers how to run *this* package.

## What exists today (P0)

- A NestJS application with no business/domain logic.
- Validated environment configuration (fails fast on a missing/malformed `DATABASE_URL`, `REDIS_URL`, or a production boot with no `CORS_ALLOWED_ORIGINS`).
- Structured (pino) logging with secret redaction.
- PostgreSQL connectivity via Prisma, proven by one non-domain table (`schema_meta`) — see `prisma/schema.prisma`'s own doc comment for why it's the *only* model in this phase.
- Redis connectivity via `ioredis`.
- A global exception filter producing the exact `NormalizedApiError` shape the frontend's `src/types/api.types.ts` defines.
- `GET /health` — a real Postgres + Redis round-trip check, not a stub.
- Global request validation, `helmet` security headers, a CORS allowlist, a global rate-limit foundation, and an `/api/v1` versioning prefix ready for Phase P1's first real endpoints.
- OpenAPI docs at `/api/docs` in non-production environments.

**Not in P0** (by design — see the master plan's P0 entry and this phase's own final report for the full list): any authentication, any tenant/organization concept, any domain table, any business endpoint.

## Prerequisites

- Node.js ≥ 20
- Docker (for local Postgres + Redis) — or point `DATABASE_URL`/`REDIS_URL` at instances you already run

## Local setup

```bash
cp .env.example .env
npm install
npm run docker:up          # starts Postgres + Redis
npm run prisma:migrate:dev # applies the schema_meta migration
npm run dev                # starts the API with hot reload
```

The API listens on `http://localhost:3000`. `GET /health` reports `{"status":"ok", ...}` once Postgres and Redis are both reachable. OpenAPI docs: `http://localhost:3000/api/docs`.

## Validation

```bash
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
npm run test          # unit tests — no external infrastructure required
npm run build         # nest build
npm run test:e2e      # requires `npm run docker:up` and a migrated database first
```

CI (`.github/workflows/ci.yml`) runs all of the above against real, ephemeral Postgres/Redis service containers on every PR.

## Project layout

```
src/
  main.ts              — bootstrap: logging, security headers, CORS, validation, versioning, Swagger
  app.module.ts         — root module; wires config/logging/db/redis/health, no domain modules yet
  config/                — env validation (Zod) + typed configuration factory
  common/
    filters/             — global exception filter + HTTP-status → ApiErrorKind mapping
    middleware/           — request-id/correlation-id middleware (NOT tenant context — that's P2)
    logging/               — pino configuration (redaction rules, dev pretty-printing)
    dto/                    — the NormalizedApiError contract, mirrored from the frontend's api.types.ts
  database/               — PrismaService/PrismaModule (global)
  redis/                   — RedisService/RedisModule (global)
  health/                   — GET /health + its Postgres/Redis indicators
prisma/
  schema.prisma            — the schema_meta table only (P0 scope)
test/
  health.e2e-spec.ts        — requires real Postgres/Redis
docker-compose.yml           — local Postgres + Redis only (not a production topology — see master plan §20)
```

## Next phase

Backend Prompt 2 — Phase P1 (Identity, Auth & Sessions) — not started. Do not begin it without explicit approval; see the P0 implementation report for what's still outstanding.
