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

---

## Organization Management Completion (full-stack, post-P2)

A follow-up closure pass, not a new backend phase — no new migration, no
new endpoint, no backend code change at all. P2 built the tenant-isolation
backbone (`organizations`/`organization_memberships`, RLS,
`GET /organizations/:id`, real `CurrentUser.organizations` data) but
nothing in the frontend ever exercised it: no UI called
`switchOrganization`, and no page displayed an organization's own identity
beyond a read-only membership list. This pass closed that gap on the
**frontend only**.

### What was found already built and reused, not duplicated

- `IdentityProvider.switchOrganization` — validates against real memberships, updates session, dispatches `atlas:organization-switched`, persists to `localStorage`.
- `PlatformProvider` — listens for that event and invalidates organization-scoped TanStack Query cache.
- `organizationKeys.detail(orgId)` — a query-key factory that existed, unused, anticipating exactly this.
- Session restoration (`IdentityProvider`'s mount effect) — re-validates a stored active-organization id against the signed-in user's real memberships before restoring it.

None of this was rebuilt. The only genuinely new frontend code: an
`OrganizationService` (thin `GET /organizations/:id` client, mirrors
`TenantService`'s pattern), a `useOrganization` hook, an
`OrganizationSwitcher` control (in `shared/components/controls/`, alongside
`LanguageSwitcher`/`ThemeSwitcher` — not inside a feature folder, per the
codebase's own `no-restricted-imports` rule barring the dashboard shell
from reaching into feature internals), and a read-only
`OrganizationOverviewPage` at `/dashboard/organization`.

### Manual verification fix pass (ORG-MANUAL-001)

Human manual testing (not covered by any automated suite — the frontend
has no test framework) caught a real, pre-existing bug this pass's own
automated verification could never have found: `src/shared/hooks/
useSignIn.ts` called the raw `authenticationService.signIn()` directly
instead of `useAuth().signIn()`, so a successful backend sign-in never
persisted tokens or updated `IdentityContext`'s session state — the user
stayed stuck on the sign-in page. Fixed by delegating to the existing,
already-correct `IdentityProvider.signIn`. One frontend file changed.

A separately reported `/api/config` proxy error was investigated and
confirmed **independent** — a legacy, unrelated runtime-config loader
(`src/lib/config.ts`, from the original template scaffold) whose failure
is caught internally and never touches the real API client or the auth
flow. Not touched.

Re-running backend regression verification for this fix surfaced a second,
genuinely unrelated issue: a locally running `npm run dev` instance and
the e2e test suite share one Redis, so their BullMQ workers raced to
consume the same job. Fixed with an environment-scoped queue prefix
(`bull-test` vs `bull`) in `app.module.ts`'s `BullModule.forRootAsync`, so
test and dev processes never collide on a queue again regardless of what
else is running locally.

### Scope explicitly not built (SPECIFICATION-UNDEFINED, unchanged from P2's own finding)

Organization settings/rename, membership invite/remove/change-role, role
assignment UI. No frontend form, backend endpoint, or authorization rule
exists for any of them; building them would mean inventing a business
decision (e.g. "who is allowed to rename an organization?") rather than
implementing a specified one. See `PROGRESS.md`'s entry for this pass for
the full reasoning, and `Reports/MANUAL_TEST_RUNBOOK.md` for how the
shipped surface (switcher + overview) is manually verified.

## P3 — Academy Management (2026-08-24)

`Academy` is the second-level tenant scope: every Academy belongs to
exactly one `Organization` (`academy.organization_id`), and RLS resolves
tenant ownership through that FK — no `app.current_academy_id`, no second
tenant/session mechanism. `AcademyModule` (`src/academy/`) imports
`AuthCoreModule` (for `JwtAuthGuard`) and `TenancyModule` (for
`TenancyContextService`/`OrganizationMembershipsRepository`), reusing P2's
tenancy backbone rather than duplicating any part of it.

### Two guard shapes, matching two tenancy-resolution paths

- `AcademyOrganizationScopeGuard` — guards the flat `GET /academies` /
  `POST /academies` routes. These carry a caller-supplied `organizationId`
  directly (query param / body field — see `PROGRESS.md`'s P3 entry for
  why this field exists at all), so this guard mirrors
  `OrganizationMembershipGuard` almost exactly: verify a real
  `organization_memberships` row inside the RLS context it establishes.
- `AcademyScopeGuard` — guards every `/academies/:id/*` route. The caller
  supplies only an academy id, so this guard bootstraps the owning
  `organization_id` via `runInUserContext` + the additive
  `academies_org_member_select` RLS policy, then independently
  re-verifies organization membership via `runInTenantContext` before
  attaching `request.academyContext`. See `PROGRESS.md`'s P3 entry for the
  full RLS design and the migration files' own doc comments for the SQL.

Both guards attach context to the request (`tenantContext`/
`academyContext`) exactly like `OrganizationMembershipGuard` does — the
controller and service never re-derive tenancy facts already proven by a
guard.

### Layering, unchanged from P0–P2

Controller (`AcademiesController`) → Guard → Service
(`AcademiesService`) → Repository (`AcademiesRepository`,
`AcademyMembersRepository`) → PostgreSQL (RLS). Every repository method
takes a `Prisma.TransactionClient` obtained through
`TenancyContextService`, never the raw `PrismaService` — forgetting this
fails closed, not open, exactly as documented on
`OrganizationMembershipsRepository`.

### Authorization: read is organization-scoped, write is academy-role-scoped

`AcademyScopeGuard` only proves organization membership (sufficient for
every READ endpoint, matching the frontend's own "for the active
organization" framing). WRITE endpoints
(create/update/branding/archive) additionally require an `owner`/
`administrator` role in `academy_members` for that specific academy,
checked in `AcademiesService.assertCanManage` — deliberately NOT folded
into the guard, since it is a per-academy role fact only resolvable once
inside the real tenant context, not a tenancy-boundary fact the guard
layer owns. This is what keeps "organization owner ≠ automatic Academy
Owner" true end-to-end, not just documented.

### Response contract mapping

`AcademyResponse` renames DB columns to match the frontend's `Academy`
type exactly: `logo_url`/`favicon_url`/`website_url` → `logo`/`favicon`/
`website` (`src/academy/dto/academy.contract.ts`) — confirmed against
`academy.types.ts` directly, not assumed from the DB naming.

## P4 — Plans, Subscription & Entitlements (2026-08-24)

`PlansModule` (`src/plans/`) holds two structurally distinct halves,
matching the frontend's own `PlanService`/`TenantService` split:

- **Catalog** (`plans`/`add_ons`/`trial_policy`) — platform-owned, no
  tenant dimension, no RLS at all (distinct from every tenant-scoped table
  in this codebase — see the P4 migration's own doc comment for why this
  is a correct design choice, not an oversight). `PlansController`/
  `AddOnsController`/`TrialPolicyController` guard with `JwtAuthGuard`
  alone (`PlatformOwnerGuard` additionally on `PATCH /trial-policy`, reused
  verbatim from P1/P2).
- **Tenant subscription/usage/add-ons** — organization-scoped, RLS-
  protected, reusing P2's `app.current_organization_id` mechanism exactly.
  `TenantSubscriptionController` mounts at `organizations/:id/*`
  (`@Controller('organizations')`, a second controller class sharing the
  base path `OrganizationsController` already declares — Nest resolves by
  full path+method, not by which class declares the base string) and
  reuses `OrganizationMembershipGuard` **verbatim, unmodified** — `:id`
  here already IS the organization id directly, unlike Academy's
  transitive-bootstrap problem, so no new guard was needed at all.

### EntitlementService

`computeEffectiveEntitlements`/`hasFeature`/`getResourceLimitStatus`/
`getLimitGapAction`/`getFeatureGapAction` — a direct, function-for-function
port of `entitlement.utils.ts` (atlas frontend). Pure computation, no I/O,
not itself an HTTP endpoint — used by `TenantSubscriptionService.getUsage`
to compute each `UsageMetric.limit` at read time from the org's Plan +
active Add-ons, never persisted alongside the raw `used` count (so a plan
upgrade is reflected immediately, not after the next recompute cycle). See
`Reports/PROGRESS.md`'s P4 entry for the exhaustive (128-test) unit
coverage this drives.

### tenant-usage-recompute

`TenantUsageRecomputeService.recomputeOne(organizationId)` is the real
logic (idempotent, full-recompute-never-increment, real Postgres queries
inside `runInTenantContext`); `TenantUsageRecomputeProducer`/`Processor`
are the thin BullMQ transport wrapping it, mirroring
`PasswordResetEmailProducer`/`Processor`'s established shape exactly. A
platform-wide scheduled sweep across every organization was deliberately
NOT built this phase — see `Reports/PROGRESS.md`'s P4 entry for the full
RLS-boundary reasoning (in short: `organizations` has no RLS policy
admitting "every row," and the only sanctioned fix is an audited Platform
Owner bypass that doesn't exist until P15). `scripts/recompute-tenant-usage.ts`
is the real per-organization trigger this phase ships instead, booting a
genuine `AppModule` context on the same `atlas_app` runtime role as every
other request.

### Response contract mapping

`TenantUsageResponse.generalStorage`/`.videoStorage` rename DB columns
`general_storage_gb`/`video_storage_gb` (`src/plans/dto/tenant-usage.contract.ts`),
matching `TenantUsage`'s (frontend) actual field names exactly, the same
"confirm the frontend type directly, don't assume from DB naming"
discipline `AcademyResponse` established in P3.

## P5 — Course Management (2026-08-24)

`CourseModule` (`src/course/`) is Academy-scoped content authoring — every
route nests under `academies/:academyId/courses/...`. Two services:
`CoursesService` (course CRUD, publish/unpublish, read-only category
projection) and `CourseCurriculumService` (sections/lessons: CRUD +
explicit-order reorder).

### No new guard — `AcademyScopeGuard` reused verbatim

Every prior phase module needed to reason about tenancy resolution
(Academy's own transitive bootstrap in P3, `OrganizationMembershipGuard`
reuse in P4). P5 needed neither: because every Course route's `:id` URL
segment is always the ACADEMY id — never a course id — `AcademyScopeGuard`
(imported from `AcademyModule`, unmodified, now exported specifically for
this reuse) already does the entire job: bootstrap-resolve the owning
organization, re-verify membership, attach `request.academyContext`.
Course/section/lesson ids are always secondary path segments, verified
purely by ownership-chain lookups inside the service layer (`assert
CourseInAcademy`/`assertSectionInCourse`/`assertLessonInSection` in
`CourseCurriculumService`, `assertBelongsToAcademy` in `CoursesService`)
— ordinary application-layer checks, not a new authorization mechanism.

### Write authorization — identical shape to Academy, one level down

`CoursesService.assertCanManage`/`CourseCurriculumService.assertCanManage`
are byte-identical in logic to `AcademiesService.assertCanManage`
(`academy_members` role `owner`/`administrator` required) — READ stays
governed by organization membership alone via the shared guard. This is
what keeps "organization owner ≠ automatic Course-write access" true
end-to-end for the same reason P3 established it for Academy writes.

### Two tables with no write endpoint, by confirmed design

`course_categories` and `course_instructors` exist (master plan §5.3
requires both; `Course.instructors`/`.category` need a real source), carry
full RLS, but have NO create/update/delete HTTP endpoint — confirmed
against the actual `CourseService` (frontend), which defines none for
either. Mirrors the exact `organizations`(P2)/`tenant_subscriptions`(P4)
precedent: table + RLS real now, the write capability is a later,
separately-specified phase's job. Seed/test fixtures populate both via the
admin superuser connection, same as those two precedents.

### Ordering model

`course_sections.order`/`course_lessons.order` are plain integers, no
special constraint. Reordering (`PATCH .../order`, `{orderedIds:
string[]}`) is a full-list replace: the service verifies `orderedIds` is
an EXACT permutation of the item's current children (not a superset,
subset, or foreign id — `assertExactPermutation`), then rewrites every
`order` field to match array position, in one transaction. New items are
always appended (`maxOrder + 1`) — never accept a client-supplied `order`
on create.

### Response contract mapping

`CourseResponse.pricing.amount` — see `schema.prisma`'s doc comment on the
`Course` model for the full reasoning: `courses.pricing_amount_minor_units`
is an integer (cents) at rest, matching master plan §5.3's explicit column
type and this codebase's "money is a minor-unit integer, never a float"
convention, while the frontend's actual `CoursePricing.amount` is a plain
decimal — converted in `toCourseResponse`/`CoursesService` only, in both
directions, never exposed as the raw integer.

`CourseInstructorSummaryResponse.id` is the USER's id (not a
`course_instructors` join-row id, which doesn't have its own surrogate key
— the table's PK is the composite `(course_id, user_id)`) — matches the
frontend `CourseInstructorSummary`'s own framing as "a reference to the
instructor," i.e. the person, not the assignment record.

### Seed/fixture system

`prisma/seed.ts` — see `Reports/PROGRESS.md`'s P5 entry for the full
fixture graph and safety discussion. Two connections deliberately:
`DATABASE_URL` (superuser, mirrors `test/utils/db-admin.ts`) for
tenant-scoped row writes, and a real `AppModule` context (mirrors
`scripts/recompute-tenant-usage.ts`) for the two things that must run
through real application code — password hashing and `tenant_usage`
computation.

## P5 Closure / Gap-Fix Pass (2026-08-24)

One real fix landed during the closure audit: `CoursePricingInputDto`
(`src/course/dto/course-pricing-input.dto.ts`) now enforces, server-side,
the same rule the frontend's `createCourseSchema`/`updateCourseSchema`
already enforce client-side — `amount` must be a positive number whenever
`type === 'paid'`, via `@ValidateIf((o) => o.type === 'paid') @IsNumber()
@IsPositive()` in place of an unconditional `@IsOptional()`. Everything
else audited this pass (full DTO set, repositories' relation includes,
response contract mapping, all 15 RLS policy definitions read directly
from `pg_policies`, frontend page loading/empty/error states, seed
idempotency) was confirmed already correct by direct code/catalog
inspection — no other change was made. See `Reports/PROGRESS.md`'s P5
Closure entry for the full audit trail, what could and could not be
verified live in this session's environment, and why.

## P6 — Student Learning & Assessment (2026-08-24)

`LearningModule` (`src/learning/`) is the first module in this codebase
scoped by USER rather than by organization/academy — every table is
resolved through `TenancyContextService.runInUserContext` (P2's own
mechanism, reused verbatim, never a new session variable), because a
student is never an `organization_memberships`/`academy_members` row.
`JwtAuthGuard` alone guards every route; there is no academy-scoping guard
here at all, matching `PlansModule`'s catalog controllers' identical
reasoning (the real scoping happens inside each service, not a route
guard).

Five controllers share two base paths: `CourseDiscoveryController`
(`courses`, flat — `discoverCourses`/`discoverCourse`, deferred out of P5
by that phase's own schema comment), `EnrollmentsController`
(`enrollments`, flat), and `CourseProgressController`/`QuizzesController`/
`AssignmentsController` (all `courses/:id/*` — `:id` is always the COURSE
id, a student reaches a course by id alone via their own enrollment, never
an academy id in the URL). Five services, four repositories
(`EnrollmentsRepository`, `CourseProgressRepository` — owns both
`course_progress` and `lesson_progress`, `QuizzesRepository`,
`AssignmentsRepository`), reusing `CoursesRepository`/
`CourseSectionsRepository` from `CourseModule` (P5) rather than
duplicating course-table query logic — `CoursesRepository` gained two new,
additive, read-only methods (`findManyPublished`/`findPublishedById`) for
exactly this reuse.

### RLS — a second shape alongside P2–P5's org-scoped model, not a replacement

`enrollments`/`quiz_attempts`/`assignment_submissions` check `student_id`
directly against `app.current_user_id`; `course_progress`/
`lesson_progress` resolve it transitively through `enrollment_id`; the
read-only content tables (`quizzes`/`quiz_questions`/
`quiz_question_options`/`assignments`) resolve it transitively through an
active enrollment in the owning course — SELECT-only, no write policy at
all, matching `course_categories`/`course_instructors`'s exact P5
precedent (no write endpoint exists for any of the four). Four ADDITIVE,
context-independent SELECT policies were added to the pre-existing P5
`courses`/`course_categories`/`course_instructors`/`course_sections`/
`course_lessons` tables (`*_public_discovery_select`: readable whenever
`courses.status = 'published' AND courses.visibility = 'public'`, resolved
transitively where needed) — Postgres OR's multiple SELECT policies on one
table together, so these never weaken or replace the P5 org-scoped
policies, they only add a second, narrow, legitimate read path for content
that's already publicly discoverable by design. See
`Reports/PROGRESS.md`'s P6 entry for the real e2e failure that surfaced the
`course_sections`/`course_lessons` pair's necessity mid-implementation.

### A real NestJS response-serialization gap, fixed

`EnrollmentsController.getForCourse`/`AssignmentsController.getSubmission`
bypass Nest's default response handling via `@Res()` — `@nestjs/
platform-express`'s `reply()` treats a returned `null` exactly like
`undefined` (`isNil` check) and sends an empty body, not the JSON literal
`null` both frontend types (`Enrollment | null`, `AssignmentSubmission |
null`) require. Manually calling `response.status(200).json(result)` sends
the real `null`. No other controller in this codebase returns a nullable
top-level value, so this is the first place this had to be solved.

### Known, deliberately unresolved gap

`LessonPage.tsx`/`CourseLearnRedirectPage.tsx` call the P5 owner-scoped
`CourseService.getCourseSections` (`academies/:id/courses/:id/sections`,
guarded by `AcademyScopeGuard`'s organization-membership check) using the
`academyId` a student's `Enrollment` record carries — but an enrolled
student is never an organization member, so this real, already-built
frontend call 403s today. Not fixed in this pass — resolving it means a
genuinely new authorization decision (extend `AcademyScopeGuard`'s read
path for enrolled students, or add a new student-facing curriculum-read
endpoint), deliberately left for explicit product/architecture sign-off
rather than decided unilaterally. See `Reports/PROGRESS.md`'s P6 entry for
the full reasoning.
