# Atlas Project Handover

**Written 26 September 2026.** Frontend `4d512f0`, backend `d868382`, both deployed.

---

## 1. Purpose

This hands the **whole Atlas project** to a new Claude Code session — not a single task.
It exists so the incoming session can act without re-deriving the architecture, and
without repeating mistakes that have already cost production outages here.

Read this, then `ATLAS_PROJECT_CURRENT_STATE.md` (the operational snapshot), then
`ATLAS_HANDOVER_CHECKLIST.md` (first-session steps). Everything is marked
`IMPLEMENTED` / `PARTIAL` / `DESIGNED — NOT BUILT` / `BLOCKED`. Where something is
uncertain it says so; do not upgrade a qualified statement into a fact.

**Governing document:** `docs/ATLAS_PRODUCT_QUALITY_MASTER_PLAN.md`. When it and
anything else disagree, it wins. Its central rule: **backend implementation is not
product completion.**

---

## 2. Current Project State

Atlas is a live multi-tenant SaaS at `https://atlass.dpdns.org`. Roadmap phases 0–10
are complete; phases 11–12 are **not started by instruction**. The P64 "secure
learning" initiative ran phases 1–4; its Communications programme is **CLOSED in
production**. The active workstream is **Account Deletion & Data Lifecycle**, which is
partially shipped (see §8).

The product works. The two things most likely to embarrass you are that **media bytes
are never actually deleted** (§8) and that **a Nest DI mistake can take the whole API
down while the site still looks fine** (§16).

---

## 3. Repository Map

Both repos live under `/Users/ziadelbadawi/Downloads/new/`.

| | Frontend | Backend |
|---|---|---|
| Path | `atlas-front` | `atlas-backend` |
| GitHub | `zeyadelbadawi/atlas` | `zeyadelbadawi/atlas-backend` |
| Stack | React 18 · Vite 5 · TS · React Router 6 (data router) · TanStack Query 5 · RHF + Zod · Tailwind + shadcn/Radix · i18next EN/AR | NestJS 10 · Prisma 5.20 · PostgreSQL 16 · Redis 7 · BullMQ · Pino · Zod env validation |
| Deploy | push `main` → GH Actions → arm64 image → GHCR → VPS | same |
| main SHA | **`4d512f0`** | **`d868382`** |

Schema: **107 models, 108 enums, 123 migrations.**

---

## 4. Architecture

```
Organization      ← billing, subscription, entitlement (never per-academy)
    ↓ 1:N
Academy           ← THE isolation boundary for content and people
    ↓ 1:N
Course → Enrollment → Learning
```

- **Organization** owns the subscription and all limits.
- **Academy** is the real security boundary. Membership is per-academy
  (`academy_members` for staff, `academy_students` for learners — structurally
  separate; there is no "student" role in the staff enum).
- **Courses** belong to exactly one academy. `Course.slug` is unique per academy;
  `Academy.slug` is globally unique because it is the subdomain label.

**Four distinct surfaces**, chosen by hostname before routing:
`resolvePublicWebsiteContext()` returns `atlas-app` or `academy-website`.

1. **Atlas marketing** (`/`, `/pricing`, …) — `PublicLayout`.
2. **Auth** (`/auth/*`, plus `/academy-chooser`, which is a *signed-in* page).
3. **Management dashboard** `/dashboard/*` — includes every Platform Owner screen,
   gated by `requiredRoles={['platform_owner']}`.
4. **Learner** `/my/*` — mounted **only inside `PublicWebsiteRouter`**, i.e. reachable
   only on an academy host.

⚠️ `ENV.platformBaseDomain` is unset in every environment today, so the
academy-website branch is effectively inert in production. Know this before debugging
public-site behaviour.

**Roles:** Platform Owner (operates Atlas, has no organization) · Client Owner ·
Manager · Instructor · Staff (limit-counted but **no creation path exists**) ·
Student.

---

## 5. Security Model

> **Guard decides, RLS independently agrees.** Neither is ever the only control.

**Non-negotiable invariants:**

