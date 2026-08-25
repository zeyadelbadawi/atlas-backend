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

---

## Organization Management Completion (full-stack, post-P2): AUTOMATED VERIFICATION PASS — MANUAL VERIFICATION PENDING

Not a new backend phase — a closure pass on the frontend, making P2's
already-built tenant infrastructure actually usable through the product.
Zero backend code changed; P2's own automated suite was re-run twice to
confirm no regression (14 suites / 54 tests, both runs green).

### Gap matrix (summary — full matrix was presented and approved before implementation)

| Capability | Frontend before | Backend | Classification |
|---|---|---|---|
| Active organization state/cache-invalidation | Built, unused | P2, real | Reuse |
| Organization switcher UI | **Missing** | n/a | **IMPLEMENT NOW** |
| Organization overview page | **Missing** (`/dashboard/tenant` is billing only) | P2 `GET /organizations/:id` | **IMPLEMENT NOW** |
| Own-membership list | Built (`ProfileAccountSection`) | P2, real | Reuse, now shows real data |
| Organization settings/rename | Missing | Missing | `SPECIFICATION-UNDEFINED` |
| Membership management | Missing | Missing | `SPECIFICATION-UNDEFINED` |
| Role assignment | Missing | Missing | `SPECIFICATION-UNDEFINED` (master plan §9: no catalog) |
| Organization creation | Missing | Missing | Future (Phase P14 provisioning) |

### What was implemented (frontend only)

