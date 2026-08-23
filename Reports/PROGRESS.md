# Atlas Backend — Progress

Backend-only progress log, distinct from the frontend's `Reports/PROGRESS.md`
(a Prompt-numbered frontend task log — unrelated content, do not conflate).
Updated once per phase, after that phase's implementation and verification
are complete — never mid-phase, never claiming a phase has started before
it has.

---

## Phase P0 — Foundation: COMPLETE, VERIFIED

NestJS scaffold, validated env config, Prisma/Redis connection layers,
structured logging with secret redaction, global `NormalizedApiError`
exception handling, health checks, security baseline (helmet/CORS/rate
limit/versioning), CI. No business/domain logic — by design.

Verified against real Docker Postgres + Redis: migration applies clean,
`/health` returns real dependency status, lint/typecheck/unit/e2e/build all
pass.

## Phase P1 — Identity, Auth & Sessions: COMPLETE, VERIFIED

`users`/`refresh_tokens`/`password_reset_tokens` tables. Full auth
lifecycle: register, sign-in, refresh (atomic rotation, proven safe under
real concurrent load), sign-out (single-session, via the access token's
`sid` claim), password reset (request/confirm, single-use, revokes all
sessions), profile/preferences/change-password. Argon2id, hashed opaque
tokens, Redis-backed rate limiting, BullMQ password-reset email
queue+worker (stub provider).

**Result:** 46 unit tests, 39 e2e tests (11 suites), all passing, run twice
consecutively with no flakiness. Two real bugs found and fixed during
verification (both documented in code): class-validator silently skipping
missing required fields (fixed with `@IsNotEmpty()` across every DTO), and
P0's exception filter discarding handler-supplied custom `messageKey`s
(fixed additively, no P0 test regressed).

## Phase P2 — Organizations, Membership & Multi-Tenancy Core: COMPLETE, VERIFIED

### What was built