- The app connects as **`atlas_app`** — `NOSUPERUSER`, `NOBYPASSRLS`. This is
  load-bearing: **RLS is inert for a superuser even with FORCE**, which is exactly why
  the role exists. Never connect as superuser to "make something work".
- `TenancyContextService` is the **only** setter of session variables, via
  `set_config(..., true)` inside a Prisma interactive transaction:
  `runInTenantContext` (`app.current_organization_id`) ·
  `runInUserContext` (`app.current_user_id`) · `runInTenantAndUserContext` ·
  `runWithoutContext` (grants by absence; anonymous preview only).
- **Platform Owner cross-tenant reads** run in `runInUserContext` with **no** org
  variable, so only `is_platform_owner()` policies can match.
- `PlatformOwnerGuard` **re-reads `users.is_platform_owner` from the database per
  request**. It is never a token claim; no organization role can imply it.
- Frontend checks are UX only. Every page and hook that matters says so in a comment.

**Scoping classes:** organization-scoped · academy-scoped (resolved transitively
through `academies.organization_id`) · **user-scoped** (`enrollments`, progress,
quizzes, assignments, forums, notifications — because a student is never an
`organization_memberships` row) · platform-scoped with deliberately **no RLS**
(`users`, `plans`, `trial_policy`, `trial_redemptions`, token tables, singletons).

**The most dangerous failure mode in this codebase:** a query run outside the right
context does **not** error — RLS filters every row and returns a confident zero. This
has already shipped as a bug once (account deletion anonymised the user and silently
left every membership row behind). Any new count or delete must state the context it
needs.

---

## 6. Core Product Areas

| Area | State | Notes |
|---|---|---|
| Academy | `IMPLEMENTED` | Creation **only** via provisioning (7-step resumable state machine). `POST /academies` was removed in Phase 10.6 and a test asserts it stays gone. |
| Courses | `IMPLEMENTED` | `Course → CourseSection → CourseLesson`, with quizzes/assignments/live-sessions sharing one ordinal space in a unit. **No publication prerequisites — do not invent one.** |
| Course authoring | `IMPLEMENTED`, protected | `CourseEditPage`, `LinesTextarea` (raw text while typing, normalise on blur), `CourseLanguageSelect`. Do not replace with naive controlled inputs. |
| Catalog / checkout | `IMPLEMENTED` | Manual transfer only; no online gateway connected. Platform Owner approval is the **single** trigger that turns a payment into a subscription change. |
| Enrollment | `IMPLEMENTED` | One access rule: active status + not revoked + not expired. Missing enrolment surfaces as **404, never 403**. |
| Assessments | `IMPLEMENTED` | Server-authoritative clock from a settings snapshot; expiry grades what the server last confirmed and never auto-fails. `QuizQuestionOptionResponse` has **no `isCorrect` field structurally** — keep it that way. |
| Certificates | `IMPLEMENTED` | Immutable issuance snapshot; regeneration keeps serial + code. |
| Media / video | `IMPLEMENTED` for delivery, **`PARTIAL` for deletion** | Seven entitlement conditions gate every byte, lease taken **last**. See §8 for the deletion gap. |
| Reports / analytics | `IMPLEMENTED` | Computed live, deliberately not a snapshot pipeline. |
| Communications | `IMPLEMENTED`, CLOSED | §7. |
| Website builder | `IMPLEMENTED` | Data-driven JSON sections, five themes, canonical-host fallback when a custom domain's HTTPS probe fails. |

---

## 7. Communications

`IMPLEMENTED` — initiative **CLOSED in production** (25 Sep 2026).

Transactional **outbox**: `CommunicationService.emit(tx, …)` writes an in-app
notification plus an outbox row **inside the caller's transaction and never sends**.
`CommunicationDispatchService` claims a row with one conditional UPDATE (10-min lease),
then walks recipient → channel policy → preference → suppression → cooldown → daily cap
→ branding → render → send.

~85 catalogue keys, each fixing category/audience/channels/dedupe/locale **once**, never
at the call site. Provider chain via `EMAIL_PROVIDERS`; production is `brevo`.
Suppression keyed by SHA-256 of the address, fed by provider webhooks.