- `src/types/tenant.types.ts` — added the bare `Organization`/`OrganizationStatus` types (didn't exist anywhere before).
- `src/features/organization/services/OrganizationService.ts` — `GET /organizations/:id`, read-only.
- `src/features/organization/hooks/useOrganization.ts` — keyed off the real active organization, matching `useTenantSubscription`'s pattern.
- `src/features/organization/pages/OrganizationOverviewPage.tsx` — new route `/dashboard/organization`, loading/error/empty states.
- `src/shared/components/controls/OrganizationSwitcher.tsx` — the dropdown; wired into `DashboardTopbar` via `DashboardLayout`'s existing `actions` slot. Placed alongside `LanguageSwitcher`/`ThemeSwitcher` (shared control, not a feature-owned component) after the initial placement inside the feature folder was caught by the codebase's own `no-restricted-imports` lint rule.
- Navigation: new `organization` section/item in `navigation.config.ts`, no permission gate (organization membership itself — verified server-side — is the real gate here, not a permission string; nothing in this domain has ever populated organization-scoped permission strings).
- i18n: new `organization` namespace, EN + AR, registered in `TRANSLATION_NAMESPACES` and the resource bundle.

### Real bug caught during implementation, not just at review

`OrganizationSwitcher` was first placed inside `src/features/organization/components/`, and `DashboardLayout` (the dashboard shell) imported it directly. The project's own ESLint `no-restricted-imports` rule caught this immediately: the shell must not reach into a feature's internals. Fixed by moving the component to `shared/components/controls/`, matching where `LanguageSwitcher`/`ThemeSwitcher` already live — the correct architectural home for a shell-level global control, not a feature-owned business component.

### Automated verification results

| Layer | Result |
|---|---|
| Backend typecheck/lint/unit/build | PASS (unchanged from P2, re-confirmed) |
| Backend e2e (14 suites / 54 tests) | PASS, twice consecutively |
| Frontend typecheck | PASS — 18 pre-existing, unrelated errors (documented baseline in the frontend's own `Reports/PROGRESS.md`, e.g. `PortableTextRenderer.tsx`); zero new errors, zero organization-related errors |
| Frontend lint | PASS (0 errors after the `no-restricted-imports` fix above) |
| Frontend build | PASS — `OrganizationOverviewPage` confirmed shipping as its own lazy chunk |
| Frontend automated tests | **None exist in this repository** (no test framework configured, a pre-existing condition predating this pass — not invented here; see `atlas frontend/README.md`/original context-recovery findings). Frontend correctness for this pass rests on typecheck + lint + build + the manual runbook below. |

**AUTOMATED VERIFICATION: PASS**

### Security verification

No backend authorization/RLS code was touched. The one new frontend→backend
call (`GET /organizations/:id`) uses the organization id from
`useAuth().organization` — already validated against the signed-in user's
real memberships by the existing session-restoration logic, never a raw
client-supplied value from routing/URL state. The backend independently
re-verifies membership via `OrganizationMembershipGuard` + RLS on every
call regardless of what the frontend sends (proven by P2's own
tenant-isolation suite, re-run green above). `ORG-MANUAL-006` in the
runbook is the direct manual proof of this against a live server.

### Manual verification

**MANUAL VERIFICATION: PENDING USER TESTING**

Runbook: `Reports/MANUAL_TEST_RUNBOOK.md` (11 test cases, `ORG-MANUAL-001`
through `ORG-MANUAL-011`, covering sign-in entry, overview display,
switching, persistence, two dedicated security scenarios, empty state,
loading/error/retry, Arabic/RTL, responsive, and keyboard accessibility).

```
MANUAL TESTS
Total: 11
Generated: 11
Completed by human: 1
Passed: 1  (ORG-MANUAL-001, after fix — see "Fix pass" entry below)
Failed: 0
Blocked: 0
Remaining: 10 (ORG-MANUAL-002 through ORG-MANUAL-011, not yet run)
```

### Deferred / not invented

Same list as the gap matrix's `SPECIFICATION-UNDEFINED` rows: organization
settings/rename, membership invite/remove/change-role, role assignment UI.
Organization creation remains Phase P14 (provisioning) — out of scope here
and untouched.

### Phase closure status

Per the standing rule: automated-verified is not the same as fully closed.
This entry stays **MANUAL VERIFICATION PENDING** until the user runs the
runbook and reports results back.

### Fix pass — ORG-MANUAL-001 (2026-08-24)

Human manual testing failed `ORG-MANUAL-001`: sign-in succeeded at the
network level (200, real tokens) but the browser never left `/auth/sign-in`.

- **Root cause:** `src/shared/hooks/useSignIn.ts` called
  `authenticationService.signIn()` directly instead of `useAuth().signIn()`
  — tokens were never persisted and `IdentityContext`'s session state was
  never updated, so `isAuthenticated` stayed `false` and no redirect logic
  (`RouteGuard`, `SignInPage`'s own effect) ever fired. Pre-existing bug,
  unrelated to the Organization Management work itself; only manual browser
  testing could catch it, since the frontend has no automated test suite.
- **`/api/config` error:** confirmed **independent** — legacy runtime-config
  loader (`src/lib/config.ts`) from the original template scaffold, caught
  internally, never touches the real API client. Not touched.
- **Fix:** `src/shared/hooks/useSignIn.ts` — delegate to `useAuth().signIn`.
- **Backend changes:** NONE for the root-cause fix itself. One additional,
  separately-discovered fix while re-running regression verification: an
  environment-scoped BullMQ queue prefix (`app.module.ts`) so the e2e
  suite no longer races a concurrently-running `npm run dev` instance for
  the same Redis queue (was producing intermittent, misleading `waitFor`
  timeouts in `auth-password-reset.e2e-spec.ts` — confirmed as the actual
  cause, not load/timing, by observing e2e runtime drop from 136s to ~17s
  once isolated). Also widened `waitFor`'s own default polling budget
  (5000ms → 10000ms, `test/utils/test-app.ts`) as defensive headroom.
- **Automated verification after fix:** frontend typecheck PASS (18
  pre-existing unrelated errors, 0 new), lint PASS, build PASS. Backend
  typecheck/lint/build PASS, unit 51/51 PASS, e2e 54/54 PASS twice
  consecutively (~17s each, deterministic).
- **Security impact:** none — no authorization/RLS/tenant-isolation code
  touched; the fix only corrects the frontend's own client-side session
  bookkeeping after an already-successful, already-verified backend
  authentication call.
- **Manual verification:** `ORG-MANUAL-001` marked **RETEST REQUIRED** in
  `Reports/MANUAL_TEST_RUNBOOK.md` (full retest history recorded there) —
  not marked PASS. Waiting for the human tester to repeat it.

### ORG-MANUAL-001 — human retest confirmed PASS (2026-08-24)

The human tester repeated `ORG-MANUAL-001` after the fix: sign-in now
correctly redirects from `/auth/sign-in` to `/dashboard`; the dashboard and
`/dashboard/organization` both correctly show the "No Organization" state
for this membership-less test account. **`ORG-MANUAL-001` is CLOSED —
PASS.** Recorded in `Reports/MANUAL_TEST_RUNBOOK.md`'s retest history
(Attempt 2) and Human Feedback Log.

Re-verification run for this confirmation (no code changed since the fix
pass above): backend e2e 14 suites / 54 tests PASS (~22s); frontend
typecheck 18 pre-existing/unrelated errors, 0 new, PASS; frontend lint
PASS.

**Findings logged, not fixed (out of scope, per explicit instruction):**
during exploratory navigation after completing the required test steps,
the tester separately observed (1) `/api/config` returning 500 — already
root-caused above as the independent legacy `lib/config.ts` loader; (2)
`/dashboard/profile` throwing `"useBlock must be used within a data
router"` from `useUnsavedChanges`/`ProfilePersonalSection`; (3)
`/dashboard/notifications` showing a generic "Unexpected error" state.
Neither (2) nor (3) has been investigated — both are pre-existing,
unrelated features, untouched by this or the prior Organization Management
pass. Recorded in `Reports/MANUAL_TEST_RUNBOOK.md`'s new "Known Findings"
section for a future, separately-scoped investigation. No code changed for
any of the three.

---

## P3 — Academy Management (2026-08-24)

**Status: COMPLETE.** `academies`/`academy_members` tables, full RLS,
`AcademyModule` (repositories, service, two guards, controller), and every
`AcademyService` (frontend) method backed by a real endpoint. Automated
verification PASS (typecheck/lint/build/unit/e2e, zero regressions).
**Manual verification: PENDING USER TESTING** — see
`MANUAL_TEST_RUNBOOK.md`'s P3-MANUAL-001..018.

### Product decision required and resolved before implementation

Tracing the actual frontend code end-to-end (`AcademyService.ts`,
`useAcademies.ts`, `http-client.ts`, `api-client.ts`) found that **no
channel carries `organizationId` to `GET /academies` or `POST /academies`
today** — not a header, query param, or body field; `CreateAcademyPayload`
has no such field. Every other Academy route is unambiguous
(`academies/:id/*`, matching the master plan's own §10 table), so this
blocked only the two flat collection routes, but every one of the 9
endpoints depends on resolving "the active organization" — this was
surfaced to the user rather than guessed at (three options presented:
explicit param, default-to-primary-org, or defer). **Decision: require
`organizationId` as an explicit request field** — a query param on `GET
/academies`, a required body field on `POST /academies` — matching P2's
own "tenant context is always explicit, never ambient" precedent. The
frontend does not send this field yet; that is a tracked, separate,
frontend-side gap (not fixed here — backend-only phase), the same
disposition given to the `/api/config`/profile/notifications findings from
the prior pass.

### RLS design — transitive tenant ownership, two-step bootstrap

Academy read/write RLS resolves tenant ownership transitively
(`academy → organization_id`), reusing the exact P2 session-variable
mechanism (`app.current_organization_id`, `app.current_user_id`) — no new
session variable, no `app.current_academy_id`, no second tenant/membership
mechanism. The one new problem P2 never had: an `/academies/:id/*` caller
supplies only an academy id, never an organization id, so nothing can seed
`runInTenantContext` before the organization id (the very column RLS is
protecting) is known. Solved with a two-step guard
(`AcademyScopeGuard`), mirroring P2's own `organizations_member_select`
precedent one level down:
1. Bootstrap read under `runInUserContext` (`app.current_user_id` only),
   permitted by a new additive SELECT policy,
   `academies_org_member_select` — visible iff the caller belongs to the
   owning organization. Once visible, `organization_id` is a plain,
   readable column (RLS gates rows, not columns).
2. Re-establish `runInTenantContext` with that id and independently
   re-verify organization membership — never trusting step 1's read alone,
   matching `OrganizationsService.getById`'s "never trust the guard's own
   read" discipline.

Two migrations: `20260823220306_p3_academy_management` (tables +
tenant-scoped SELECT/INSERT, narrow — not `WITH CHECK (true)`, learning
directly from P2's own corrected mistake) and
`20260823221639_p3_academy_scope_and_update_rls` (the bootstrap SELECT
policy above, plus the UPDATE policy — added in this phase because this is
the phase that adds the UPDATE capability, per §17's "policy lands with
the capability" rule; both `USING`/`WITH CHECK` require
`organization_id` to match the active context, making `organization_id`
reassignment structurally impossible). No DELETE policy on either table —
`DELETE /academies/:id` is a status-transition UPDATE (`archived`), never
a SQL DELETE, matching `organizations`' own no-hard-delete precedent.

Empirically proven twice: once by hand via `docker exec ... psql` as the
real `atlas_app` role (fail-closed with no context, tenant SELECT
isolation, bootstrap success/failure, all 5 attack vectors blocked, all
legitimate paths allowed) **before any application code was written**,
then made permanent as `test/rls-academies.e2e-spec.ts` (13 tests, zero
guards/services/HTTP involved — pure DB-level proof, mirroring
`rls-organizations.e2e-spec.ts`).

### Authorization split — read vs. write, and why org-owner ≠ Academy-owner

Per the explicit instruction not to assume organization ownership implies
unrestricted Academy Owner rights: **READ** (list/detail/members/stats/
activity) is governed by organization membership alone — matching the
frontend's own `getAcademies` doc comment ("for the active organization"),
not a narrower rule the frontend never asked for. **WRITE**
(create/update/branding/archive) additionally requires an `academy_members`
row with role `owner` or `administrator` for that specific academy
(`AcademiesService.assertCanManage`) — an organization member with no
academy-level role is provably unable to write (see P3-TENANT-010).
`POST /academies` is the one exception (no academy exists yet to hold a
role): any organization member may create one, and becomes its first
`owner`-role member automatically, in the same transaction as the academy
insert.

### What was honestly left unimplemented, not faked

- `GET /academies/:id/activity` returns a real, empty paginated page — no
  activity/event-log table exists anywhere in this backend
  (`audit_log_entries` is unbuilt Platform Owner scope). Documented
  `SPECIFICATION-UNDEFINED`: which domain events should populate this feed
  has never been specified.
- `AcademyStats.publishedCourses` is honestly `0` — no `courses` table
  exists (Course Management is explicitly out of P3 scope).
Both mirror the disposition already reached for the Notifications frontend
finding in the prior pass: an honest reflection of real backend state, not
mock data standing in for an error.

### Verification

Typecheck PASS, lint PASS (0 errors after `--fix` for formatting only),
build PASS, format:check PASS. Unit 11 suites / 59 tests PASS (8 new for
the two academy guards). E2e 17 suites / 84 tests PASS, zero regressions
(14 pre-existing suites / 54 tests still green, +3 new suites / 30 new
tests: `academies.e2e-spec.ts`, `academies-tenant-isolation.e2e-spec.ts`
[P3-TENANT-001..010], `rls-academies.e2e-spec.ts`). Full happy-path smoke
test also run against real Docker Postgres/Redis via `curl` (register →
sign-in → create org/membership via admin psql → create/get/list/update/
branding/members/stats/activity/archive academy) — every response matched
the frontend's exact contract shape.

CTO audit: no TODO/FIXME/HACK/console.log/hardcoded UUIDs/`any`/
`eslint-disable`/`WITH CHECK (true)` in any new P3 code; no direct
`PrismaService` usage bypassing `TenancyContextService` in the academy
module; no second JWT/session/auth implementation (the controller reuses
`JwtAuthGuard` from `AuthCoreModule`, unchanged); no new session variable
beyond `app.current_organization_id`/`app.current_user_id`.

### `Reports/ATOMS.md`

Does not exist in this repo (checked: `Reports/` contains only
`ARCHITECTURE.md`, `PROGRESS.md`, `MANUAL_TEST_RUNBOOK.md`). Treated as
N/A — not fabricated.

## P4 — Plans, Subscription & Entitlements (2026-08-24)

**Status: COMPLETE (automated).** `plans`/`add_ons`/`tenant_subscriptions`/
`tenant_add_ons`/`tenant_usage`/`trial_policy` tables, RLS, `PlansService`/
`TenantSubscriptionService`/`EntitlementService`, the
`tenant-usage-recompute` worker, and every `PlanService`/`TenantService`
(frontend) method backed by a real endpoint. Automated verification PASS
(typecheck/lint/build/unit/e2e/clean-migration, zero regressions).
**Manual verification: PENDING USER TESTING** — see
`MANUAL_TEST_RUNBOOK.md`'s P4-MANUAL-001..016.

### Scope

Tables: `plans`, `add_ons`, `tenant_subscriptions`, `tenant_add_ons`,
`tenant_usage`, `trial_policy` (master plan §5.6, in full). Endpoints:
`GET /plans`, `GET /plans/:key`, `GET /add-ons`, `GET /add-ons/:key`,
`GET /trial-policy`, `PATCH /trial-policy` (role-gated), `GET
/organizations/:id/subscription`, `GET /organizations/:id/usage`, `GET
/organizations/:id/add-ons`. No checkout/payment/subscription-mutation
endpoint exists — matches `TenantService`'s own "zero write methods" rule
exactly; `updateTrialPolicy` is the one legitimate write, exactly as
scoped.

### Platform-owned vs. organization-owned — two different RLS postures, correctly separated

`plans`/`add_ons`/`trial_policy` carry no `organization_id` and get **no**
RLS policy at all — every authenticated caller reads the same catalog,
proven directly (not just asserted) by
`rls-tenant-subscriptions.e2e-spec.ts`'s first test: a `plans` row is
readable through the app's own restricted `atlas_app` connection with
**zero** session context set. `tenant_subscriptions`/`tenant_add_ons`/
`tenant_usage` reuse the exact P2/P3 `app.current_organization_id`
mechanism — no new session variable, no second tenant mechanism. Two
migrations: `20260823225822_p4_plans_subscription_entitlements` (tables +
narrow SELECT/INSERT policies — never `WITH CHECK (true)`, learned
directly from P2's own corrected mistake) — RLS lands in the SAME
migration that creates each table, not deferred. `tenant_usage` alone also
gets an UPDATE policy (both `USING`/`WITH CHECK` pin `organization_id` to
the active context), since this is the phase that adds the recompute
worker's write capability.

Clean-database migration verified twice: once against a throwaway
database created and dropped specifically for this proof
(`atlas_migration_test`), confirming all 9 migrations (P0→P4) apply
cleanly from zero in order, then against the real dev database. Empirical
RLS proof (fail-closed, tenant isolation, all attack vectors blocked, all
legitimate paths allowed, platform tables contextless-readable) run by
hand via `docker exec ... psql` as the real `atlas_app` role **before any
application code was written**, then made permanent as
`rls-tenant-subscriptions.e2e-spec.ts`.

### EntitlementService — a direct, deliberate port

`src/plans/services/entitlement.service.ts` mirrors
`entitlement.utils.ts` (atlas frontend) function-for-function:
`computeEffectiveEntitlements`, `hasFeature`, `getResourceLimitStatus`,
`getLimitGapAction`, `getFeatureGapAction` — same names, same signatures,
same behavior, so the two can never silently drift. Not itself an HTTP
endpoint (the frontend contract has none) — used internally to compute the
`limit` embedded in each `UsageMetric` of a `GET .../usage` response,
combining the raw persisted `used` count with the organization's Plan +
active Add-ons AT READ TIME (never persisted alongside usage — a plan
upgrade is reflected on the very next read, not after the next recompute
cycle). Unit-tested exhaustively: all 7 `PlanLimitKey`s × below/at/above/
unlimited, all 11 `PlanFeatureKey`s × enabled/disabled/add-on-granted, both
gap-action functions in both directions — 128 unit tests, driven by
`PLAN_LIMIT_KEYS`/`PLAN_FEATURE_KEYS` iteration so a new key added to
`entitlement.types.ts` without a corresponding typed fixture fails to
compile.

### tenant-usage-recompute — real computation, and one honest scope boundary

`TenantUsageRecomputeService.recomputeOne(organizationId)` computes real
counts from real tables: `academies` (non-archived only), `instructors`/
`staff` (distinct users holding that literal `academy_members.role`,
`active` status, across non-archived academies in the org — owner/
administrator/manager roles are NOT counted toward any metric today; no
`PlanLimitKey` exists for them). `students`/`courses`/
`generalStorageGb`/`videoStorageGb` are honestly `0` — no source table
exists yet (P6/P5/P8 respectively) — matching the exact disposition
already reached for the Notifications frontend finding two phases ago:
real absence, not fabricated data. Idempotent by construction (full
overwrite every run, never increment) — proven by a dedicated test
(`recomputation is idempotent`) and by the worker e2e's redelivery test.

**Deliberately NOT built: a platform-wide scheduled sweep across every
organization.** Master plan §12 calls this worker "scheduled," and a naive
reading would suggest a cron job enumerating every organization on the
platform — but `organizations` is `FORCE ROW LEVEL SECURITY`'d with only
two SELECT policies (tenant-scoped, user-scoped), neither of which admits
"every row, full stop." The only sanctioned way to add that capability is
master plan §7 point 4's "Platform Owner bypass — explicit, role-scoped,
and audited" — which does not exist yet (Phase P15, out of P4's scope;
building it now would be inventing P15 inside P4, which the prompt
explicitly forbids). Documented, not silently gapped. What P4 ships
instead, both fully real and tested: (1) a real BullMQ producer/processor
(`TenantUsageRecomputeProducer`/`Processor`) triggerable per-organization
(`enqueueOne(organizationId)`), proven end-to-end against real Redis in
`tenant-usage-recompute-worker.e2e-spec.ts`; (2) a manual/ops CLI,
`npm run worker:recompute-usage -- <organizationId>`
(`scripts/recompute-tenant-usage.ts`), booting a real `AppModule` context
(real Postgres/Redis, real `atlas_app` role, real RLS) — used in the
manual test runbook so a human tester isn't blocked on a scheduler that
doesn't exist. A future P15 Platform Owner bypass can add true platform-
wide fan-out without changing anything in `TenantUsageRecomputeService`
itself — it only needs a way to enumerate organization ids, which is
exactly the missing piece.

### Verification

Typecheck PASS, lint PASS (0 errors after `--fix` for formatting only),
build PASS, format:check PASS. Migration verification PASS (clean-database
apply from zero, twice). Unit: 12 suites / 187 tests PASS (128 new, all in
`entitlement.service.spec.ts`). E2e: 22 suites / 129 tests PASS, zero
regressions (all 17 pre-existing P0–P3 suites/84 tests still green) + 5
new suites/45 new tests: `plans-catalog.e2e-spec.ts`,
`tenant-subscription.e2e-spec.ts` (contract + real recomputation logic,
including idempotency/changed-data/isolation/concurrency),
`tenant-subscription-isolation.e2e-spec.ts` (P4-TENANT-001..007, extending
the permanent tenant-isolation suite per §18, same one-file-per-phase
pattern P3 established), `rls-tenant-subscriptions.e2e-spec.ts` (direct DB
proof, zero app code), `tenant-usage-recompute-worker.e2e-spec.ts` (real
BullMQ/Redis transport + idempotent redelivery). Full manual smoke test
also run against real Docker Postgres/Redis via `curl` + the CLI script
end-to-end (catalog reads → subscription/usage/add-ons reads → entitlement
combination proof [base 2 + add-on 1 = 3] → honest 404 before recompute →
real recompute → idempotency → role-gated trial-policy write, both denied
and allowed paths).

CTO audit: no TODO/FIXME/console.log/hardcoded secrets/fake usage or
subscription data/`WITH CHECK (true)`/direct `PrismaService` bypass of
`TenancyContextService`/missing guards in any new P4 code; confirmed
runtime connection is still `APP_DATABASE_URL` (`atlas_app`) end-to-end,
including through the new CLI script (it boots the real `AppModule`, never
touches `DATABASE_URL`).

### What is deliberately NOT implemented (P4 boundary, matches master plan §21/§24 exactly)

No checkout, payment creation, payment providers, webhooks, invoices,
course purchases/orders, payouts, provisioning, courses, enrollments,
quizzes, assignments, media, website, CMS, domains, Platform Owner Control
Plane, analytics, notifications/search, or a generic RBAC catalog. No
speculative future-phase table or endpoint was added "in preparation."

## P5 — Course Management (2026-08-24)

**Status: COMPLETE (automated).** `course_categories`/`courses`/
`course_instructors`/`course_sections`/`course_lessons` tables, RLS,
`CoursesService`/`CourseCurriculumService`, and every `CourseService`
(frontend) authoring method backed by a real endpoint. Automated
verification PASS (typecheck/lint/build/unit/e2e/clean-migration, zero
regressions). Real, deterministic P0–P5 seed data created.
**Manual verification: PENDING USER TESTING** — see
`MANUAL_TEST_RUNBOOK.md`'s P5-MANUAL-001..018.

### Two confirmed frontend-contract gaps, resolved before writing code (not silently invented)

Backend Prompt 6 §1's "inspect first, STOP if the frontend contract
differs" rule caught two real gaps:

1. **Course instructor assignment.** `CourseService.ts` has zero
   assignment/removal methods; `Course.instructors` is a read-only
   projection nothing in the frontend ever writes to (confirmed by a
   full repo-wide grep, not assumed). The prompt asked for a write
   endpoint plus assignment tests — surfaced to the user directly rather
   than inventing one. **Decision (2026-08-24): DB + read-side only, no
   write endpoint** — mirrors the exact precedent already established
   twice in this codebase (`organizations` in P2, `tenant_subscriptions`
   in P4: table + RLS real, creation happens outside the request cycle
   until a later phase defines it). `course_instructors` exists, is
   RLS-protected, and is projected into `Course.instructors` correctly;
   seed data populates it directly via the admin connection.
2. **Course categories are read-only too** — same shape of gap
   (`getCourseCategories`/`getCourseCategory` are `CourseService`'s only
   category methods, no create/update/delete anywhere), found during
   implementation and resolved the identical way without re-asking,
   since it's the same already-decided pattern.

### Scope-boundary decision (not silently invented, strongly evidenced)

`discoverCourses`/`discoverCourse` (the flat, cross-academy, session-
scoped catalog) are OUT of P5 — `course.types.ts`'s own doc comment
("student consumption... [is a] separate, future module") and the
frontend's own separate `courseDiscoveryKeys` query-key tree (distinct
from owner-facing `courseKeys`) both independently confirm this is
Student Learning (P6) scope, not authoring. P5's own DoD wording
("`CourseService`'s full **authoring** surface") supports the same
reading.

### RLS design — reuses AcademyScopeGuard verbatim, no new guard

Every Course route nests under `academies/:academyId/courses/...` — the
academy id is always the URL's own `:id`, already resolved and
re-verified by the existing, unmodified `AcademyScopeGuard`. Unlike
Academy's own transitive-bootstrap problem (P3), **no new bootstrap
policy or guard was needed**: course/section/lesson ids are always
secondary path segments, verified by ordinary application-layer
ownership-chain queries (Lesson → Section → Course → Academy →
Organization, master plan P5 §14) inside the tenant context the guard
already established. Two migrations: `20260824044819_p5_course_management`
(tables + narrow SELECT/INSERT policies, transitively resolving through
`academy_id`/`organization_id`, one or two `EXISTS` hops depending on the
table) and no follow-up migration was needed for UPDATE/DELETE — both
land in the SAME initial migration this time, since P5's write capability
ships in the same phase as the tables (unlike P3/P4, where UPDATE
capability came in a deliberate follow-up). `courses` gets no DELETE
policy (soft-archive only, matching `Academy`'s precedent); `course_
sections`/`course_lessons` DO get DELETE policies — real SQL DELETE,
since neither has a soft-delete state machine (`CourseLessonStatus` has
no `archived` value, `CourseSection` has no status column at all).

Clean-database migration verified twice (throwaway `atlas_migration_
test_p5` database, all 10 migrations P0→P5 apply cleanly from zero, then
the real dev database). Empirical RLS proof run by hand via
`docker exec ... psql` as the real `atlas_app` role **before any
application code was written** (fail-closed, tenant isolation — including
the two-hop transitive case for sections/lessons, all attack vectors
blocked, all legitimate paths allowed), then made permanent as
`rls-courses.e2e-spec.ts`.

### Authorization — identical split to Academy (P3), applied one level down

READ (list/detail/sections/categories) is governed by ORGANIZATION
membership alone (via `AcademyScopeGuard`, unmodified). WRITE
(create/update/archive/publish/unpublish/sections/lessons/reorder)
additionally requires an `academy_members` row with role `owner`/
`administrator` for the owning academy — `CoursesService`/
`CourseCurriculumService.assertCanManage`, byte-identical rule to
`AcademiesService.assertCanManage`. An org member with no academy role
can read but not write, proven end-to-end (both automated and via the
real manual smoke test, `mike.wilson@acme-academy.dev` reading OK,
writing 403).

### Course ordering — explicit integer, never drag-and-drop

`ReorderItemsPayload` (`{orderedIds: string[]}`) is the frontend's own
contract — the client computes the full new order via `moveItem`
(move-up/move-down) and sends the complete list; the backend's only job
is validating it's an EXACT permutation of the current children (no
missing/extra/foreign id — `BadRequestException` otherwise) and
persisting each item's new `order` index in one transaction. New
sections/lessons are always appended last (`maxOrder + 1`); no `order`
field is ever accepted on create.

### Publish/unpublish — no invented prerequisite, no invented state machine

Neither endpoint enforces a publication prerequisite (e.g. "must have at
least one section") — none is specified anywhere in the frontend, and the
prompt explicitly warned against inventing one. Both are unconditional
status setters: `publish` always sets `publishedAt = now()` (an event
each time, including a republish); `unpublish` reverts `status` to
`draft` and deliberately leaves `publishedAt` untouched (a course still
honestly remembers when it was last published — common CMS behavior,
nothing in the frontend asks for it to be cleared). Proven in both the
automated suite and the real manual smoke test.

### Pricing bridge (a real, resolved discrepancy between master plan and frontend)

Master plan §5.3 specifies `pricing_amount_minor_units bigint` (the
established "money is a minor-unit integer at rest" convention); the
frontend's actual `CoursePricing.amount` is a plain decimal number
(`29.99`), not the `Money`/`amountMinorUnits` shape `money.types.ts`
defines for the real Prompt 7/P12-13 commercial contract. Resolved by
storing integer cents at rest and converting in the response/request DTOs
only — `toCourseResponse`/`CoursesService` — never exposing the raw
integer, never storing a float. Verified end-to-end (`29.99` in →
`2999n` in Postgres → `29.99` back out, both automated and via the real
manual smoke test) including the "switching to free must clear the stale
minor-units value" edge case (a real bug caught by the automated test
suite and fixed before this report — `undefined` means "don't touch" to
Prisma's update semantics, `null` means "clear"; the fix uses `?? null`
explicitly).

### `courses` usage metric — P4's own documented gap, now closed

`TenantUsageRecomputeService` (P4) left `courses` hardcoded at `0` with an
explicit comment: "this function is structured so a later phase adds its
own real COUNT here." P5 is that later phase — `courses` now counts real,
non-archived courses within non-archived academies per organization, the
exact continuation P4 anticipated. Verified via the seed script's real
recompute call (Org A: 2 real courses → `courses: 2`) and the existing P4
test suite re-run to confirm no regression (fresh test orgs with no
courses still correctly show `0`).

### Seed/fixture system — real, deterministic, idempotent, spans P0–P5

`prisma/seed.ts` (`npm run db:seed`), `package.json`'s `prisma.seed`
config. Every row written through real Prisma `upsert`/find-then-create
calls keyed by a stable NATURAL key (email/slug/compound unique) — never
a hardcoded id — so re-running updates rows in place, proven idempotent
(ran twice, identical row counts both times, confirmed by direct SQL
count). Two connections, deliberately: the admin superuser connection for
tenant-scoped rows (mirrors `test/utils/db-admin.ts`'s established
pattern), and a real, full `AppModule` context for the two things that
must go through real application code — `PasswordHasherService` (real
Argon2id hashing, no placeholder) and `TenantUsageRecomputeService.
recomputeOne` (real computed usage, not hand-typed numbers).

Fixture graph: 6 users (1 platform owner, 2 org owners, 1 instructor, 1
staff, 1 org-member-with-no-academy-role — deliberately covering every
authorization tier this and prior phases test), 2 organizations (with a
real multi-org membership — Sarah Chen belongs to both), 3 academies (2
active, 1 draft), 3 plans + 2 add-ons + 2 subscriptions (one `active`
+add-on, one `trialing`) from P4, 3 categories, 4 courses (2 published, 2
draft/one of which is fully Arabic-content — `أساسيات اللغة العربية` —
proving the plain-string columns round-trip non-Latin UTF-8 correctly;
the schema has no separate translation columns to populate, confirmed
against `course.types.ts`), 5 sections, 9 lessons, 1 course_instructor
assignment. Real `tenant_usage` rows computed via the real worker, not
fabricated. Documented in the script's own header comment: safety
(obviously-fake `@*.dev` emails, one printed dev password, manual-only
invocation, no production guard needed beyond that), exact run command,
exact fixture contents.

### Verification

Typecheck PASS, lint PASS (0 errors after `--fix` for formatting only —
plus a real bug caught and fixed: `POST .../publish`/`.../unpublish`
returned NestJS's default `201` instead of `200`, caught by the
automated contract test, not discovered by manual smoke testing first).
Build PASS, format:check PASS. Migration verification PASS (clean-
database apply from zero, twice). Unit: 12 suites / 187 tests PASS
(unchanged from P4 — P5 added no new unit-testable pure-logic service;
`CoursesService`/`CourseCurriculumService` are integration-tested against
real Postgres instead, matching the prompt's own "no mocked database for
RLS verification" requirement). E2e: **26 suites / 167 tests PASS, zero
regressions** (all 22 pre-existing P0–P4 suites/129 tests still green) +
4 new suites/38 new tests: `rls-courses.e2e-spec.ts` (direct DB proof,
zero app code), `courses.e2e-spec.ts` (CRUD/publish/pricing/categories/
validation contract), `course-curriculum.e2e-spec.ts` (sections/lessons/
reorder/ownership-chain), `courses-tenant-isolation.e2e-spec.ts`
(P5-TENANT-001..010, extending the permanent suite, same one-file-per-
phase pattern P3/P4 established). Full manual smoke test (all 18 items
from the prompt's own list) run against real Docker Postgres/Redis via
`curl`, using the real seeded data end-to-end — every response matched
the frontend's exact contract shape; the one initially-surprising result
(step 16, a seeded multi-org member successfully reading a second
organization's academy) was correctly diagnosed as legitimate behavior,
not a bug, and re-verified with a genuinely unrelated user to confirm the
negative case (403).

Also extended the shared pagination/collection-query DTOs
(`src/common/dto/pagination.contract.ts`, `src/common/dto/
collection-query.dto.ts`) out of `src/academy/` — the third module
(`academy`/`plans`/`course`) that would have needed a near-identical copy;
consolidated instead, `AcademyModule`'s own behavior unchanged (its 8
existing tests still pass).

CTO audit: no TODO/FIXME/console.log/hardcoded ids/fake data/
`WITH CHECK (true)`/direct `PrismaService` bypass of
`TenancyContextService`/missing guards/speculative P6+ code (quiz,
enrollment, assignment, grading — all absent from `src/course/`) in any
new P5 code.

### What is deliberately NOT implemented (P5 boundary, matches master plan §21/§24 and Backend Prompt 6 §21 exactly)

No enrollments, student progress, lesson progress, quizzes, quiz
questions/attempts, assignments/submissions, grading, instructor
dashboard, announcements/blog/forums, media library, website builder,
CMS, domains, Atlas/course payment, provisioning, Platform Owner Control
Plane, analytics, notifications/search, or production-hardening work. No
speculative future-phase table or endpoint was added "in preparation."

## P5 Closure / Gap-Fix Pass (2026-08-24)

Not a new phase — an exhaustive re-audit of P5 against the *current* real
frontend/backend contract before P6 starts, per explicit instruction not to
assume "COMPLETE" (the prior P5 entry above) means fully closed. Every
claim below was independently re-derived from the actual repositories, not
copied from the prior entry.

### Scope reconstruction (re-confirmed, unchanged)

Re-traced `CourseService.ts` (frontend) method-for-method against
`CoursesController`/`CourseCurriculumController`/`CoursesService`/
`CourseCurriculumService`, the P5 Prisma models, and the P5 migration's own
RLS policies. Every method (courses CRUD, publish/unpublish, categories
read, sections/lessons CRUD, both reorder endpoints) is real, wired, and
tenant-scoped exactly as the original P5 entry describes.
`discoverCourses`/`discoverCourse` re-confirmed out of scope (`course.types.ts`'s
own doc comment, `courseDiscoveryKeys`'s structural separation from
`courseKeys`, and — new this pass — a repo-wide grep of `src/` confirming
no flat `/courses` controller exists anywhere in the backend).

### Instructor assignment / category management — re-verified, decision unchanged

Fresh, full-repository greps (not a re-read of the prior finding) for
`assignInstructor|removeInstructor` and
`createCategory|updateCategory|deleteCategory|createCourseCategory|...`
across the entire `atlas-front/src` tree, plus a direct read of
`CourseBuilderPage.tsx`/`CourseSettingsPage.tsx` (neither even mentions the
word "instructor"): zero matches, exactly as before. The frontend genuinely
still has no write contract for either capability. Decision stands
unchanged: DB + RLS real, no write endpoint, consistent with the
`organizations` (P2) / `tenant_subscriptions` (P4) precedent. No new
product decision was needed or made.

### Real gap found and fixed: paid-pricing validation was not enforced server-side

**Problem.** The frontend's `createCourseSchema`/`updateCourseSchema`
(`course.schemas.ts`) both `.refine()` that `pricingAmount` must be a
positive number whenever `pricingType === 'paid'` — a real, already-decided
business rule the current frontend contract enforces client-side. The
backend's `CoursePricingInputDto` (`src/course/dto/course-pricing-input.dto.ts`)
had no equivalent check: `amount` was `@IsOptional()` regardless of `type`.
A direct API call (bypassing the frontend form) could persist a `paid`
course with `pricingAmountMinorUnits = NULL` — a course that claims to cost
money but has no price. No existing test (unit or e2e) covered this; a full
read of `test/courses.e2e-spec.ts`'s pricing tests confirmed only the
happy-path round-trip (`29.99` → `2999n` → `29.99`) and the
free-clears-stale-price case were covered, never "paid with no amount."

**Fix.** `src/course/dto/course-pricing-input.dto.ts` — replaced the
unconditional `@IsOptional() @IsNumber() @Min(0)` on `amount` with
`@ValidateIf((o) => o.type === 'paid') @IsNumber() @IsPositive()`: `amount`
is now required and must be `> 0` exactly when `type === 'paid'`, and is
skipped entirely (still fully optional) when `type === 'free'` — matching
the frontend `.refine()` exactly, no broader rule invented (no currency
requirement was added, since the frontend's own Zod schema does not
validate `pricingCurrency` either — it only defaults it client-side).

**Regression test.** `src/course/dto/course-pricing-input.dto.spec.ts`
(new) — a real, infra-free unit test using `class-validator`'s own
`validate()` directly against the DTO (no NestJS DI, no database — matches
this codebase's "unit = infra-free" definition, and is genuinely
executable in an environment without a live database, unlike this module's
existing e2e-only pattern). 6 cases: free-with-no-amount accepted,
paid-with-positive-amount accepted, paid-with-no-amount rejected,
paid-with-amount=0 rejected, paid-with-negative-amount rejected,
free-with-explicit-`undefined`-amount accepted. **Run and confirmed
passing: 6/6.**

**Verification after the fix.** Backend typecheck: 0 errors. Lint: 0
errors (one Prettier import-wrap issue caught and fixed with
`prettier --write`, re-verified clean). Build: clean. Full unit suite:
**193/193 passing** (187 pre-existing + 6 new), zero regressions. Format
check: clean.

This is the only concrete, existing-contract-backed implementation gap
found during this pass. It was fixed directly, per the standing instruction
not to ask permission for completing an already-defined P5 contract.

### Everything else re-audited this pass, found already correct

- **DTO validation** (`create-course.dto.ts`, `update-course.dto.ts`,
  `course-section.dto.ts`, `course-lesson.dto.ts`,
  `course-list-query.dto.ts`, `reorder-items.dto.ts`) — read in full,
  field-for-field against `course.types.ts`/`course.schemas.ts`. One
  suspected second gap (`contentUrl`'s `@IsUrl()` rejecting an empty
  string, since `@IsOptional()` only skips `undefined`/`null`) was
  investigated to the actual call site and ruled out: `LessonFormDialog`
  defaults the form field to `''`, but `CourseBuilderPage`'s submit handler
  (`contentUrl: data.contentUrl || undefined`) already normalizes it to
  `undefined` before the request is ever sent — the wire contract never
  actually carries an empty string. No fix needed; documented here so the
  investigation isn't silently lost.
- **Repositories** (`courses.repository.ts` et al.) — confirmed
  `findById`/`findManyForAcademy` both correctly `include: { category:
  true, instructors: INSTRUCTOR_INCLUDE }`, so the instructor/category
  read-side genuinely returns real joined data, not just a DTO shape that
  happens to compile.
- **Response contracts** (`course.contract.ts`) — pricing bridge
  (minor-units ↔ decimal) and `CourseInstructorSummaryResponse.id` (the
  user's id, not the join row) re-confirmed correct by direct code read.
- **RLS** — every one of the 15 policies on the 5 P5 tables
  (`course_categories`, `courses`, `course_instructors`, `course_sections`,
  `course_lessons`) read directly from `pg_policies` against a real,
  freshly-migrated database (see "Automated verification" below):  every
  `USING`/`WITH CHECK` clause is a narrow, transitive `EXISTS` resolving
  through `academies.organization_id = current_setting('app.current_organization_id')`
  — never `WITH CHECK (true)`, exactly as claimed. `courses` has no DELETE
  policy (soft-archive only); `course_sections`/`course_lessons` have real
  DELETE policies; `course_categories`/`course_instructors` have SELECT+INSERT
  only (no UPDATE/DELETE at the database level either — reinforcing that the
  "no write endpoint" decision is structurally consistent all the way down,
  not just an API-layer omission).
- **Frontend pages** (`CourseListPage.tsx`, `CourseBuilderPage.tsx`) — real
  loading (`Skeleton`), error (`ErrorState` with `onRetry`), and empty
  states confirmed present by direct code read, including the
  distinct-empty-state detail (`course:empty.noCourses` vs.
  `course:empty.noResults`, depending on whether a filter is active) that
  `P5-MANUAL-016` expects.
- **Seed data** (`prisma/seed.ts`) — read in full. 3 categories, 4 courses
  (2 published/2 draft, 1 paid/3 free, 1 fully Arabic-content), 5 sections,
  9 lessons, 1 `course_instructors` row, all via idempotent
  `upsert`/find-then-update-or-create keyed by natural keys
  (academy+slug, section/lesson `(parentId, order)`) — re-confirmed
  structurally idempotent by code inspection (a second run would find
  every row and `update` in place, never duplicate). Genuinely covers every
  P5-MANUAL scenario's stated preconditions.

### Automated verification (this pass)

No Docker and no reachable Postgres/Redis service existed in this session's
environment. Rather than skip database-level verification, PostgreSQL 16
and Redis were installed locally (Homebrew) and Redis started successfully;
however the local Postgres's normal multi-process postmaster fails to
start in this specific sandboxed environment with `FATAL: postmaster
became multithreaded during startup` — root-caused to something in this
environment specifically (confirmed NOT locale, NOT IPv6, NOT inherited
shell environment, via `env -i` full-strip; the same krb5-linked Homebrew
bottle is the leading suspect but was not conclusively isolated), reported
honestly rather than worked around by fabricating results. What
Postgres's **single-user (`--single`) standalone mode** — a real backend
process, not a mock — could still prove directly against a freshly
initialized, empty database:

- All 10 P0→P5 migrations apply **cleanly, in order, zero errors**, from
  an empty database (each migration file's SQL flattened to strip comments
  only, content byte-identical otherwise).
- `relrowsecurity`/`relforcerowsecurity` are both `true` on all 5 P5
  tables (`pg_class` catalog read).
- All 15 RLS policy definitions on those tables, read directly from
  `pg_policies.qual`/`.with_check`, exactly match what's claimed above.
- `atlas_app` is confirmed `rolsuper = false`, `rolbypassrls = false` in
  `pg_roles`.

**What could not be proven live, and why:** row-level RLS *enforcement*
(does a cross-tenant `SELECT` actually return zero rows) could not be
measured through single-user mode — a control test against `organizations`
(a table whose RLS was already exhaustively proven correct by the real P2
e2e suite) showed the identical false-open behavior under single-user mode
regardless of role or session context, conclusively identifying this as a
limitation of standalone-mode's execution path, not a real regression.
Genuine enforcement proof, plus the full HTTP/guard/controller integration
(`courses.e2e-spec.ts`, `course-curriculum.e2e-spec.ts`,
`courses-tenant-isolation.e2e-spec.ts`, `rls-courses.e2e-spec.ts` — 38
tests total, all read in full this pass and confirmed to test what they
claim, none weakened or skipped), requires the real `npm run test:e2e`
against a real networked Postgres+Redis (e.g. via `docker-compose up`),
which the user should run to get the final green confirmation — the same
standing gap between "automated PASS" and "closed" that already applied to
every prior phase's manual verification.

What **was** run live and is a genuine, unmodified result:

| Check | Result |
|---|---|
| Backend typecheck | PASS, 0 errors |
| Backend lint | PASS, 0 errors |
| Backend build | PASS |
| Backend format:check | PASS |
| Backend unit tests | **193/193 PASS** (187 pre-existing + 6 new, zero regressions) |
| Frontend typecheck | PASS — 18 pre-existing, unrelated errors (`PortableTextRenderer.tsx`/`SectionTitle.tsx`), 0 new, exact match to the documented baseline |
| Frontend lint | PASS, 0 errors |
| Frontend build | PASS — Course pages confirmed still shipping as separate lazy chunks |
| Migration apply (clean DB, P0→P5, single-user mode) | PASS, 0 errors |
| RLS policy existence/correctness (catalog-level) | PASS, 15/15 policies narrow and correct |
| RLS enforcement (live, cross-tenant) | **NOT RUN — requires real Postgres, see above** |
| Backend e2e (167 tests incl. 38 P5-specific) | **NOT RUN — requires real Postgres+Redis, see above** |
| Seed idempotency (real second run) | **NOT RUN — requires real Postgres+Redis; verified idempotent by code inspection instead** |

### Manual test runbook

Reviewed `Reports/MANUAL_TEST_RUNBOOK.md`'s P5 section
(`P5-MANUAL-001..019`) in full. Every case already has prerequisite, exact
account, exact steps, expected result, and PASS criteria; the two SECURITY
cases (`P5-MANUAL-014`, `P5-MANUAL-015`) already state the DevTools/network
check needed. No structural gap found — no changes made. **Still 0/19 run
by a human** (unchanged from context recovery); this pass did not and
could not change that, since it requires a human tester against a live
running app.

### Deferred items — unchanged, re-confirmed

`discoverCourses`/`discoverCourse` (P6), course instructor
assignment/removal (no frontend contract), course category
create/update/delete (no frontend contract), enrollments/progress/quizzes/
assignments/grading (P6). No new deferred item was discovered.

### P6 status

**Not started.** No P6 code, table, endpoint, or test was added or
modified during this pass.

## P6 — Student Learning & Assessment (2026-08-24)

**Status: COMPLETE (automated).** `enrollments`/`course_progress`/
`lesson_progress`/`quizzes`/`quiz_questions`/`quiz_question_options`/
`quiz_attempts`/`assignments`/`assignment_submissions` tables, RLS, a new
`LearningModule` (`CourseDiscoveryService`/`EnrollmentsService`/
`CourseProgressService`/`QuizzesService`/`AssignmentsService`), and every
`EnrollmentService`/`ProgressService`/`QuizService`/`AssignmentService`
(frontend) method — plus `CourseService.discoverCourses`/`.discoverCourse`,
explicitly deferred to this phase by P5's own report/schema comments —
backed by a real endpoint. Automated verification PASS (typecheck/lint/
build/unit/e2e/clean-migration/seed-idempotency, zero regressions).
**Manual verification: PENDING USER TESTING** — no runbook entries added
yet this pass (out of this task's scope); recommend a `P6-MANUAL-*` set be
authored before relying on this phase in the product.

### Scope, confirmed against the master plan before writing code

`enrollments`/`course_progress`/`lesson_progress`/`quizzes`/
`quiz_questions`/`quiz_question_options`/`quiz_attempts`/`assignments`/
`assignment_submissions` (master plan §5.3/§5.4, §21 Phase P6, verbatim).
`discoverCourses`/`discoverCourse` picked up here on schedule — both P5's
final report and `schema.prisma`'s own P5 section header already named P6
as their home ("student consumption... [is a] separate, future module").
Confirmed against the actual current frontend before implementing, not
assumed: `EnrollmentService`/`ProgressService`/`QuizService`/
`AssignmentService` (`src/features/learning/services/`) read in full;
`QuizService`'s and `AssignmentService`'s own file-header comments state
authoring/grading are out of scope ("Quiz authoring is out of scope" /
"Assignment authoring and grading workflows are out of scope") —
confirmed no create/update endpoint was invented for `quizzes`/
`quiz_questions`/`quiz_question_options`/`assignments`, mirroring the
exact `course_categories`/`course_instructors` precedent from P5 (table +
RLS real, populated only via seed/admin-only inserts, no write endpoint
until a later phase defines one).

### RLS design — a second tenancy shape, reusing `app.current_user_id` verbatim

Every P6 table is USER-owned, not organization/academy-owned (master plan
§7's own resource-ownership table: "Owned by User: ... own Enrollments, own
Quiz Attempts/Submissions") — a student is never an
`organization_memberships`/`academy_members` row, so the existing
`app.current_organization_id` mechanism structurally cannot express "this
row belongs to the signed-in student." Reuses `app.current_user_id`
verbatim — the exact session variable P2 already introduced for
`CurrentUser.organizations`/`runInUserContext`. No new session variable, no
new tenancy model. `enrollments`/`quiz_attempts`/`assignment_submissions`
check `student_id` directly; `course_progress`/`lesson_progress` resolve it
one hop transitively through `enrollment_id`; the read-only content tables
(`quizzes`/`quiz_questions`/`quiz_question_options`/`assignments`) resolve
it transitively through an active `enrollments` row for the quiz's/
assignment's course — SELECT-only, no INSERT/UPDATE/DELETE policy at all
(denied by default), matching `course_categories`/`course_instructors`'s
exact precedent.

Three ADDITIVE, narrow, context-independent SELECT policies were added to
the PRE-EXISTING P5 `courses`/`course_categories`/`course_instructors`
tables (`courses_public_discovery_select` et al.: `status = 'published' AND
visibility = 'public'`, no session-context dependency) — `discoverCourses`/
`discoverCourse` need to read a published+public course regardless of the
caller's organization membership, which a student structurally never has.
Postgres evaluates multiple SELECT policies on one table with OR semantics,
so this never weakens or replaces P5's own `*_tenant_select` policy, only
adds a second, legitimate, narrow read path for rows already publicly
discoverable by design. **A fourth pair of additive policies
(`course_sections_public_discovery_select`/
`course_lessons_public_discovery_select`) was added to the same two P5
tables mid-implementation**, discovered necessary by a real, reproduced e2e
test failure (not assumed): `EnrollmentsService.createEnrollment`
materializes `lesson_progress` at enrollment time by reading a course's
real sections/lessons, but the P5 `course_sections_tenant_select`/
`course_lessons_tenant_select` policies are `app.current_organization_id`-
scoped — a variable this code path never sets. Without the fix,
`totalLessons` on every new enrollment silently computed as `0` regardless
of the course's real lesson count. Confirmed root-caused, fixed, and
re-verified live (both via the real e2e suite and a direct `psql` proof as
`atlas_app`) before this report was written.

Migration: `20260824130632_p6_student_learning_assessment` — all 11
migrations (P0→P6) verified to apply cleanly from an empty database twice
(once via `prisma migrate reset --force`, once again after the
`course_sections`/`course_lessons` fix was added to the same migration
file and the database reset again — this migration was not yet
committed/pushed at the time of the fix, so amending it in place rather
than adding a follow-up migration was the correct, honest choice, not a
retroactive rewrite of shipped history).

### A real framework bug found and fixed: NestJS collapses a returned `null` into an empty body

`EnrollmentService.getEnrollmentForCourse`/`AssignmentService.getSubmission`
(frontend) are typed `Promise<T | null>` — "no such row" is a normal,
documented state, not an error, matching the exact "returns null, not 404"
contract convention already established by nothing before P6 (this phase
is the first to need it). Confirmed empirically, not assumed:
`@nestjs/platform-express`'s `reply()` calls `isNil(body)` — true for both
`null` and `undefined` — and sends an EMPTY body in either case, not the
JSON literal `null`. A plain `async getForCourse(): Promise<T | null> {
return result; }` controller method therefore sent zero bytes on the "not
found" path, which `supertest`/`superagent` then parsed as `{}`, not
`null` — caught by this phase's own e2e tests, not discovered by manual
testing first. Fixed in both affected controllers
(`EnrollmentsController.getForCourse`, `AssignmentsController.getSubmission`)
by bypassing Nest's default response handling via `@Res()` and calling
`response.status(200).json(result)` directly, which genuinely sends the
JSON literal `null` Express's own serializer produces. No other controller
in this codebase returns a nullable top-level value, so no other route was
affected.

### Business-logic decisions made, and the exact evidence each rests on

- **Free-course-only enrollment.** Master plan §21 P6: "no payment gate on
  enrollment yet ... free-course behavior is fully buildable now,
  paid-course gating lands in P13." `EnrollmentsService.createEnrollment`
  rejects a paid course outright (403) — granting free access to paid
  content would be a real bug, and no purchase flow exists to gate on
  instead. Enrollment is otherwise unconditional and idempotent (re-POSTing
  an existing enrollment returns it, no error).
- **Sequential lesson locking.** `LessonProgressStatus` includes `locked`,
  and the frontend's own `CurriculumNav.tsx` renders and disables on it —
  this is a real, rendered state, not a speculative one, so *some* locking
  rule was structurally required. No prerequisite/sequencing field exists
  anywhere in the schema beyond `course_sections.order`/
  `course_lessons.order` — whose entire purpose is defining a linear
  curriculum sequence. Implemented as: only the first lesson (in
  section-then-lesson order) starts `available`; each subsequent lesson
  unlocks only once the one before it is completed. The single most
  standard reading of an `order`-based curriculum with a `locked` state,
  not an arbitrary invention.
- **Quiz scoring.** Binary per-question correctness (the selected option
  set must exactly equal the set of options flagged `isCorrect`, no partial
  credit) — no partial-credit concept exists anywhere in `quiz.types.ts`.
  `score = correctCount / totalQuestions * 100`. `passed = passingScore ===
  null ? true : score >= passingScore` — a `null` passing score has no bar
  to clear. `maxAttempts === null` means unlimited, matching the type's own
  doc comment verbatim.
- **Quiz submission must cover every question exactly once.** The
  frontend's own `buildQuizAttemptSchema` (`learning.schemas.ts`) already
  requires every question answered before the form will submit —
  re-enforced server-side (`isExactQuestionCoverage`), matching this
  codebase's established "never trust the client-side check alone"
  discipline (the same one applied to `CoursePricingInputDto` during the P5
  closure pass).
- **Assignment submission requires a response or an attachment.** Mirrors
  the frontend's own `assignmentSubmissionSchema` `.refine()`
  (`learning.schemas.ts`) exactly, re-enforced server-side for the same
  reason.
- **No `assignment_submission_history` table.** Master plan §5.4 says this
  table is only added "when Phase 6 discovers resubmission history is
  actually needed for grading UX; not built speculatively now." It was not
  discovered to be needed — the frontend's `AssignmentSubmission` type
  carries no history field, and the one write endpoint
  (`submitAssignment`) is a single create-or-replace call.
  `(assignment_id, student_id)` stays unconditionally unique; a
  resubmission updates that row in place (clearing any stale grade, since
  none is ever set by any P6 endpoint anyway) when
  `assignments.allow_resubmission` is true, and is rejected with 409 when
  it is false.
- **`course_progress`/`certificateStatus` stay honest, not invented.**
  Certificate generation is explicitly out of scope (master plan §21 P6:
  "Must NOT implement yet: certificates, SPECIFICATION-UNDEFINED, §24") —
  `certificateStatus` only ever reports `'eligible'`/`'unavailable'` from
  the real completion fact already computed, never a fabricated
  certificate artifact. A course with zero published lessons is
  deliberately `incomplete`, not trivially `completed` — a 0-of-0
  "completion" would show a nonsensical congratulations for a course with
  no actual content.

### A genuine architecture gap discovered, and deliberately NOT resolved

`LessonPage.tsx`/`CourseLearnRedirectPage.tsx` (the frontend's own lesson-
viewing pages) call `useCourseSections(academyId, courseId)` —
`CourseService.getCourseSections`, P5's OWNER-scoped endpoint
(`academies/:academyId/courses/:id/sections`), using the `academyId` a
student's own `Enrollment.academyId` field already carries (confirmed by
that field's own doc comment: "lets learning pages reach the existing
academy-scoped Course endpoints without an academy id in the student-facing
URL"). That endpoint is guarded by `AcademyScopeGuard`, which requires real
`organization_memberships` — a fact an enrolled student never has. **An
enrolled, non-staff student calling this real, already-built frontend page
will receive 403, not lesson content.**

Nothing in P6's own service surface (`EnrollmentService`/`ProgressService`/
`QuizService`/`AssignmentService`, matching the master plan's own P6
Definition of Done exactly) exposes lesson title/content/contentUrl at
all — `LessonProgress` only carries a `status`, never the lesson's real
content. This gap was found during implementation, not assumed in advance,
and was deliberately **not resolved** — fixing it means either extending
`AcademyScopeGuard`'s read path to recognize an active student enrollment
(narrowly, read-only) as an alternate access grant, or building a new
student-facing curriculum-content-read endpoint — both are genuine new
authorization decisions with real security surface, outside what this
phase's own explicit instructions authorized deciding unilaterally.
**Flagged for an explicit decision before this phase can be considered
functionally complete for the product**, not silently left as an
undocumented gap.

### Verification

Typecheck PASS, lint PASS, build PASS, format:check PASS. Migration
verification PASS (clean-database apply from zero, `prisma migrate reset
--force`, twice — once before and once after the mid-implementation
`course_sections`/`course_lessons` RLS fix). Unit: 15 suites / 219 tests
PASS (193 pre-existing + 26 new: `quiz-scoring.util.spec.ts` — 17 tests
covering exact-coverage validation, binary scoring incl. no-partial-credit
cases, passing-threshold, and attempt-limit logic — and
`progress-computation.util.spec.ts` — 9 tests covering completion-state and
certificate-status derivation, including the zero-lesson edge case). E2e:
**33 suites / 221 tests PASS, zero regressions** (all 26 pre-existing P0–P5
suites/167 tests still green) + 7 new suites/54 new tests:
`learning-discovery.e2e-spec.ts`, `learning-enrollment.e2e-spec.ts`,
`learning-progress.e2e-spec.ts`, `learning-quiz.e2e-spec.ts` (includes the
mandatory quiz-correctness projection test, master plan §18 scenario 7),
`learning-assignment.e2e-spec.ts`, `rls-learning.e2e-spec.ts` (direct DB
proof, zero app code), `learning-tenant-isolation.e2e-spec.ts`
(P6-TENANT-001..006, extending the permanent tenant-isolation suite per
§18 — the mandatory student-cross-isolation scenario, §18 scenario 4).
Full suite run five times consecutively across the fix cycle; the only
failure observed anywhere was one transient `ECONNRESET` on a pre-existing,
unmodified P2 concurrency test, which passed clean on immediate re-run —
not a regression. Seed idempotency: `npm run db:seed` run twice against a
freshly-migrated database, all P6-relevant row counts (users, enrollments,
course_progress, lesson_progress, quizzes, quiz_questions,
quiz_question_options, assignments, quiz_attempts, assignment_submissions)
byte-identical across both runs — confirmed via direct SQL count, not
assumed.

CTO audit: no TODO/FIXME/console.log/hardcoded ids/fake data/
`WITH CHECK (true)`/direct `PrismaService` bypass of
`TenancyContextService`/missing guards/speculative P7+ code (instructor
assignment/removal, grading, announcements, blog, forums — all absent from
`src/learning/`) in any new P6 code. Zero P5 or earlier files modified
except `src/course/repositories/courses.repository.ts` (two new,
additive, read-only methods reused by `CourseDiscoveryService` — no
existing P5 method changed) and `test/utils/db-admin.ts` (new seed helpers
for quiz/question/option/assignment fixtures, additive only).

### What is deliberately NOT implemented (P6 boundary, matches master plan §21/§24 exactly)

Instructor assignment/removal (remains `SPECIFICATION-UNDEFINED`, §24 —
explicitly excluded from this pass per direct instruction). Quiz/assignment
authoring. Grading (P7, Instructor Operations). Certificates
(`SPECIFICATION-UNDEFINED`, §24). Payment-gated/paid-course enrollment
(P13). `assignment_submission_history` (deliberately not built — see
above). No speculative P7+ table, endpoint, or seed data was added.

## Next phase

**P7 — Instructor Operations & Community.** Not started. Do not begin
without explicit approval. Before it (or any further reliance on P6)
begins, the `LessonPage.tsx`/`getCourseSections` access gap documented
above needs an explicit product/architecture decision — it is not a P7
concern, it is an unresolved P6 loose end.

## P7 — Instructor Operations & Community (2026-08-25)

**Status: COMPLETE (automated).** Authorized explicitly after a full
project handover/discovery pass (this session); the `LessonPage.tsx`
access gap flagged above was explicitly left untouched, per direct
instruction — not resolved as part of this phase, not blocking it either
(P7's own scope doesn't depend on it).

### What was built

Two new modules: `InstructorModule` (`src/instructor/`) and
`CommunityModule` (`src/community/`, bundling Announcements/Blog/Forum —
same "one module, several services" shape `LearningModule` established for
P6). `InstructorService` matches the frontend service's full surface:
dashboard, teaching-course list, course overview, student roster, one
student's detailed progress, a quiz's cross-student attempt roster, an
assignment's cross-student submission list/detail, and grading
(`POST .../submissions/:id/grade`) — every method resolves teaching scope
from a real `course_instructors` row, never a client-supplied id.
`AnnouncementService`/`BlogService`/`ForumService` match their real
frontend contracts field-for-field, including each one's real narrow
authorization shape (course-scoped academy `owner`/`administrator` for
announcements; author-only for blog; course-instructor-or-academy-`owner`/
`administrator` for forum moderation).

**Database:** five new tables (`announcements`, `blog_posts`, `forums`,
`forum_threads`, `forum_replies`, master plan §5.5) plus additive RLS on
nine pre-existing P5/P6 tables so `InstructorService` can resolve teaching
scope and read/grade real student data — `assignment_submissions` gains
its first-ever write policy (the grading columns P6 left unused). Every
new/additive policy runs under `app.current_user_id` exclusively, reusing
P2's session variable — never `app.current_organization_id`, since several
of these resources (forum, course-scoped announcements) must be reachable
by an enrolled student, structurally never an organization member (same
reasoning P6 already established, reapplied). `course_instructors` itself
is untouched beyond one additive self-select policy — still no
INSERT/UPDATE/DELETE policy anywhere (master plan §24's audited decision,
unrevised): P7 only ever reads it.

**Two real engineering problems discovered and fixed during
implementation, not designed up front:**

1. A `courses ↔ course_instructors` mutually-referential RLS policy pair
   (an instructor-scoped `courses` SELECT policy referencing
   `course_instructors`, whose own pre-existing P5 policies reference
   `courses` back) — Postgres refused this outright with "infinite
   recursion detected in policy for relation courses" for every query
   against `courses`, reproduced during implementation. Fixed the standard
   way: a `SECURITY DEFINER` helper function (`is_course_instructor`,
   owned by the migration role) that bypasses RLS internally for this one
   narrow existence check, breaking the cycle without touching
   `course_instructors`'s own unrevised policies. The same fix pattern
   applied a second time for `academies ↔ academy_members`
   (`is_academy_member`), triggered by Prisma's nested `academy: {
   connect }` on `Announcement`/`BlogPost`.
2. A genuine, measured performance problem, not a cycle: the Community
   tables nest three deep (`forum_replies` → `forum_threads` →
   `forums`/`courses`), and naive nested `EXISTS` policies compounded into
   multi-second query times against single-digit row counts (~5.5s,
   confirmed via per-step timing that ruled out any individual slow query
   — every query in isolation profiled under 50ms). Fixed by collapsing
   each participant/moderator check into its own `SECURITY DEFINER`
   function (`is_course_participant`, `is_course_moderator`), used
   uniformly across `announcements`/`forums`/`forum_threads`/
   `forum_replies` — after the fix, a full seed run (including two forum
   writes) completes in ~12s total, down from timing out.

### Extending P6 to make the frontend's own reuse pattern work

`instructor.types.ts`'s own doc comment says instructor pages read quiz/
assignment *definitions* through the existing P6 `QuizService`/
`AssignmentService`, not a duplicate P7 endpoint — confirmed true by
direct inspection (`InstructorAssessmentsPage`/`InstructorQuizResultsPage`
call `useQuizzes`/`useQuiz`/`useAssignments` from `@features/learning`).
Those P6 read paths (`getQuizzes`/`getQuiz`/`getAssignments`/
`getAssignment` only — attempt/submission actions untouched) previously
gated on `assertActiveEnrollment` alone, which would 404 a real instructor
calling their own frontend's real pages. Extended with a new
`assertCourseReadAccess` (`learning-access.util.ts`, additive, alongside
the unmodified `assertActiveEnrollment`) accepting active enrollment OR
real teaching scope. A live, deliberate, documented extension of P6 code —
not a silent rewrite — with a real, demonstrated reason (master plan §22's
"no scope from a later phase... without a documented reason" rule).

### Seed / fixtures

`prisma/seed.ts` gained `seedInstructorOperationsAndCommunity`: Jane Doe
(P5's seeded React Fundamentals instructor) also teaches Spanish for
Beginners; Alex Morgan's (P6's seeded student) real assignment submission
there is graded through the real `InstructorService`; a real course
announcement, academy blog post, and forum thread+reply are created
through the real `AnnouncementsService`/`BlogPostsService`/`ForumsService`
— never hand-typed rows, matching every prior phase's seed precedent.
`test/utils/db-admin.ts` needed no new fixture helpers — `seedCourseInstructor` already existed from P5.

### Verification

Typecheck PASS, lint PASS, format:check PASS, build PASS. Migration
verification PASS (`prisma migrate reset --force` from zero, applied
clean, repeated several times across the fix cycle described above).
Unit: 15 suites / 219 tests PASS (all pre-existing, zero regressions — P7
added no new pure-logic unit beyond what integration/e2e already covers).
E2e: **39 suites / 251 tests PASS, zero regressions** (all 33 pre-existing
P0–P6 suites/221 tests still green) + 6 new suites/30 new tests:
`instructor.e2e-spec.ts` (dashboard/roster/overview/grading, including the
mandatory master plan §18 scenario 5 test — an instructor not assigned to
a course cannot grade its submissions, regardless of the course id
supplied, verified both by course-id substitution and by confirming the
submission's `gradingStatus` never changed), `announcements.e2e-spec.ts`,
`blog-posts.e2e-spec.ts`, `forum.e2e-spec.ts`,
`rls-instructor-community.e2e-spec.ts` (direct DB RLS proof, zero app
code), `p7-tenant-isolation.e2e-spec.ts` (P7-TENANT-001..005, extending
the permanent tenant-isolation suite per §18, cross-organization shape).
Seed idempotency: `npm run db:seed` run twice against a freshly-migrated
database, all P7-relevant row counts (`course_instructors`,
`assignment_submissions`, `announcements`, `blog_posts`, `forums`,
`forum_threads`, `forum_replies`) byte-identical across both runs —
confirmed via direct SQL count, not assumed.

CTO audit: no TODO/FIXME/console.log/hardcoded ids/fake data/
`WITH CHECK (true)`/direct `PrismaService` bypass of
`TenancyContextService`/missing guards in any new P7 code
(`src/instructor/`, `src/community/`) — confirmed by direct grep, not
assumed.

### What is deliberately NOT implemented (P7 boundary, matches master plan §21/§24 exactly)

Course instructor assignment/removal — still `SPECIFICATION-UNDEFINED`
(§24), still not built; P7 only ever *reads* `course_instructors`, exactly
as the master plan's own audited entry requires. Quiz/assignment
authoring — still out of scope (no phase owns it yet). Academy- or
platform-level announcement authoring — no frontend contract requests it
(confirmed: `AnnouncementService` defines only course-scoped write
methods), so none was built even though the schema/RLS support it. No new
`SPECIFICATION-UNDEFINED` was discovered during this phase beyond what was
already known.

## Next phase

**P8 — Media Library & Object Storage.** Not started. Do not begin without
explicit approval.

## P8 — Media Library & Object Storage (2026-08-25)

**Status: COMPLETE (automated).** Authorized explicitly; implements
Backend Prompt 9 exactly.

### What was built

`MediaModule` (`src/media/`) — `MediaController`/Service/Repository,
`R2StorageProvider` (the one real `MediaStorageProvider` implementation,
ADR-005), and the `media-processing` worker (producer + processor).
`MediaService` matches the frontend service's full surface exactly:
`getAssets`/`getAsset`/`uploadAsset`/`updateAsset`/`archiveAsset` — no
more, no fewer. Read is org-membership-sufficient (`AcademyScopeGuard`,
reused verbatim — the same guard `CoursesController` already uses, since
`academies/:id/media*` is the identical `:id`-is-the-academy-id shape);
write (upload/update/archive) requires academy `owner`/`administrator`,
mirroring `CoursesService.assertCanManage` byte-for-byte. No new
permission entity, no invented role.

**Database:** `media_assets` (master plan §5.9) — academy-scoped, RLS in
the same migration as the table, reusing the exact P5 `courses` shape
(`app.current_organization_id`, `AcademyScopeGuard`) — the first P8 table
to NOT need the P6/P7 user-context shape, since the Media Library is an
academy-staff-only surface. No DELETE policy (archive-only lifecycle,
matching `courses`' own precedent).

**Upload pipeline:** base64-bridge V1 exactly as specified — decode,
verify the real file kind from actual magic bytes (never the claimed
`mimeType`), enforce the real size ceiling against the real decoded
buffer (never the claimed `sizeBytes`), generate a backend-only storage
key (`academies/{academyId}/{uuid}.{ext}`, no client-supplied path
component anywhere), upload to R2, persist metadata, enqueue async
dimension extraction, return the exact frontend contract. Authorization
is checked *before* any storage I/O — an unauthorized caller can never
trigger a real R2 upload even for a request whose DB write would
ultimately be rejected.

**File validation** (`media/utils/file-validation.util.ts`): a small,
hand-rolled magic-byte allowlist (JPEG/PNG/GIF/WEBP/PDF — five real
signatures, not a new dependency for a case this narrow) — a client
claiming `image/png` for non-image bytes is rejected outright, regardless
of the claimed MIME type. Video is absent from the allowlist entirely, by
design — no video upload pipeline exists in this phase (§13 V2,
`SPECIFICATION-UNDEFINED`).

**Object storage:** Cloudflare R2 in production; a real local MinIO
container (`docker-compose.yml`, new service) in development/test —
`R2StorageProvider` is the exact same S3-protocol client code against
either, matching how `DATABASE_URL` already points local vs. managed
Postgres through the identical Prisma client. `onModuleInit` ensures the
bucket exists and carries a public-read policy (module-scoped, not
per-instance — runs once per bucket per process, not once per
`INestApplication`; see below for why this matters).

**Worker:** `media-processing` (BullMQ, mirrors
`tenant-usage-recompute`'s exact producer/processor shape) extracts real
image dimensions via `sharp`, asynchronously, never inline in the upload
response. Idempotent (overwrites only `width`/`height`), retry-safe
(BullMQ backoff on real failure), never destroys the original asset on
failure (documents/`other` types are skipped, not retried; a missing
storage object fails the job without ever touching the DB row). No
thumbnail file is generated — `MediaAssetSummary` has no thumbnail-url
field for one to ever be returned through (master plan's "do not invent a
new public response shape" instruction), so only real dimensions are
extracted.

### Four real engineering problems found and fixed during
implementation, not designed up front

1. **Region mismatch.** `S3Client({ region: 'auto' })` — R2's own
   documented convention — malformed `CreateBucketCommand` specifically
   against MinIO (routed to `/` instead of `/{bucket}`, confirmed by
   direct reproduction). Fixed with a new `R2_REGION` env var
   (`'auto'` default for real R2, `'us-east-1'` for local MinIO) — one
   environment-specific value, never a second client implementation.
2. **A silent config-coercion gap.** `configuration.ts`'s factory reads
   raw `process.env` under an unsafe cast (its own established pattern) —
   `env.validation.ts`'s zod `.transform()` for `R2_FORCE_PATH_STYLE`
   (string → boolean) never actually reaches it, so the S3 client
   received the literal string `"true"` instead of `true`. Fixed by
   coercing explicitly in `configuration.ts`, matching `Number(env.PORT
   ?? ...)`'s identical existing precedent for numeric fields.
3. **Bucket-check latency compounding into an unrelated regression.**
   `onModuleInit`'s real network round-trip (ensure bucket + policy),
   paid on every fresh `INestApplication` boot, pushed an already
   timing-sensitive, pre-existing BullMQ warm-up test
   (`auth-password-reset.e2e-spec.ts`'s own documented "first job after
   fresh boot" margin note) past its polling budget across the ~40-file
   e2e suite (`maxWorkers: 1`, one process). Fixed at the root cause: the
   ensure-check is now module-scoped (runs once per bucket per process),
   not per-`INestApplication`.
4. **The real bug**: `MediaProcessingProcessor`/`Producer` used
   `academyId` where `TenancyContextService.runInTenantContext` requires
   an *organization* id — the worker runs outside any request (no
   `AcademyScopeGuard` to resolve one), so `app.current_organization_id`
   was silently set to an academy id, and the P8 RLS policies (correctly
   checking real organization membership) filtered out every row,
   permanently starving the worker of the asset it was enqueued to
   process. Fixed by adding `organizationId` to the job payload
   (`MediaService.upload` already has it in scope) alongside `academyId`
   (still needed for the repository's own lookup). Caught by direct
   reproduction, not assumed — `rls-media.e2e-spec.ts`'s own direct DB
   proofs passed throughout, since they never exercised the worker path;
   this is exactly why `media-processing-worker.e2e-spec.ts` exists as
   its own file.

None of these four touch P0–P7 — all four fixes are either new P8 files
or narrow, explained additions to shared infrastructure
(`configuration.ts`/`env.validation.ts`'s R2 section, `main.ts`/
`test-app.ts`'s body-parser limit) that no earlier phase depends on.

### Body size limit

Express's default JSON body limit (100kb) rejects any real base64
payload before it ever reaches `MediaController`. `main.ts`/`test-app.ts`
both now call `useBodyParser('json', { limit })`, sized at
`MEDIA_MAX_UPLOAD_BYTES * 3` — deliberately generous headroom above the
real ceiling (not the tight ~1.33x base64-inflation factor alone), so a
payload moderately over the real limit still reaches `MediaService`'s own
byte-length check and gets a proper 413, rather than tripping this outer,
cruder limit first and surfacing as an opaque 500 (confirmed as a real
failure mode during implementation).

### Seed / fixtures

No seed changes — P8 has no dedicated frontend page of its own yet (the
Media Library is embedded only inside website-builder image fields,
`WebsiteImageField.tsx`, which has no backend counterpart until P9). Real
upload/list/archive behavior is proven entirely through the automated
test suite instead.

### Verification

Typecheck PASS, lint PASS, format:check PASS, build PASS. Migration
verification PASS (`prisma migrate reset --force` from zero, applied
clean). Unit: 16 suites / 237 tests PASS (215 pre-existing + a new
`file-validation.util.spec.ts`, 16 real cases — real PNG/PDF magic-byte
detection, a client lying about `mimeType` rejected, path-traversal-safe
storage-key generation, filename sanitization). E2e: **43 suites / 270
tests PASS, zero regressions** (all 39 pre-existing P0–P7 suites/251 tests
still green) + 4 new suites/19 new tests: `media.e2e-spec.ts` (upload/
list/detail/update/archive, real durable-object proof via a direct HTTP
GET against the returned URL, invalid-MIME rejection, oversized-payload
rejection, authorization), `rls-media.e2e-spec.ts` (direct DB RLS proof,
zero app code), `media-tenant-isolation.e2e-spec.ts` (P8-TENANT-001..005,
extending the permanent tenant-isolation suite per §18),
`media-processing-worker.e2e-spec.ts` (real BullMQ round trip, redelivery
idempotency, document-type skip, failure-never-destroys-the-asset).

CTO audit: no TODO/FIXME/console.log/hardcoded ids/fake data/
`WITH CHECK (true)`/direct `PrismaService` bypass/missing guards in any
new P8 code (`src/media/`) — confirmed by direct grep, not assumed.

### What is deliberately NOT implemented (P8 boundary, matches master plan §13/§21/§24 exactly)

Multipart/resumable upload, presigned-URL upload (`POST /media/upload-
url`, V1.5), video upload/transcoding (V2) — all still
`SPECIFICATION-UNDEFINED`/explicitly deferred, none built. Malware
scanning — "a reasonable addition once V1.5 direct uploads exist," not
V1's job. Orphaned-file cleanup/retention — a future scheduled concern
per §13, not built. Storage-quota enforcement against
`tenant_usage.general_storage_gb`/`plans.limits` — P4's `tenant_usage`
infrastructure exists, but no frontend contract defines media-quota
enforcement behavior yet (no error shape, no quota-exceeded UI state
anywhere in `media.types.ts` or `MediaService`); building enforcement
without one would be inventing a product decision. Flagged as a real
dependency for whenever that contract is defined, not silently resolved
here. No new `SPECIFICATION-UNDEFINED` was discovered beyond what §24
already lists.

## Next phase

**P9 — Website Builder & Theme Engine.** Not started. Do not begin
without explicit approval.