- `organizations` / `organization_memberships` tables (master plan §5.2), migration `20260823181936_p2_organizations_tenancy_core`.
- `TenancyContextService` — the RLS session-variable mechanism (`runInTenantContext`, `runInUserContext`), transaction-scoped, request-safe by construction.
- `OrganizationMembershipGuard` — application-layer membership verification, itself running inside the same RLS context it establishes.
- `PlatformOwnerGuard` — wired, unattached to any route (Phase P15's job to use it).
- `GET /organizations/:id` — the one P2 endpoint (see "Scope narrowed" below).
- `CurrentUser.organizations`/`.organizationMemberships` — real, via `UserOrganizationsService`.
- RLS on both new tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`, SELECT/INSERT policies (see below), no UPDATE/DELETE policy on either table (denied by default).

### Critical finding #1 — RLS was completely inert against the superuser connection

Mid-verification, empirical raw-SQL testing showed every RLS policy being
silently bypassed — connecting with any session context, or no context at
all, returned every row regardless. Root cause: `docker-compose.yml`'s
`POSTGRES_USER` (`atlas`) is the Postgres cluster's initial superuser, and
Postgres never applies row security to a superuser connection, under any
circumstance, including `FORCE ROW LEVEL SECURITY` (which only overrides
the *table-owner* exemption, not the superuser one). This affected every
migration and the entire P0/P1 runtime too, though it had no observable
effect before P2 introduced the first RLS-protected tables.

**Fix:** a new, deliberately unprivileged role (`atlas_app`, no
`SUPERUSER`/`BYPASSRLS`), provisioned by migration
`20260823183500_p2_app_role_rls_enforcement`. `PrismaService` now connects
with a new `APP_DATABASE_URL` env var at runtime; `DATABASE_URL` (the
superuser) is used only by the Prisma CLI for migrations. Re-verified
empirically after the fix: tenant-context, user-context, and no-context
queries all behaved correctly.

### Critical finding #2 — the initial INSERT policies were unconditionally permissive

Caught by user review before being accepted: the first version of both
tables' INSERT policies used `WITH CHECK (true)`. Under the shared
`atlas_app` runtime role, this provided **zero** protection against a bug
or unreviewed code path creating an organization with an arbitrary
`owner_user_id`, or injecting an `organization_memberships` row granting
any user any role in any organization — a full membership-injection /
privilege-escalation vector, even though no P2 endpoint currently performs
either INSERT. "Nothing calls it today" was correctly identified as not a
valid justification for an unconditionally open policy, since the policy
governs the role, not the endpoint.

**Fix:** migration `20260823184500_p2_narrow_insert_rls_policies` replaces
both with the narrowest policy that still permits self-service creation:
an organization's `owner_user_id` must equal the caller's own verified id;
a membership row's `user_id` must equal the caller's own id **and** the
target organization's `owner_user_id` must also equal the caller. Three
concrete attack vectors (arbitrary-owner org creation, cross-user
membership injection, self-join into an org the caller doesn't own) were
attempted directly against the RLS layer and confirmed blocked; the one
legitimate self-bootstrap path was confirmed to still work. All of this is
now a permanent, automated test (`test/rls-organizations.e2e-spec.ts`),
not just a one-time manual check.

### Scope narrowed: no organization self-service CRUD

The master plan's P2 phase entry lists "org CRUD (self-service)" as
in-scope. Inspection of the actual frontend found no `OrganizationService`
or equivalent contract — the only organization-scoped frontend service
with real methods (`TenantService`) is subscription/usage/add-ons
(Phase P4/P12/P13), and organization-switching is entirely client-side
(`SessionService.switchOrganization`, selecting from already-fetched
`CurrentUser.organizations`, no backend call). Per standing instruction,
this was marked `SPECIFICATION-UNDEFINED` and not built. What P2 ships
instead: `GET /organizations/:id`, the minimal read primitive needed to
make tenant isolation testable/usable, membership-scoped. No
create/update/delete/list endpoint exists. This is a deliberate scope
decision, not an oversight — see ARCHITECTURE.md for the full reasoning.

### Tenant-isolation suite (master plan §18) — all 6 scenarios PASS

1. User A (Org 1 only) `GET`s Org 2 by direct id → 403/404, never 200. **PASS**
2. No crafted parameter widens a user's own-organizations read to include another tenant (`GET /users/me` accepts no scoping parameter at all — proven by attempting several anyway). **PASS**
3. `PATCH`/`DELETE` against an Org 2 resource never succeeds — no such route exists at all (404, structurally impossible rather than merely denied); organization row proven untouched afterward. **PASS**
4. A user in Org 1 *and* Org 2 can access both; the same user cannot access an Org 3 they don't belong to. **PASS**
5. Concurrent requests for different organizations (interleaved, `Promise.all`) never cross-contaminate — each response contains only its own organization's data. **PASS**
6. Direct database-level RLS proof, bypassing every guard/service entirely — tenant-scoped SELECT isolation, fail-closed with no session variable set, and the three INSERT attack vectors above. **PASS**

### Test results

| Layer | Result |
|---|---|
| Unit | 9 suites / 51 tests — PASS |
| Integration (real Postgres, via repositories/services) | folded into e2e below |
| API / contract | folded into e2e below |
| Authorization (`OrganizationMembershipGuard` unit + e2e) | PASS |
| RLS (direct, no guards) | 6/6 — PASS |
| Tenant isolation (6 scenarios) | 6/6 — PASS |
| E2E (full suite) | 14 suites / 54 tests — PASS, run twice consecutively, no flakiness |
| Lint | PASS |
| Typecheck | PASS |
| Build | PASS |
| Migrations (clean DB, from empty) | PASS — all 6 migrations apply in order |

Two test-infrastructure issues were found and fixed during verification
(neither a production bug): a per-IP sign-in rate-limit counter shared
across an entire e2e file could trip from that file's own fixture volume
(fixed by exposing a `flushRateLimitKeys` helper, called between tests);
and a coincidental near-match between `waitFor`'s default polling budget
and Jest's own default per-test timeout occasionally lost a race against
Jest's clock for the very first BullMQ job after a fresh app boot (fixed
with explicit longer per-test timeouts, not a slower assertion).

### P1 regression status

All P1 functionality remains green — every P1 e2e file (register, sign-in,
refresh + concurrency, sign-out, password reset, profile, preferences,
change-password, rate limiting, security/guard behavior) passed in the
same full-suite runs as P2's new tests, twice consecutively. `/health`
(P0) confirmed still working after all P2 changes.

### Deferred / not invented (P2)

- Organization self-service CRUD (create/rename/settings/delete) — `SPECIFICATION-UNDEFINED`, no frontend contract (see above).
- Membership management (invite/remove/change-role) beyond the one self-bootstrap INSERT path — no frontend contract, no P2 endpoint.
- Platform Owner Control Plane / cross-tenant APIs — explicitly Phase P15; `PlatformOwnerGuard` wired but unattached.
- Academies, courses, billing, subscriptions, provisioning, everything else outside P2's stated scope — untouched.

### Definition of Done

Master plan §21 P2 DoD: "the tenant-isolation suite's scenario 1–3 pass
against real Organizations." **Met and exceeded** — scenarios 1–6 (the
full §18 suite, not just 1–3) all pass against real Organizations, real
Postgres, real RLS.

---

## Next phase

**P3 — Academy Management.** Not started. Do not begin without explicit approval.
