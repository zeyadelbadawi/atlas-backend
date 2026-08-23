# Atlas Backend — Architecture

Backend-only documentation, distinct from the frontend's `Reports/ARCHITECTURE.md`
(a Prompt-numbered frontend feature log — unrelated content, do not conflate).
The authoritative source of truth for intended scope remains
`Reports/ATLAS_BACKEND_MASTER_PLAN.md`; this file records what has actually
been **built and verified**, phase by phase, updated once per phase after
that phase's implementation and verification are complete — never mid-phase.

---

## Stack (as implemented, P0–P2)

- **Framework:** NestJS 10 / TypeScript, `strict: true`.
- **Database:** PostgreSQL 16, via Prisma 5 (`@prisma/client`).
- **Cache / rate-limit / queue broker:** Redis 7 (`ioredis` for direct use, `bullmq` for jobs).
- **Auth:** JWT access tokens (`@nestjs/jwt`) + rotating opaque refresh tokens (SHA-256 hashed at rest), Argon2id password hashing.
- **Validation:** `class-validator`/`class-transformer` via a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`).
- **Logging:** `nestjs-pino`, structured JSON, secret-redacting.
- **Local infra:** `docker-compose.yml` (Postgres + Redis only — no self-hosted containers in staging/production, see master plan §20).

## Module graph (as of P2)

```
AuthCoreModule (leaf: ConfigService only)
  ├─ AccessTokenService
  └─ JwtAuthGuard
       ↑                              ↑
  IdentityModule                 TenancyModule
  (P1 + P2 CurrentUser org data)  (P2: orgs, memberships, RLS)
       │                               ▲
       └───────── imports ─────────────┘
        (identity needs UserOrganizationsService;
         tenancy never imports identity — one direction only)
```

`AuthCoreModule` exists specifically to keep this a DAG: Phase P2 introduced
a real dependency from identity → tenancy (`CurrentUser.organizations` needs
real membership data) while tenancy's own controller needs `JwtAuthGuard`.
Housing the guard/token-service pair in their own dependency-free module
lets both import it without a cycle, rather than reaching for `forwardRef`.

## Database connections (critical, P2)

Two separate `DATABASE_URL`-shaped connection strings exist, and mixing
them up silently breaks Row-Level Security:

| Env var | Role | Who uses it | Privileges |
|---|---|---|---|
| `DATABASE_URL` | `atlas` | Prisma CLI only (`migrate`, `generate`) | Postgres **superuser** |
| `APP_DATABASE_URL` | `atlas_app` | `PrismaService` at runtime — every application query | No `SUPERUSER`, no `BYPASSRLS` |

**Why two roles, not one:** discovered during P2 verification — Postgres
never applies row security to a superuser connection, under any
circumstance, including tables with `FORCE ROW LEVEL SECURITY` (empirically
verified: with `atlas`, every RLS test returned all rows regardless of
session context; with `atlas_app`, isolation worked correctly). The
`atlas_app` role is provisioned by
`prisma/migrations/20260823183500_p2_app_role_rls_enforcement`, with grants
that auto-extend to future tables via `ALTER DEFAULT PRIVILEGES`. The
role's password is a literal baked into that migration — acceptable for
local/CI databases seeded from scratch by the same migration, explicitly
**not** how a production credential should be provisioned (see that
migration's own comment).

## Multi-tenancy / RLS (P2)

Three enforcement layers, all present and independently verified to matter
(master plan §7):

1. **Column-level** — every tenant table carries a real `organization_id` FK, never inferred only.
2. **Application-layer** — `OrganizationMembershipGuard` verifies the authenticated user has an active `organization_memberships` row for the requested `:id` before any handler runs.
3. **PostgreSQL RLS** — policies on `organizations`/`organization_memberships`, enabled with `FORCE ROW LEVEL SECURITY`, keyed to two session variables:
   - `app.current_organization_id` — single-tenant context, set via `TenancyContextService.runInTenantContext(orgId, work)`. Used for every org-scoped read/write.
   - `app.current_user_id` — user-scoped context, set via `TenancyContextService.runInUserContext(userId, work)`. Exists specifically because `CurrentUser.organizations` is a genuinely cross-tenant-by-user query (a user may belong to several organizations) that a single-org session variable structurally cannot answer — see `prisma/migrations/20260823182500_p2_self_membership_rls_policies`.

Both variables are set via `set_config(name, value, true)` (the `true` =
transaction-local, equivalent to `SET LOCAL`), never string-interpolated
`SET LOCAL` SQL — Postgres's `SET` command doesn't accept bound parameters;
`set_config()` is a normal function call and does. Each call opens its own
Postgres transaction (`prisma.$transaction`), so the setting is undone
automatically on commit/rollback and is invisible to any concurrent
transaction on a different pooled connection — this is what makes tenant
context request-safe without any global mutable state anywhere in the
codebase. Verified directly under concurrent load (see PROGRESS.md, P2
tenant-isolation scenario 5).

### RLS command coverage (deliberate, not partial)

- **SELECT** — the primary, security-critical guarantee; strictly scoped per above.
- **INSERT** — narrowed after a security review caught an initial `WITH CHECK (true)` mistake (see PROGRESS.md's P2 entry for the full finding). Final policies: `organizations` requires the new row's `owner_user_id` to equal the caller's own verified id; `organization_memberships` requires both `user_id = caller's own id` AND the target organization's `owner_user_id` to also equal the caller — i.e. "you can create an organization for yourself, and bootstrap your own owner-membership in it," nothing broader. No P2 endpoint exercises INSERT at all (see "What P2 does not implement" below); this is forward-looking safety for whichever future phase (P14 provisioning) adds a real creation flow.
- **UPDATE / DELETE** — no policy defined for either command on either table. Under Postgres RLS, no policy for a command means that command is denied entirely, regardless of context — enforced at the database level, not merely by omitting a controller route.