⚠️ **One `@Processor` for the whole `communications` queue, six job names.** A second
processor on that queue silently eats jobs it does not recognise. This applies to every
queue.

---

## 8. Account Deletion / Data Lifecycle

Full detail: `docs/ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md`. **Read it before touching
this area.** Summary only here.

> **Atlas deletes the person and the bytes. It does not delete the record.**

Three facts force this: `users` has **10 `ON DELETE RESTRICT`** inbound FKs; **65
RLS-enabled tenant tables have no `FOR DELETE` policy at all** (so a DELETE silently
affects zero rows — `student_devices` is the exception and errors instead); and it is a
deliberate legal posture (Egypt PDPL 151/2020, Saudi PDPL M/19).

**`IMPLEMENTED` and production-verified:**

- Self-delete (`POST /users/me/delete`) — irreversible anonymisation, no user-id
  parameter by construction, Platform Owner refused server-side, idempotent.
- **Self-delete freeze fix** (fe `2380e51`) — a re-entrant deadlock in the 401
  interceptor. Auth-lifecycle routes are now exempt from refresh-and-retry.
- **Deletion plan** (`DeletionPlanService`, be `5b79d9f`) — five treatments
  (destroy / deidentify / retain / tombstone / revoke) with real counts.
- **Platform Owner administrative deletion** (be `2965719`) — same canonical service,
  runs in the **target's** context so existing self-scoped policies apply. Refuses
  self-deletion and refuses deleting another Platform Owner.
- **Platform Owner deletion UI** (fe `933a7d4`) on the user **detail** page.
- **Ops script** `src/scripts/delete-user.ts` — canonical service, **IDs only, never
  emails**.
- Academy archive and course archive (status transitions; neither table has a DELETE
  policy).

**`DESIGNED — NOT BUILT` — the real gap:**

**Media bytes are never deleted.** `MediaStorageProvider` exposes only
`putObject`/`getObject` — the public R2 bucket has **no delete capability at all**, so
every logo and thumbnail stays fetchable forever. Cloudflare Stream's `deleteAsset`
exists but its only caller is the retention sweep, so a deleted course keeps playable
video **and keeps billing storage minutes**. Superseded certificate PDFs are orphaned
with the holder's real name still in them.

Build it on the existing house pattern (`VideoRetentionDeletionService`,
`DomainProviderReleaseService`): one queue / one processor · deterministic job ids with
**no colons** · **re-validate at execution time** · **delete → verify absent →
tombstone** · provider-404 counts as success · zero-rows-changed on the tombstone is an
error.

**`DESIGNED — NOT BUILT`:** learner deleted-course/academy fallback. An enrolment
pointing at archived content has no deliberate state yet.

**Provider limitation, documented not fixable:** Cloudflare Stream has no per-session
token revocation. Deleting the asset is the only real kill switch.

---

## 9. Observability / Retention

- **Sentry** — disabled unless `SENTRY_DSN` is set; only 5xx reported.
- **`/metrics`** — Prometheus, unprefixed, **Platform-Owner-guarded**. Alert rules
  exist; external alerting is not evidenced.
- **`/health`** — unprefixed, and **not publicly reachable** (Caddy proxies only
  `/api/*`). A 200 at `https://atlass.dpdns.org/health` is the SPA and means nothing.
  Check inside the container.
- **Retention** — hosted-video only, currently `warn_only`: real warnings sent, nothing
  deleted. Three guards before deletion: lateness horizon, all four warnings on record,
  legal-hold/open-case suspend.
- **Audit log** — append-only, written as the last statement inside the mutating
  service's own transaction.

---

## 10. Feature Flags

Backend flags are env-driven, Zod-validated (**an invalid value fails startup**), modes
`off | allowlist | on`, read via `FeatureFlagsService`.

