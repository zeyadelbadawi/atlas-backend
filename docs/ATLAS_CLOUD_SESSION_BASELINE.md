# Atlas — Cloud Session Baseline

**Established 25–26 Sep 2026 by the cloud takeover session.** Frontend `4d512f0`,
backend `6a70173` (docs-only on top of `d868382`). Both confirmed deployed with
`success` via GitHub Actions (backend run #178, frontend run #115).

This file does **not** restate the handover. Read these first, in order:

1. `ATLAS_PROJECT_HANDOVER.md` — the architecture and history narrative.
2. `ATLAS_PROJECT_CURRENT_STATE.md` — the operational snapshot.
3. `ATLAS_PRODUCT_QUALITY_MASTER_PLAN.md` — governing rules; it wins over every other document.
4. `ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md` — required before any deletion work.

This file records only three things: **corrections** to those documents, **verified
findings** they do not contain, and **how this session works**. Everything below was
verified by reading code unless it says `UNCONFIRMED` or `NOT RUNTIME-VERIFIED`.

---

## 1. Verification limits of this session

- **Production is not reachable from the cloud container.** The environment's network
  policy denies `atlass.dpdns.org`. To allow live probes (the 401-vs-404 check, chunk
  greps), add `atlass.dpdns.org` and `*.atlass.dpdns.org` to the environment's allowed
  domains.
- **There is no SSH, VPS or database access.** Production flag values, container health
  and row counts cannot be observed from here. Deploy state comes only from the GitHub
  Actions API.
- **Both clones are shallow.** `git log` dates are unreliable. The frontend stash holding
  `MASTER_HANDOVER.md` does not exist in this clone.
- **Frontend `node_modules` is not installed.** The 34-error typecheck baseline has not
  been re-measured here.

---

## 2. Corrections to the handover package

| Handover claim | Reality | Evidence |
|---|---|---|
| "Migrations run automatically" on push (§13) | **They are gated.** A push deploys code only, and `deploy.sh` aborts if a migration is pending. To apply migrations, dispatch `deploy.yml` with `apply_migrations=true`; the `production-migrations` protected environment then needs reviewer approval. `--rollback` re-pins images and never reverts a migration. | `.github/workflows/deploy.yml` header, `deploy/deploy.sh` |
| `compose up -d --wait` | The script runs `up -d --remove-orphans` followed by its own `wait_healthy`, which checks backend `/health` and Caddy. | `deploy/deploy.sh` |
| "Backend CI cannot run (minio pull denied)" | CI was **disabled manually** on 23 Sep. Its last runs failed at **Lint**, so no unit or e2e test has run in CI since. The frontend repo has **no CI workflow at all**. Deploys are gated on nothing. | GitHub Actions API |
| `ENV.platformBaseDomain` "unset in every environment; academy-website branch inert" (§4) | **Set in production.** `.env.production` is committed with `VITE_PLATFORM_BASE_DOMAIN=atlass.dpdns.org`, and it is baked in by the Dockerfile's `COPY . .`. Academy subdomains and custom domains are live. Only local dev leaves it unset. Code comments that still say "unset" are stale. | `atlas/.env.production:17`, `.dockerignore` |
| Flag modes are `off\|allowlist\|on` | That holds only for the 9 per-academy flags. The OTP flags are `off\|new_device\|always`, lifecycle is `off\|dry_run\|on`, and retention is `off\|warn_only\|on`. | `src/config/env.validation.ts` |
| `certificates`, `devicesPolicy`, `learnerDashboardV2` and `playerV2` are rollout controls | **They have no consumer.** They appear only in `FeatureFlagsService.snapshot()`, which nothing calls. Completion hardcodes `certificatesFeatureEnabled: true`. | `src/common/flags/feature-flags.service.ts` |
| "No flag is a security boundary" | **Two are.** The OTP mode flags decide whether a second factor is required. With `contentProtected` off, `contentUrl` is returned even for lessons the sequence marks **locked**, which bypasses drip and prerequisite locks for enrolled learners. | `course-content.service.ts:116-128`, `course-lesson.contract.ts:65-74` |
| "The frontend flag system is inert" | More precisely: the Live Sessions navigation item gates on the *dynamic* flag map, which is always `{}`. Setting the static `liveSessions: true` would **not** show it. | `navigation.config.ts:373`, `navigation.utils.ts:132`, `PlatformProvider.tsx` |
| "65 RLS tables have no DELETE policy" | Parsing the current migrations gives **56 of 88** RLS tables. | migrations |
| "Academy is the real security boundary" | Partly true. `AcademyScopeGuard` admits **any organization member into every academy of that org**. Per-academy isolation depends on service-level checks, and some services don't have them (see §4, S2). | `academy-scope.guard.ts:102` |
| `TenancyContextService` is the only setter of session variables | Registration also calls `set_config('app.current_user_id')` itself, with a fresh UUID. This is safe but is an exception. | `auth.service.ts:307` |
| P64 phases 1–3 complete; Phase 4 has two blockers | The plan contradicts itself: its status table says Phase 3 is complete, but DL-40 and the second-pass record say it is **open**. Phase 4 has more open items than DL-40: Alertmanager receiver wiring, the unbuilt `catalog.v2`/`checkout.student` flags, the J1–J4 seed gap, device-cookie slot burn, and the intro-video trailer. | `ATLAS_SECURE_LEARNING_MASTER_PLAN.md` |
| Communications "CLOSED" | The closure record says so, but the plan header still reads "IN PROGRESS", and BL-2, BL-3 and BL-4 are open. | `communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md` |
| Workflow: commit directly to `main` (DL-39) | The owner's decision stands for owner-driven work. Cloud sessions are assigned a working branch. See §7. | — |

Counts that **were** confirmed: 107 models, 108 enums, 123 migrations, one `@Processor`
per queue (14 queues), `atlas_app` created `NOSUPERUSER NOBYPASSRLS`, public
`MediaStorageProvider` exposes only `putObject`/`getObject`, and Stream `deleteAsset`'s
only caller is retention.

---

## 3. Architecture facts not in the handover

- **Authentication is opt-in per route.** The only global guard is the IP throttler.
  Of 444 routes, 412 use `JwtAuthGuard`, 24 are intentionally public (webhooks, health,
  public website, public plans, verify, auth), and the rest use auth rate-limit guards.
  There is no `RolesGuard`; roles are checked in services.
- **Background sweeps impersonate the oldest Platform Owner.**
  `findFirstPlatformOwnerId()` orders by `created_at` and does not filter on status. The
  SQL function `is_platform_owner()` does not check status either. These jobs depend on
  it: subscription sweep and expiry, tenant lifecycle, communications prune and
  dispatch, and phase-2 maintenance. **Removing Platform Owner accounts must keep at
  least one; otherwise every sweep silently no-ops.**
- **Environment and secrets.** Production values come from GitHub repo *variables*
  (`vars.FLAG_*`, `EMAIL_PROVIDERS`, …), synced by `.github/actions/vps-deploy`. The
  sync **drops empty values**, so deleting a variable does not turn a flag off; set it to
  `off` explicitly. `SURFACE_ENFORCE_MODE` (default `on`) and `BASIC_VIDEO_*` exist only
  in the VPS `.env`.
- **Frontend.** Tokens are stored in per-origin `localStorage`, and there is no
  cross-host handoff, so a learner signs in again on each academy host. `/my/*` exists
  only on academy hosts; on the main host it falls to NotFound. The API client retries
  **all methods, including POST**, up to 3 times on network errors, 5xx and 429.
- **Queues** (14): `communications`, `certificate-jobs`, `password-reset-email`,
  `tenant-usage-recompute`, `subscription-sweep`, `live-provider-event`,
  `live-session-sweep`, `video-retention`, `media-processing`, `payment-webhook`,
  `provisioning`, `quiz-deadlines`, `p64-phase2-maintenance`,
  `domain-verification-sweep`. The last one's repeat job id contains a `:`, which breaks
  the house rule (not runtime-verified as harmful).
- **Commerce.** The only payment provider is `ManualTransferProvider`. Gateway
  credential and connected-account models exist as scaffolding with no adapter.

---

## 4. Verified risks (ranked; none exploited, nothing changed)

No severe live cross-tenant or unauthenticated vulnerability was found.

| # | Sev | Risk | Evidence |
|---|---|---|---|
| S1 | High (operational) | **Video webhook and stall poll run with no RLS context.** Under `atlas_app`, `media_assets` reads return zero rows, so Stream events would be ignored as "unknown asset" and stalled assets never found. The code comment assumes superuser. Impact depends on the production `VIDEO_PROVIDER` (UNCONFIRMED). Live-session services have the same latent defect, but that feature is `coming_soon`. | `media/services/video-reconciliation.service.ts:54-123` |
| S2 | Medium | **Payouts and revenue are readable by any academy member of any role**, including instructors, and by managers of sibling academies in the same org. The service has no role check, and RLS is org-level only. | `academy-payouts.controller.ts:16`, `academy-scope.guard.ts:102` |
| S3 | Medium | The superuser `DATABASE_URL` and every backend secret are in `/opt/atlas/.env`, which is also the `env_file` of the **caddy/frontend** container. The `atlas_app` password in the migration is a committed dev value; whether it was rotated in production is UNCONFIRMED. | `deploy/docker-compose.prod.yml:43,59`, `20260823183500_p2_app_role_rls_enforcement` |
| S4 | Medium | **Authoring deletes cascade into learner data.** Deleting a section, lesson, quiz or assignment hard-deletes progress, attempts, results and submissions through FK cascades, which bypass RLS. There is no guard and no soft delete. | `course-sections.repository.ts:63`, `course-lessons.repository.ts:49`, `quizzes.repository.ts:279`, `assignments.repository.ts:101` |
| S5 | Low-Med | With `contentProtected` off, locked lessons still expose `contentUrl` (drip/prereq bypass). | §2 |
| S6 | Low-Med | `SubscriptionAccessInterceptor` skips about 70 mutating routes that have no academy context resolvable by `:academyId` or the guard: quizzes, assignments, announcements, forums, grading, enrollments. An expired tenant can still mutate through them. | `plans/interceptors/subscription-access.interceptor.ts` |
| S7 | Low-Med | Frontend retries POST requests, which risks duplicate non-idempotent writes. | `atlas/src/services/api/http-client.ts:194-235` |
| S8 | Low | The Brevo webhook secret is in the URL query, and pino logs `req.url` unredacted. | `common/logging/pino-options.factory.ts:79`, `email-webhook.controller.ts:60` |
| S9 | Low | Password-reset confirm is not atomic (find → update → markUsed). A reset does not revoke live access tokens, which stay valid up to 15 min. There is no refresh-token reuse detection. | `auth.service.ts:1022-1034` |
| S10 | Low | `DELETE FROM "notifications"` in the prune step is bounded only by an RLS policy. Under any BYPASSRLS connection it would delete everything. | `communication-dispatch.service.ts:~1001` |
| P1 | Scale | Announcement fan-out loads every recipient with no limit and emits per recipient, inside a request transaction with a 5 s timeout. It will fail at academy scale. | `community/services/announcements.service.ts:112-146` |
| P2 | Scale | The global JSON body limit is about 30 MB, because uploads use base64 in JSON. Reports load up to 50k rows into Node. No DB `connection_limit` is set. `lesson_progress.lesson_id` and `assignment_submissions.student_id` have no index. | `main.ts:48,103`, `dashboard/services/academy-reports.service.ts:40` |

Carried over from the handover and still true: media bytes are never deleted (the top
product and data gap), Stream tokens cannot be revoked, and `index.html` is served with
no `Cache-Control`.

---

## 5. Verified product gaps (backend without UI, or UI without backend)

- **The UI calls endpoints that don't exist; these 404 in production.**
  `GET/PATCH /platform-settings/communications` (Platform Settings → Communications) and
  `GET/PATCH /academies/:id/communication-settings` (Academy Settings). No backend route
  or branch implements them.
- **Commerce operations have no UI:** org payment/gateway settings, course-order payment
  approval and reject, refunds, academy payouts and revenue summary, platform payouts,
  platform commission.
- **Content-protection settings have no UI:** content protection, video tier, device
  policy, protected video upload.
- **Also backend-only:** platform announcements CRUD, website contact-form submissions,
  learner self-service deletion plan, email-verification resend.
- **Live Sessions:** the navigation is hidden but the routes are reachable by URL, and
  there is no learner join page.
- **Dead code:** legacy learning pages (`StudentMyLearningPage`, `LessonPage`, …),
  `StudentLiveSessionPage`, `AuthCallback`/`AuthError`, and an empty `/blog` prerender
  scaffold.

---

## 6. Maturity levels (implemented → deployed → enabled → integrated → prod-verified)

| Subsystem | Level reached |
|---|---|
| Auth, OTP (`new_device`), trusted devices | Prod-verified (Platform Owner sign-in, per handover) |
| Catalog, courses, enrollment, quizzes v2, certificates, reviews, reports | Integrated; prod-verified per the Master Plan appendix, with learner flows *verification pending (credential)* |
| Manual-transfer subscription billing | Prod-verified (Platform Owner approval) |
| Course commerce (orders, payouts, refunds, commission) | Deployed, **UI missing** |
| Communications (Brevo) | Prod-verified (closure record) |
| Website builder, subdomains, custom domains | Deployed and enabled (base domain set) |
| Hosted video (Stream/Basic) | Implemented; `FLAG_VIDEO_NORMAL` off and `BASIC_VIDEO_*` unset, so **not enabled** |
| Video retention | Enabled in `warn_only` |
| Account deletion | Self-delete and Platform Owner delete prod-verified; storage teardown **not built** |
| Live sessions (Zoom) | Implemented; blocked on Zoom Marketplace approval |
| Alerting | Rules committed; receiver not wired |
| Feature-flag management UI | Not built (PLATFORM CONTROL MISSING) |

---

## 7. How this session works

- **Loop:** inspect → plan → implement → targeted tests (prove they bite) → security
  review → commit → push → deploy → verify production → report.
- **Branch:** cloud sessions push to their assigned `claude/*` branch. Production deploys
  trigger only on `main`. Merging to `main` is therefore the deploy step, and needs the
  owner's go-ahead or an explicit "ship it". This does not override DL-39 for the owner's
  own work.
- **CI is off,** so local verification is the only gate. Backend: `npx jest <path>`,
  `npx tsc --noEmit`, `npx eslint`. Frontend: `npx vitest run <path>`,
  `npx tsc -p tsconfig.app.json --noEmit` (baseline 34), `npx vite build`. Any new
  cross-module provider must extend `deletion-module-graph.spec.ts`.
- **Migrations** ship only through the gated dispatch described in §2. Plan every schema
  change as a separate, owner-approved step.
- **Production verification** from this container needs the network allowance in §1.
  Without it, the only deploy evidence is the Actions run conclusion, and reports must
  say so.