## Identity (P1) + real organization data (P2)

`CurrentUser.organizations`/`.organizationMemberships` (identical arrays,
populated the same way — the frontend type declares them as two separate
fields with no distinguishing semantics) are resolved by
`UserOrganizationsService.getMembershipsForUser(userId)`, which runs both
the membership query and the organization-name lookup inside one
`runInUserContext` transaction so the two RLS policies involved
(`organization_memberships_self_select`, `organizations_member_select`)
apply together. Wired into every place `CurrentUser` is returned:
sign-in, `GET /users/me`, `PATCH /users/me`, `PATCH /users/me/preferences`.

## What P2 does not implement, and why

The master plan's P2 phase entry describes "org CRUD (self-service)" as
part of its scope. On inspection, **no such frontend contract exists** —
`TenantService` (the only organization-scoped frontend service with real
methods) is entirely subscription/usage/add-ons, explicitly Phase
P4/P12/P13 scope; `PlatformOrganizationService` is the cross-tenant
Platform Owner view, Phase P15 scope; org-switching
(`SessionService.switchOrganization`) is pure client-side selection from
already-fetched `CurrentUser.organizations`, calling no backend endpoint at
all. Per the standing rule ("if the frontend contract is silent about a
capability, mark it SPECIFICATION-UNDEFINED and do not implement it"), P2
ships exactly one endpoint: `GET /organizations/:id` — the minimal primitive
needed to make the tenant-isolation guarantee testable and usable at all,
membership-scoped, read-only. No create/update/delete/list endpoint exists.
See PROGRESS.md's P2 entry for the full reasoning.

## Platform Owner wiring (P2)

`users.is_platform_owner` → `CurrentUser.roles` includes `'platform_owner'`
(done in P1, unchanged). New in P2: `PlatformOwnerGuard`
(`src/identity/guards/platform-owner.guard.ts`) — re-reads
`is_platform_owner` from the database on every check (never trusts a JWT
claim; P1's access tokens deliberately carry no role claims at all).
Deliberately unattached to any route — no Platform Owner Control Plane
endpoint exists yet (Phase P15). Exported from `IdentityModule` so P15 can
apply it directly rather than rebuilding it.

## Testing architecture (P0–P2)

- **Unit** (`src/**/*.spec.ts`) — infra-free, mocked, run via `npm test`.
- **E2E** (`test/**/*.e2e-spec.ts`) — real Postgres + Redis, no mocks, run via `npm run test:e2e`, `maxWorkers: 1` (deterministic ordering matters: shared rate-limit counters, a shared persistent database with no per-run cleanup).
- **Fixture strategy:** identity fixtures (users, tokens) are created via the app's own restricted `PrismaService`/HTTP surface. Tenancy fixtures (organizations, memberships) are seeded via a dedicated superuser Prisma connection (`test/utils/db-admin.ts`, `DATABASE_URL`) — deliberate, not a workaround: the narrowed RLS INSERT policies intentionally don't support "seed an arbitrary org+membership graph" through the restricted runtime role, any more than a real onboarding flow would.
- **RLS-specific tests** (`test/rls-organizations.e2e-spec.ts`) — talk to Postgres directly via `TenancyContextService`/raw Prisma, bypassing every guard and service; if these pass, it's because the database itself enforced the rule, independent of application code correctness.
- **Tenant-isolation suite** (`test/tenant-isolation.e2e-spec.ts`) — CI-blocking from P2 onward per master plan §18; covers the 6 mandatory scenarios end-to-end through the real HTTP surface.

## Environment variables introduced by phase

| Var | Phase | Purpose |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL`, `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`, `PORT`, `NODE_ENV` | P0 | Foundation |
| `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `PASSWORD_RESET_TOKEN_TTL_MINUTES`, `AUTH_SIGNIN_RATE_LIMIT_*`, `AUTH_PASSWORD_RESET_RATE_LIMIT_*` | P1 | Identity/Auth/Sessions |
| `APP_DATABASE_URL` | P2 | RLS-enforcing runtime DB connection |