| Flag | State |
|---|---|
| `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` / `_ACADEMY` | **`new_device`** (verified in the running container) |
| `FLAG_VIDEO_RETENTION_MODE` | **`warn_only`** — moving to `on` is **not approved** |
| `FLAG_LIFECYCLE_SEQUENCES_MODE` | `off` / `dry_run` |
| `FLAG_QUIZ_ENGINE_V2_MODE`, `FLAG_QUIZ_INTEGRITY_MODE` | promoted to `on` by the owner |
| `contentProtected`, `videoNormal`, `videoPremium`, `devicesPolicy`, `learnerDashboardV2`, `playerV2`, `certificates` | `off` / allowlist |
| `EMAIL_PROVIDERS` | `brevo` |

⚠️ **The frontend flag system is inert and not wired to the backend's.**
`PlatformProvider` resolves dynamic flags to `{}`; the only real client flags are the
static `src/config/feature-flags.config.ts`. Phase 4 UI is ungated by construction.
**No flag is a security boundary.**

---

## 11. Master Plan / Phase Status

- **Roadmap phases 0–10:** COMPLETE. **11 (business widgets) and 12 (final validation):
  NOT STARTED, by instruction.**
- **P64 secure learning** (`docs/ATLAS_SECURE_LEARNING_MASTER_PLAN.md`): phases 1–3
  complete in production; phase 4 executed. Two blockers remain open (DL-40): the
  learner-session Chrome checks and hosted-video E2E infra.
- **Communications** (`docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md`):
  CLOSED.
- **Active:** Account Deletion & Data Lifecycle (§8).

`MASTER_HANDOVER.md` (16 Sep) is the best narrative doc but its **numbers are stale**
(it says 86 models / 90 migrations / 41 type errors; reality is 107 / 123 / 34). It
lives only in the frontend git stash — `git show "stash@{0}^3:MASTER_HANDOVER.md"`.
**Do not drop that stash**; it holds three handover documents.

---

## 12. Production Infrastructure

- Single **Oracle ARM64 VPS**, path `/opt/atlas`, docker compose project `atlas`.
- Services: `postgres` (16-alpine), `redis` (7-alpine), `backend`, `caddy` — where
  **caddy is the frontend image**, serving the SPA and reverse-proxying `/api`.
- **Only caddy publishes ports (80/443).** Postgres, Redis and the backend are
  internal-only.
- Caddy terminates TLS via the **Cloudflare DNS-01** challenge — the only way to get
  the `*.atlass.dpdns.org` wildcard. Cloudflare fronts DNS.
- API is `/api/v1` (global prefix `api` + URI versioning).
- SSH: restricted `deploy` user, key-based. Secrets are named in
  `src/config/env.validation.ts`; **values live only in GitHub Actions secrets and the
  VPS env.**

---

## 13. Deployment Workflow

**Direct to `main`. No feature branches, no PRs, no review ceremony** (owner decision
DL-39; CodeRabbit credits exhausted). Workflow: fix locally → test → commit → push
`main` → automatic deploy → **verify production**.

```
push main → GH Actions → docker buildx arm64 (QEMU, ~6-10 min)
  → ghcr.io/zeyadelbadawi/atlas-{backend,frontend}:latest + :<sha>
  → ssh deploy@VPS → /opt/atlas/deploy.sh
  → compose pull → prisma migrate deploy → compose up -d --wait → health check
```

Migrations run automatically and are forward-only. **Deploy is not gated on CI** — CI
has been red for unrelated reasons (see §16).

**Verifying a deploy properly:**
1. Run conclusion `success`.
2. Probe a guarded route: **401 = registered and guarded, 404 = not deployed.** That
   distinction is the whole trick.
3. For the frontend, the entry hash must change, and **lazy routes live in their own
   chunks** — grep the specific chunk, not just the entry.

---

## 14. Testing

```
# frontend (atlas-front)
npx vitest run <path>          # full suite ~7 min
npx tsc -p tsconfig.app.json --noEmit
npx vite build

# backend (atlas-backend)
npx jest <path>
npx tsc -p tsconfig.json --noEmit
npx eslint --fix <files>
```

**Baselines to respect, not "fix":**
- Frontend typecheck: **34 errors** (platform-zoom 23, website 5, platform-add-ons 5,
  tenant 1). Do not let it rise.
