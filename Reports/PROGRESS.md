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

## Next phase

**P5 — Course Management.** Not started. Do not begin without explicit
approval.
