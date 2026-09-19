# P64 Phase 2 — Reconciliation against the amended Master Plan

**Date:** 19 September 2026
**Inputs:** `ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (amended today for D10/D11 and AD-15/AD-16), `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md` (approved), and the actual Phase 2 working tree.
**Purpose:** establish, before implementation resumes, exactly what survives the two-plan-family decision — and prove that nothing valid was discarded and no Phase 1 behaviour was changed.

---

## Verified starting state

| Check | Result |
|---|---|
| Backend typecheck | 0 errors |
| Backend unit tests | 87 suites / 1,079 tests passing |
| Backend boot | `/health` 200, database and Redis up |
| Phase 2 routes mapped | 19 |
| Frontend typecheck | 0 errors |
| Frontend tests | 50 files / 523 tests passing |
| Backend working tree | 70 uncommitted files |
| Frontend working tree | 34 uncommitted files |
| Committed / pushed / merged / deployed | **none** |

---

## 1. STAYS UNCHANGED

Every item below was checked for provider knowledge and has none. The amended plan changes nothing about any of it. **These files are not to be rewritten.**

### Authorization and policy — the reason ~90% survives

| Area | Evidence |
|---|---|
| `LessonContentService` — the seven entitlement conditions, refusal vocabulary, refusal→HTTP mapping, staff-preview path, access logging | Contains no `provider` reference at all |
| `ContentGrantSigner` | Branches only on `asset.access` and on whether a `providerId` exists; the cross-academy signing refusal is provider-independent |
| `can_access_lesson()` and **every** Phase 2 RLS policy | No policy references `media_assets`; the gate is the lesson. Zero provider references in the migration SQL |
| `assertActiveEnrollment` / `isEnrollmentActive` / `assertCourseReadAccess` / `assertCanReviewCourse` / `assertCanManageSecurityPolicy` | Phase 1 code, untouched |

### Infrastructure that is already tier-agnostic

- `ProtectedMediaStorage` — separate bucket, academy/course key prefixing, TTL clamp.
- `StudentDeviceService`, `AccessPolicyService`, `LearningLeaseService`, `LearnerSessionService` — device registry, policy resolution, lease, takeover, audit.
- `playback-evidence.util.ts`, `PlaybackService`, the watched-ratio gate and undo in `CourseProgressService`.
- `CourseSequenceService` and the curriculum projection changes.
- `LearnerDashboardService` and its contracts and controllers.
- `AcademyProtectionService` and `content-protection.contract.ts`.
- `ContentGrantRateLimiter`, `ContentAccessLogRepository`, `FeatureFlagsService`.
- `AcademyOriginsService`.

### Tests and frontend

- All 1,079 backend unit tests and all 523 frontend tests.
- The entire `/my/*` learner shell, its nine route skeletons, the D2 redirects and dashboard learner-route removal, EN/AR i18n and the accessibility work — provider-independent by construction.

---

## 2. REFACTOR — behaviour-preserving plumbing only

| # | Change | Why |
|---|---|---|
| R-1 | Widen four closed unions: `VideoProvider.key`, `VIDEO_PROVIDER_KEYS`, the `z.enum`, the Prisma `media_asset_provider` enum | A third adapter cannot compile otherwise |
| R-2 | `media.module.ts` ternary → `VideoProviderRegistry`, resolving by tier on upload and by `media_assets.provider` on playback (AD-7) | A new enum value currently resolves silently to the fake adapter |
| R-3 | Widen the five provider filters (reconciliation ×2, quota enforcement, usage recompute, module selection) to set membership | Quota must count both providers (AD-14); the two aggregates **must change together** |
| R-4 | `VideoProviderConfig` → nested per-provider credentials | A second provider's credentials have nowhere to live today |
| R-5 | `LessonContentGrantResponse.protection` → the AD-16 capability object | The current two-value union cannot express either tier honestly |

---

## 3. Defect fixes — required regardless of the tier decision

| | Fix | Status |
|---|---|---|
| **D-1** | Write `this.videoProvider.key`, not the literal `'cloudflare_stream'` | Must land **with** R-3, or local quota silently reads zero |
| **D-2** | `createDirectUpload` must return a real upload URL | |
| **D-3** | Never advertise an `expiresAt` beyond the credential's real life | Drives the mandatory refresh endpoint |
| **D-4** | A readiness path that does not require a webhook | Enables the Normal tier at all |
| **D-5** | Report `boundToSession`/`boundToDevice` honestly; correct the interface comment | AD-16, DL-21 |

---

## 4. NEW WORK

**Plan model (D10).** `plans.family` + `plans.tier`; the six variants modelled once, not six times; entitlement resolution plan → security tier; catalog backfill of existing rows to `family: normal`.

**Tier model (AD-15, D11).** `security_tier` enum; `media_assets.security_tier`; the academy's default upload tier bounded by plan entitlement; `PATCH /academies/:id/video-tier` (owner-only).

**Normal provider (DL-19).** `BasicVideoProvider` — R2 + CDN + Worker gate, progressive MP4, single 720p rendition, no ABR; synchronous readiness; Atlas-derived duration with provenance.

**Endpoints.** `POST …/video-uploads/:assetId/complete`; `POST …/playback/refresh` (specified in §L since the original plan, never built).

**Observability and forensics.** `tier` labels on grant metrics; upload-completion counter; duration-provenance counter; refresh rate; `content_access_log` gains `security_tier` and `provider`.

**Still outstanding from the original Phase 2 scope** (not caused by this decision): staff authoring UI including the `course_lessons.video_asset_id` write path, the player itself, the `content_access_log` retention sweep, the stalled-video poll scheduler, and binding `/my/courses` to real data.

**Validation (DL-22).** The Normal-tier Worker spike, before that architecture is production-ready.

---

## 5. MUST NOT TOUCH

- Phase 1 behaviour of any kind. The investigation established Phase 1 is provider-independent; the owner's instruction is not to reopen it.
- The seven-condition decision logic, the refusal vocabulary, or the 404-by-default refusal shape.
- Any RLS policy or `can_access_lesson()`.
- The cross-academy signing refusal in `ContentGrantSigner`.
- The device cap, lease semantics, or takeover audit.
- The server-credited playback evidence rules.
- The existing tests, except where a deliberate behaviour change requires updating an assertion — and then only with the reason recorded.

---

## 6. Verification

**No valid Phase 2 work was discarded.** The working tree is byte-identical to the checkpoint taken before the investigation, except for two files: `src/identity/identity.module.ts` (a one-line export needed for the app to boot) and the two new documents. Inventory comparison against the recorded checkpoint shows no deletions.

**No Phase 1 behaviour was changed.** Phase 2 touched five Phase 1 files, all additively:

| File | Change | Phase 1 impact |
|---|---|---|
| `auth.service.ts` | Device resolution on the academy surface only; wrapped in try/catch that returns `null` on any failure | Management sign-in unchanged; a device-registry failure cannot fail a sign-in |
| `auth.controller.ts` / `two-factor.controller.ts` | Read the device cookie; set it via a `passthrough` response | Response contracts unchanged |
| `refresh-tokens.repository.ts` | `deviceId` added to create, inherited on rotate | Null for every management session and every pre-existing row |
| `identity.module.ts` | Exported `AcademySurfaceService` | Export only |

Confirmed by the Phase 1 regression suite (`p64-*`, `auth-signin`, `auth-refresh`): **10 suites / 66 tests passing**, run after the Phase 2 changes were in the tree.

---

## 7. What the review cycle changed after this document was written

The reconciliation above was written before implementation resumed. An
independent compliance review then found five defects in the new work,
three of them blocking. They are recorded here because a reconciliation
that only lists what was planned, and never what was found, is not
evidence of anything.

| | Finding | Resolution |
|---|---|---|
| **B1** | `createVideoUpload` read `tier` inside the very callback that produced it — a temporal dead zone, so every call threw `ReferenceError` before writing a row. The whole upload path was dead and `tsc` was green, because the reference sat inside a closure. | Fixed to `resolved.tier`. A regression test now covers it, and was **proved** by reintroducing the bug and confirming the exact `ReferenceError`. |
| **B2** | `BasicVideoProvider` advertised `revocableBeforeExpiry: true` while nothing in Atlas wrote to the gate's denylist. | The capability is now read from configuration, and `VideoGateRevocationService` publishes on enrollment revocation, academy block, device removal and takeover. |
| **B3** | `BasicVideoProvider` advertised `boundToSession`/`boundToDevice: true`. The gate cannot check either: its host is cross-site from the academy, so no Atlas session reaches it. | Corrected to `false`. The Worker spike independently confirmed it — the same token served three unrelated clients, including a forged `Referer`. The Master Plan §I table and the investigation's §6 matrix were corrected, with the original claims left visible. |
| **S1** | AD-14's *second* enforcement point was missing: the quota was never re-checked when the real duration landed, so a declared minute could hide a three-hour upload. | The measured overrun is now charged and refused. |
| **S2** | The status poll resolved one process-wide adapter for rows belonging to both providers. | Resolves per row via the registry. |

Two further gaps were closed in the same pass: `course_lessons.video_asset_id`
had **no write path anywhere**, making the entire hosted-video feature
unreachable in practice; and the retention sweep and status poll were both
implemented with **no caller**, so neither had ever run.

## 8. Backend E2E triage — the six failing suites

Six backend e2e suites were failing when Phase 2 implementation finished.
Each was classified — **genuine Phase 2 regression**, **pre-existing
failure**, **stale test assumption**, or **test/environment infrastructure**
— before anything was changed, and only the two classes the owner authorised
for repair were touched.

| Suite | Class | Action |
|---|---|---|
| `p57-platform-plan-admin` | Stale test — six-plan migration | **Fixed** (fixture) |
| `p61-granted-entitlements` | Stale test — six-plan migration | **Fixed** (fixture) |
| `tenant-subscription` | Stale test — six-plan migration | **Fixed** (fixture + expectation) |
| `p63-domain-operations` | Test/environment — shared-database accumulation | No change; §8.2 |
| `media` | Pre-existing flake — cumulative in-process state | No change; §8.3 |
| `p53-support-attachments` | Pre-existing flake — same cause | No change; §8.3 |

**No suite in the set was a genuine Phase 2 regression.** The three repaired
ones were tests made wrong by the six-plan migration; the other three were
environment artefacts that reproduce only under specific conditions.

The verification run then surfaced two further suites failing for the same
environmental reasons (`p60-platform-courses`, `blog-posts`) and confirmed
that the two add-ons suites fail for a previously documented one. The
complete final picture, and the single root cause behind all of it, is §8.5.

### 8.1 The three real fixes

Phase 2 added `videoStorageMinutes` to `PlanLimitKey`. The `CreatePlanDto`
deliberately requires **every** key, because a missing key would silently
resolve to a zero-minute video quota — a security-relevant default. Three
test fixtures predated the new key, so they were updated rather than
weakening the DTO:

- `p57-platform-plan-admin` — `LIMITS` gained `videoStorageMinutes: 100`.
- `p61-granted-entitlements` — `LIMITS(students)` gained the same.
- `tenant-subscription` — the plan fixture gained `videoStorageMinutes: 50`
  and the usage expectation gained `{ used: 0, limit: 50 }`.

### 8.2 `p63-domain-operations` — shared-database accumulation

`test/jest-e2e.json` sets `maxWorkers: 1` and declares no `globalSetup`, so
all suites run sequentially against one dev database that is **never reset**.
Results depend on accumulated rows and on suite order.

`P63-DOM-021` backdates its own row's `lastCheckedAt` to six minutes ago and
expects the next sweep tick to advance it. Measured against the dev database:

- `domain_connections` holds **1,224** rows accumulated across prior runs.
- **984** satisfy the sweep's due predicate.
- **113** sort ahead of the test's row under the sweep's
  `lastCheckedAt ASC NULLS FIRST` ordering.
- The sweep takes **50** rows per batch, capped at **200** per tick, and
  stops early when a batch makes no progress.

Whether the test's row is reached therefore depends on how much unrelated
accumulated work the sweep must clear first — which varies with database
state and with where the suite lands in the sequence.

It is **non-deterministic, and was observed in all three states**: failing in
isolation, passing in one full run (52.6 s), and failing in the next full run
(88.7 s) with no code change between them. That instability is itself the
finding: the assertion depends on unrelated accumulated rows, so it can
neither confirm nor deny a regression in its current form.

Phase 2 writes nothing to `domain_connections`; its only contact is
`AcademyOriginsService`, which performs two reads to build the video
allowed-origins list.

### 8.3 `media` and `p53-support-attachments` — cumulative in-process state

Both fail with the same error in the same frame:

```
RangeError: Maximum call stack size exceeded
    at RegExp.exec (<anonymous>)
    at parseDataUrl (src/media/utils/file-validation.util.ts:94)
```

Both tests post an 11 MB payload (~15 MB as a base64 data URL) and expect a
**413**; they receive a **500**.

Two hypotheses were tried and **both were disproved**, which is recorded here
because the remaining conclusion rests on what was ruled out:

1. *A pathological regex in `parseDataUrl`.* It does not reproduce. The same
   payload matches correctly in plain node at stack depths to 10,000, inside
   the jest VM context, and through express JSON body parsing.
2. *Heap exhaustion in the long-lived jest worker.* Re-running the full suite
   with `--max-old-space-size=8192` did **not** fix it — the identical
   `RangeError` appeared twice again. The error is a *stack*-class failure,
   and `--max-old-space-size` raises the *heap*; the two are unrelated.

What is established empirically:

- Both suites **pass in a short run** — 12 suites, 93 tests, all green
  (`media` 16.6 s, `p53-support-attachments` 11.4 s).
- Both **fail in a full run**, at the same assertion, regardless of heap size.

So the trigger is cumulative in-process state across a long jest run, not the
parsing code and not the heap ceiling. **The precise mechanism is not
established**, and is recorded as open rather than guessed at.

Provenance, confirmed with `git status` against `HEAD`:
`src/media/utils/file-validation.util.ts`,
`src/media/services/media.service.ts` and `test/media.e2e-spec.ts` are all
**unmodified** by Phase 2. The only Phase 2 change in the module is DI wiring
in `media.module.ts`, and the error is raised before any database access, so
neither the new `media_assets` RLS policy nor the six-plan migration can
reach it. The same failure is present in runs captured before the Phase 2
JIT fix, and both suites are recorded as pre-existing flakes in the project's
own takeover notes.

### 8.4 Blocker — the full e2e suite cannot complete as configured

This is the one genuinely new problem the triage uncovered, and it is an
infrastructure limit, not a Phase 2 defect.

A full run dies with:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

after **106 of 116** suites. Because `maxWorkers: 1` puts every suite in one
long-lived node process with no worker recycling, the heap grows until it
reaches node's default ceiling (**~4.1 GB** on this 16 GB machine). Ten
suites never execute at all:

`auth-register`, `current-user-organizations`,
`live-provider-deauthorization`, `phase10-1-signup-email-security`,
`rls-courses`, `rls-media`, `rls-organizations`,
`rls-tenant-subscriptions`, `tenant-usage-recompute-worker`,
`users-profile`.

All ten were run separately and **all ten pass** (with `media` and
`p53-support-attachments`: 12 suites, 93 tests, 93 passed).

A truncated run is not a green run, and until this is addressed no full-suite
result can be trusted as complete. Two remedies, neither of which weakens any
test:

1. Raise the ceiling for the run — `NODE_OPTIONS=--max-old-space-size=8192`.
   No repository change.
2. Recycle the worker — jest 29.7 supports `workerIdleMemoryLimit` in
   `test/jest-e2e.json`. This is the durable fix and belongs in CI config.

Remedy 1 was applied to the verification run and **worked**: the suite then
completed all 116 suites with zero OOM lines (§8.5). It was set as an
environment variable for that run only — `test/jest-e2e.json` is unchanged,
because remedy 2 is the durable fix and neither falls inside "genuine Phase 2
issues or tests broken by the six-plan migration".

Note also what remedy 1 did **not** fix: `media` and `p53-support-attachments`
still failed with the identical `RangeError`, which is what disproved the
heap explanation in §8.3.

### 8.5 The full-suite result, and the one root cause behind every failure

With `NODE_OPTIONS=--max-old-space-size=8192` the suite completed for the
first time — no OOM, all 116 suites executed:

```
Test Suites: 7 failed, 109 passed, 116 total
Tests:       12 failed, 1287 passed, 1299 total
Time:        1129 s
```

**No failing test is a Phase 2 regression.** Five of the seven suites fail
for one reason: the dev database is never reset, and it has accumulated to a
size where queries and sweeps no longer fit inside their production budgets.

| Table | Rows |
|---|---|
| `users` | 42,208 |
| `organizations` | 21,862 |
| `academies` | 15,531 |
| `courses` | 7,607 |
| `course_lessons` | 4,957 |
| `domain_connections` | 1,297 |
| `add_ons` | 189 |

| Suite | Failure | Mechanism |
|---|---|---|
| `p60-platform-courses` | `P60-COURSE-004` → 500 | `/platform-courses` lists across every organization. `tx.course.findMany()` took **6,077 ms** against Prisma's **5,000 ms** interactive-transaction limit: `Transaction already closed`. 7,607 courses. |
| `blog-posts` | sweep tick → 30 s timeout | `SubscriptionSweepService` must clear accumulated due rows before the test's own become visible. |
| `p63-domain-operations` | `P63-DOM-021` | §8.2 — 1,297 rows, 113 sorting ahead of the test's row against a 50-row batch. |
| `platform-add-ons-management` | 6 tests | §8.6 — 189 rows against `pageSize: 100`. |
| `platform-add-ons-http` | 1 test | §8.6 — same. |
| `media` | oversized payload | §8.3 — pre-existing flake, mechanism open. |
| `p53-support-attachments` | `P53-ATT-013` | §8.3 — same. |

These are **production safeguards doing their job** against a database no
production tenant would ever resemble: a 5-second transaction ceiling, a
50-row sweep batch, a 100-row page. Raising any of them to make the suite
green would weaken a real control to accommodate a broken fixture estate, so
none was touched.

The accumulation is self-reinforcing — it grew measurably across this
session's runs (`domain_connections` 1,187 → 1,224 → 1,297; `add_ons`
150 → 176 → 189), so each full run makes the next one worse.

**The remedy is a clean database, not a code or test change.** The owner's
standing instruction is "do not delete anything", so nothing was truncated.
The non-destructive option is a separate scratch database for e2e, leaving
`atlas_dev` untouched; it needs authorisation before being set up.

Until then, the honest statement of Phase 2's test position is:

> 1,287 of 1,299 backend e2e tests pass. The 12 failures are distributed
> across 7 suites, every one of them explained by dev-database accumulation
> or by a pre-existing flake recorded before Phase 2 began. None is a Phase 2
> regression, and no Phase 2 assertion fails.

### 8.6 The add-ons suites

`platform-add-ons-management` and `platform-add-ons-http` assert that a key
they just created appears in a listing requested with `pageSize: 100`. The
dev database holds **189** `add_ons` rows — most of them abandoned
`addons-list-addon-*` fixtures from earlier runs — so newly created keys fall
outside the first page. Same accumulation class as §8.2, previously
documented at 150 rows.

Phase 2's only contact with `add_ons` is an `UPDATE` of
`compatible_plan_keys` on three named rows (`live-sessions`,
`extra-academy`, `advanced-analytics`) in
`20261009000200_p64_phase2_premium_plans`. It inserts no rows and cannot
affect a page count.

---

## 9. Clean-database verification

§8 established that the dev database had accumulated to the point where it
could no longer give a trustworthy signal. The owner authorised a reset, so
the whole triage was redone against a database built purely from the
migration chain.

### 9.1 The reset

Performed with the project's own mechanism — `npx prisma migrate reset
--force`, which drops and recreates the database, replays all 108 migrations
in order, and runs the configured `prisma/seed.ts`. No hand-written
destructive SQL, no schema edits, no production or staging contact. Target
confirmed beforehand as `postgresql://atlas@localhost:5432/atlas_dev` on the
local `atlas-backend-postgres-1` container, whose server hosts only
`atlas_dev` and two shadow databases.

| Table | Before | After |
|---|---|---|
| `users` | 42,208 | 8 |
| `organizations` | 21,862 | 2 |
| `academies` | 15,531 | 3 |
| `courses` | 7,607 | 4 |
| `domain_connections` | 1,297 | 0 |
| `add_ons` | 189 | 3 |

Post-reset state verified: 108/108 migrations applied with none unfinished;
`atlas_app` present with `rolbypassrls = false` and `rolconfig = {jit=off}`
(so Phase 2's migration `…000400` is in effect); 74 tables with FORCE RLS; 21
policies across the Phase 2 tables; and all six plan variants seeded
(`starter`/`growth`/`enterprise` × `normal`/`premium`).

One prerequisite had to be cleared first: three jest processes left over from
background agents had been hung for **5h41m**, holding connections and
matching the same process pattern as the wait loops. They were terminated
before the reset.

### 9.2 What the clean database proved about §8

Every failure §8 attributed to accumulation disappeared:
`p63-domain-operations`, `platform-add-ons-management`,
`platform-add-ons-http`, `p60-platform-courses`, `blog-posts`, `media` and
`p53-support-attachments` **all pass** on a clean database. That confirms the
§8 diagnosis and, in particular, settles §8.3: `media` and
`p53-support-attachments` were never a defect in `parseDataUrl`.

The run also completed in **794 s** versus 1,129 s, and with no OOM.

### 9.3 CRITICAL pre-existing defect — `/search` is broken on any migrated database

The clean database exposed something the polluted one had been hiding.

`prisma/migrations/20260922000000_p44_live_sessions_addon/migration.sql`
contains:

```sql
ALTER TABLE "academies"     DROP COLUMN "search_vector";
ALTER TABLE "courses"       DROP COLUMN "search_vector";
ALTER TABLE "organizations" DROP COLUMN "search_vector";
ALTER TABLE "users"         DROP COLUMN "search_vector";
```

plus the four matching `DROP INDEX` statements. Only
`20260828120000_p17_notifications_search` ever creates those columns, and **no
later migration restores them**. `src/search/repositories/search.repository.ts`
still queries them, so on any database built from the migration chain every
search request fails:

```
Raw query failed. Code: 42703.
Message: column c.search_vector does not exist
```

`GET /search` returns **500 for every query**, taking seven tests with it —
including the tenant-isolation and platform-category security cases.

**Cause.** The columns are raw SQL and therefore absent from
`schema.prisma`, so Prisma's diff proposed dropping them and the generated DDL
was committed with that drop unreviewed. The `p19` migration's own header
comment warns about precisely this hazard. The author of p44 annotated the
`tenant_add_ons` `DEFAULT` problem in the same file carefully, but did not
catch these.

**Not Phase 2.** p44 is dated 2026-09-22; the Phase 2 migrations are
2026-10-09.

**Why it was invisible until now.** The old dev database still had the
columns, so the search suite passed against it. That means that database was
not a faithful product of the migration chain — drift only a reset exposes.

**Production status is UNKNOWN and should be checked urgently.** If production
applied p44, search is broken there too unless the columns were restored out
of band. That cannot be determined from this workspace.

**Not fixed here, deliberately.** The repair is a new migration re-adding four
generated columns and their GIN indexes. That is a schema change outside
Phase 2, and the standing rule is to apply only migrations belonging to the
approved phase. Folding an unrelated production schema fix into a Phase 2 PR
would also make that PR misrepresent itself. It needs its own change.

### 9.4 The one fixture fix

`course-commerce` failed three tests with `409 errors.courseOrder.commission
NotConfigured`. That refusal is §4.2's production safeguard working correctly
— Atlas Payments is unusable for an organization until an effective
commission resolves, "never a silent 0% guess".

The platform commission default is a **global singleton**, and the first test
to set one sat two thirds of the way down the file. The three purchases above
it had only ever passed on a commission left behind by an earlier run. The
fix establishes the precondition in `beforeAll`; every case that asserts a
specific rate still sets its own immediately beforehand, so nothing is masked.
The safeguard itself was not touched. Suite result after the fix: **19/19**.

### 9.5 Final clean-database result

After the §9.4 fixture fix, the complete suite was re-run from a fresh
process against the reset database:

```
Test Suites: 3 failed, 113 passed, 116 total
Tests:       9 failed, 1290 passed, 1299 total
Time:        826 s        (no OOM; all 116 suites executed)
```

**All 19 Phase 2 and learning suites pass** — `p64-phase2-api`,
`-security`, `-rls-tiers`, `-quota`, `-tiers`, `-downgrade`,
`p64-rbac-review`, `p64-rls-review-and-published`,
`learning-tenant-isolation` and the rest.

The 9 remaining failures, none of them Phase 2:

| Suite | Tests | Class | Root cause |
|---|---|---|---|
| `search` | 7 | **Pre-existing schema defect** | §9.3 — migration p44 drops the `search_vector` columns the search repository still queries. Deterministic; fails on every run. |
| `media` | 1 | Pre-existing flake | §8.3 — passes on a pristine database and in isolation; fails once a prior full run has populated the database. |
| `p53-support-attachments` | 1 | Pre-existing flake | Same. |

`media` and `p53-support-attachments` were re-run in isolation immediately
afterwards: **2 suites, 27 tests, all passing**. They had also both passed in
the first clean-database run. What changed between the two runs is database
size — two full runs took the reset database from 8 users to **4,637** (and
879 courses), since nothing truncates between runs. This ties the §8.3
symptom to database size rather than to the parsing code, while the precise
V8 mechanism remains open. They are not a Phase 2 regression: `parseDataUrl`,
`media.service.ts` and `test/media.e2e-spec.ts` are all unmodified against
`HEAD`.

### 9.6 Deployment position

**Phase 2 itself is clean.** Every Phase 2 assertion passes on a database
built purely from the migration chain, with RLS forced, `atlas_app`
`NOBYPASSRLS`, and all six plan variants seeded.

The one item that should gate any deploy is **not Phase 2's**: §9.3. If
production applied p44, `/search` is returning 500 for every query there too.
That needs checking against production and its own migration — it must not be
folded into a Phase 2 PR.

Phase 2 remains **not committed, not merged, not deployed**.