- `AcademyReportsPage.test.tsx` times out under parallel workers (~45–57s for the file)
  and passes in isolation. **Pre-existing flake.**
- Backend CI cannot run (`pull access denied for minio/minio`).
- Queue-dependent tests are contaminated by any process on `:3000` — check
  `lsof -ti:3000` first.

**Convention that matters:** unit specs with mocked transactions **cannot** prove RLS.
A mocked `tx` returns numbers real Postgres would filter to zero. RLS properties belong
in `test/` against real Postgres, and specs here say so explicitly rather than implying
coverage they do not have.

---

## 15. Important Decisions

Do not casually reverse these.

- **Deletion is anonymisation + teardown, not row deletion** — forced by FKs, RLS and
  law (§8).
- **Organization creation grants zero trial** — the old auto-grant produced three trials
  in under a second from one account.
- **One lifetime trial per salted email hash**, salt frozen forever, claim atomic in the
  signup transaction, cancellation never restores eligibility.
- **`grantedLimits` snapshot at purchase**, nullable, never backfilled — a backfilled
  number would be a fabricated commercial fact.
- **Price history from the audit log**, not a pricing table.
- **`no_plan` / `trial_expired` split out of `expired`** — telling a new org its
  subscription had expired was the bug.
- **No auto-renewal and no paid-period expiry sweep.** `cancelAtPeriodEnd` is set and
  nothing acts on it. A billing-model decision, not a defect.
- **Learner access terminates immediately on Client Owner deletion** — owner decision,
  26 Sep 2026. No grace period.
- **`platform-users` read-only-by-spec was deliberately reversed** by the owner on
  25 Sep 2026; the mutating surface lives on its own resource,
  `platform-user-management`.
- **Direct-to-main workflow** (DL-39).

---

## 16. Known Issues / Blockers

**Human decision**
- Which surplus Platform Owner accounts to remove (§17). Four exist; one
  (`ziad.elbadawi.zd@gmail.com`) is unused and was created under a since-superseded
  instruction. The canonical service **refuses to delete a Platform Owner** by design,
  so removal needs an explicit authorised step.
- Roadmap phases 11 and 12 remain not-started by instruction.

**Credentials / access**
- Learner-session browser journeys cannot be driven by an implementer (tokens cannot be
  injected and passwords must not be typed). A person must do these — DL-37.
- Verifying any OTP flow needs the owner's inbox.

**Technical**
- **Media bytes are never deleted** (§8). Highest-severity open item.
- Cloudflare Stream cannot revoke an issued playback token.
- Archived rows remain in the GIN search index unless queries filter on status.
- `quiz-deadlines` has no confirmed execution-time existence guard.
- `LearningLeaseService.revokeAll` exists but no deletion path calls it.

**Configuration**
- Caddy sets **no `Cache-Control` on `index.html`**; Cloudflare stamps `max-age=14400`
  on hashed assets. A tab loaded before a rollback keeps running the old SPA.
- Frontend flag system disconnected from the backend's.

**Verification**
- Rollback and backup-restore procedures are **not rehearsed. UNKNOWN.**

**Provider limitation**
- Zoom Marketplace approval is an external blocker; Live Sessions is built but
  `coming_soon`.

**The outage worth knowing about.** On 25 Sep 2026 a controller in `PlatformModule`
injected a service `IdentityModule` provided but did not export. **Nest resolves DI at
bootstrap**, so `tsc` passed, `nest build` passed, the image shipped — and the container
came up unhealthy, failing `compose up --wait`, and **every `/api/v1` route returned 502
for ~2.5 hours while Caddy kept serving the frontend perfectly.** Two deploys burned.
Guarded now by `src/platform/controllers/deletion-module-graph.spec.ts`. **Nothing in
the build pipeline models the injector** — any new cross-module provider must be covered
by that spec.

---

## 17. Current Git / Deployment State

| | Value |
|---|---|
| Frontend `main` | `4d512f0` — clean, deployed (run success) |
| Backend `main` | `d868382` — clean, deployed (run success) |
| Migrations | 123 |
| Production | `https://atlass.dpdns.org` — API healthy (`/api/v1/public/plans` → 200) |

**Platform Owner identity — no credentials recorded.**

| id | email | State |
|---|---|---|
| `c9a8267c-…` | `zeyadelbadawi.ze@gmail.com` | **The intended Platform Owner.** Verified: exactly one row, `is_platform_owner = true`, active, **no organization, membership, academy role or studentship**. Authenticated through the real OTP/new-device flow — challenge consumed, live `management`-surface session, one trusted device. |
| `511d05bf-…` | `ziadelbadawi@gmail.com` | Platform Owner, signs in, **owns an organization**. **Preserved deliberately** — never deleted on email similarity. |
| `66cce5de-…` | `zeyadelbadawi@gmail.com` | Platform Owner, never signed in, owns nothing. |
| `51808bca-…` | `ziad.elbadawi.zd@gmail.com` | Platform Owner, never used. Surplus; created under a superseded instruction. Needs an authorised removal step. |

The previous Client Owner row for `zeyadelbadawi.ze@gmail.com` was deleted through the
product; its email is anonymised and its organization row retained by design, pointing
at the anonymised subject.

---

## 18. How the Incoming Claude Must Work

- **Inspect before modifying.** Trace the existing behaviour first.
- **Backend implementation is not product completion.** A capability with no usable UI
  is incomplete — classify it honestly rather than calling it done.
- **Preserve RLS and tenant isolation.** Guard and RLS must independently agree. Never
  add a permissive policy, never disable FORCE, never use superuser as a shortcut.
- **Never widen permissions silently.** A new DELETE policy is narrow, scoped to a
  context variable, and justified in its migration.
- **Never expose secrets** — no passwords, OTPs, tokens, reset links or provider
  credentials in logs, commits, docs or chat.
- **Prefer a central fix over scattered patches.** One canonical service, two doors.
- **Targeted tests first**, then regression before deploy. A test that cannot fail is
  worse than no test — prove it bites.
- **Push verified changes to `main`**, deploy through the existing workflow, then
  **verify production**. Never fabricate production evidence; never claim verification
  you did not perform.
- **Do not invent business decisions.** State an assumption explicitly and proceed, or
  ask when proceeding either way would be unsafe.
- **Subagents** only for genuinely independent research. They must not push, deploy,
  migrate or integrate. The lead session is the sole integration authority.
- **UI work must use the project's UI/UX skill** (`ui-ux-pro-max` or Apple Design), and
  must be responsive, RTL-correct and accessible. EN **and** AR must both be right —
  there is a bidirectional parity test.

---

## 19. First Session Bootstrap

1. Read `ATLAS_PROJECT_CURRENT_STATE.md`, then this file's §5, §8, §16.
2. Confirm state cheaply:
   ```bash
   cd atlas-front  && git rev-parse HEAD && git status --short
   cd ../atlas-backend && git rev-parse HEAD && git status --short
   curl -s -o /dev/null -w '%{http_code}\n' https://atlass.dpdns.org/api/v1/public/plans   # expect 200
   ```
3. Read `docs/ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md` before any deletion work.
4. Do **not** re-run a full discovery. This package plus the existing docs is the
   baseline.

---

## 20. What To Do Next

In order:

1. **Storage teardown** — the highest-severity open gap. Add `deleteObject` to the
   public `MediaStorageProvider` (it does not exist), wire Stream `deleteAsset` into
   course/academy/media deletion, and stop orphaning superseded certificate PDFs. Build
   it on the retention pipeline's shape (§8). Without this, "deleted" for media means
   only that a database row changed.
2. **Learner deleted-course/academy fallback** — an enrolment pointing at archived
   content must resolve to a truthful tombstone, never a dead link, and must not expose
   the content.
3. **RLS/e2e tests against real Postgres** for the deletion paths. The existing unit
   specs deliberately do not claim RLS correctness.
4. **Product surface inventory** (Platform Owner / Client Owner / Learner) against real
   routes, to find backend capabilities with no UI.
5. Only then consider roadmap phases 11–12, which need explicit owner instruction.
