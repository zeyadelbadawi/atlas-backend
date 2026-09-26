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

## 4. Verified risks (ranked; none exploited) — status as of the §8 remediation pass

No severe live cross-tenant or unauthenticated vulnerability was found.

| # | Sev | Risk | Evidence |
|---|---|---|---|
| S1 | **FIXED** (§8 A) | **Video webhook and stall poll run with no RLS context.** Under `atlas_app`, `media_assets` reads return zero rows, so Stream events would be ignored as "unknown asset" and stalled assets never found. The code comment assumes superuser. Impact depends on the production `VIDEO_PROVIDER` (UNCONFIRMED). Live-session services have the same latent defect, but that feature is `coming_soon`. | `media/services/video-reconciliation.service.ts:54-123` |
| S2 | **FIXED** (§8 B) | **Payouts and revenue are readable by any academy member of any role**, including instructors, and by managers of sibling academies in the same org. The service has no role check, and RLS is org-level only. | `academy-payouts.controller.ts:16`, `academy-scope.guard.ts:102` |
| S3 | **FIXED** for the edge container (§8 C); `atlas_app` password rotation still UNCONFIRMED | The superuser `DATABASE_URL` and every backend secret are in `/opt/atlas/.env`, which is also the `env_file` of the **caddy/frontend** container. The `atlas_app` password in the migration is a committed dev value; whether it was rotated in production is UNCONFIRMED. | `deploy/docker-compose.prod.yml:43,59`, `20260823183500_p2_app_role_rls_enforcement` |
| S4 | **FIXED** (§8 D) | **Authoring deletes cascade into learner data.** Deleting a section, lesson, quiz or assignment hard-deletes progress, attempts, results and submissions through FK cascades, which bypass RLS. There is no guard and no soft delete. | `course-sections.repository.ts:63`, `course-lessons.repository.ts:49`, `quizzes.repository.ts:279`, `assignments.repository.ts:101` |
| S5 | **FIXED** (§8 H) | With `contentProtected` off, locked lessons still expose `contentUrl` (drip/prereq bypass). | §2 |
| S6 | Low-Med | `SubscriptionAccessInterceptor` skips about 70 mutating routes that have no academy context resolvable by `:academyId` or the guard: quizzes, assignments, announcements, forums, grading, enrollments. An expired tenant can still mutate through them. | `plans/interceptors/subscription-access.interceptor.ts` |
| S7 | **FIXED** (§8 E) | Frontend retries POST requests, which risks duplicate non-idempotent writes. | `atlas/src/services/api/http-client.ts:194-235` |
| S8 | Low | The Brevo webhook secret is in the URL query, and pino logs `req.url` unredacted. | `common/logging/pino-options.factory.ts:79`, `email-webhook.controller.ts:60` |
| S9 | Low | Password-reset confirm is not atomic (find → update → markUsed). A reset does not revoke live access tokens, which stay valid up to 15 min. There is no refresh-token reuse detection. | `auth.service.ts:1022-1034` |
| S10 | Low | `DELETE FROM "notifications"` in the prune step is bounded only by an RLS policy. Under any BYPASSRLS connection it would delete everything. | `communication-dispatch.service.ts:~1001` |
| P1 | **FIXED** (§8 F) | Announcement fan-out loads every recipient with no limit and emits per recipient, inside a request transaction with a 5 s timeout. It will fail at academy scale. | `community/services/announcements.service.ts:112-146` |
| P2 | Scale | The global JSON body limit is about 30 MB, because uploads use base64 in JSON. Reports load up to 50k rows into Node. No DB `connection_limit` is set. `lesson_progress.lesson_id` and `assignment_submissions.student_id` have no index. | `main.ts:48,103`, `dashboard/services/academy-reports.service.ts:40` |

Carried over from the handover and still true: media bytes are never deleted (the top
product and data gap), Stream tokens cannot be revoked, and `index.html` is served with
no `Cache-Control`.

---

## 5. Verified product gaps (backend without UI, or UI without backend)

- ~~**The UI calls endpoints that don't exist; these 404 in production.**~~ **FIXED (§8 G)** —
  `GET/PATCH /platform-settings/communications` (Platform Settings → Communications) and
  `GET/PATCH /academies/:id/communication-settings` (Academy Settings). No backend route
  or branch implements them.
- ~~**Commerce operations have no UI**~~ **FIXED (§8 I)** except org payment/gateway settings (no gateway adapter exists). Was: course-order payment
  approval and reject, refunds, academy payouts and revenue summary, platform payouts,
  platform commission.
- ~~**Content-protection settings have no UI:**~~ **FIXED (§8 J)**, except the protected video *upload* path (blocked with hosted video). Was: content protection, video tier, device
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
| Course commerce (orders, payouts, refunds, commission) | Deployed **with UI** (§8 I); gateway settings still backend-only (no adapter). Signed-in prod verification pending (no access from cloud) |
| Communications (Brevo) | Prod-verified (closure record) |
| Website builder, subdomains, custom domains | Deployed and enabled (base domain set) |
| Hosted video (Stream/Basic) | Implemented; `FLAG_VIDEO_NORMAL` off and `BASIC_VIDEO_*` unset, so **not enabled** |
| Video retention | Enabled in `warn_only` |
| Account deletion | Self-delete and Platform Owner delete prod-verified, both now with real-Postgres e2e; superseded certificate PDFs purged (§8 K); public-media and Stream teardown **blocked on an owner decision** (§8) |
| Live sessions (Zoom) | Implemented; blocked on Zoom Marketplace approval |
| Alerting | Rules committed; **not wired — external blocker** (§8 L) |
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

---

## 8. Remediation pass (26 Sep 2026)

Every fix below has a regression test **proven to fail on the previous code** (run
against real Postgres as `atlas_app`, or with the guard removed for frontend units).
Local gates each time: backend `tsc` clean, lint clean on touched files, affected unit
specs green (2450+ tests) plus the affected e2e suites; frontend typecheck at the
34-error baseline, full vitest suite **103 files / 948 tests**, `vite build` succeeds.

"Deployed" means the GitHub Actions Deploy run succeeded. `deploy.sh` health-checks the
backend `/health` and Caddy HTTPS, so a success run also proves the containers came up
healthy. **Production HTTP was not probed**: the cloud container cannot reach
`atlass.dpdns.org` (§1). Signed-in flows are therefore *production verification
pending*, not verified.

| # | Finding | Root cause | Fix | Test | Commit |
|---|---|---|---|---|---|
| A | Video webhook / stall poll silent no-op | `prisma.*` with no RLS context on FORCE-RLS `media_assets` | Locate in platform-owner read context, write in the asset's tenant context; zero-row update throws | `video-reconciliation-rls.e2e-spec.ts` | be `d538fd2` |
| B | Payouts/revenue readable by any staff and sibling-academy managers | `AcademyScopeGuard` admits any org member; the service had no role check | Organization-Owner-only (the existing `tenant.billing.*` model); RLS agrees at the org boundary | access-matrix cases in `course-commerce-tenant-isolation.e2e-spec.ts` | be `d538fd2` |
| C | Edge container held every backend secret | `caddy` used `env_file: .env` | `caddy` receives only `CLOUDFLARE_API_TOKEN`, the one `{env.*}` in the Caddyfile | rendered `docker compose config` checked | be `d538fd2` |
| D | Authoring deletes erased learner records | `ON DELETE CASCADE` into progress, attempts, results and submissions; FK actions ignore RLS | 409 `errors.course.hasLearnerActivity` ("unpublish instead") when learner activity exists, counted in tenant context; untouched content still deletes | `content-delete-learner-activity.e2e-spec.ts` | be `d538fd2`, fe `c1ebedb` |
| E | Client replayed ambiguous writes | Retry policy ignored the HTTP method | Replays only idempotent methods, 429, or bodies carrying an `idempotencyKey` | `http-client-retry.test.ts` | fe `c1ebedb` |
| F | Announcement fan-out inside the 5 s request transaction | One emit per learner, in the request transaction | One job enqueued in-transaction on new queue `announcement-fanout` (one processor); re-validated at execution; batches of 200; per-recipient dedupe | `announcement-fanout.e2e-spec.ts` (old code emitted 437 rows inline) | be `d538fd2` |
| G | Comms settings screens 404 | Frontend built against contracts that never shipped | Read-only `GET /platform-settings/communications` and `GET /academies/:id/communication-settings` report the configuration in force (`editable:false`); both UIs render read-only | `communication-settings-view.e2e-spec.ts`, UI tests | be `d538fd2`, fe `c1ebedb` |
| H | Locked-lesson URL exposed while `contentProtected` is off | The flag decided URL exposure, including for locked lessons | A locked lesson never carries `contentUrl`, whatever the flag | `learning-progress.e2e-spec.ts` | be `d538fd2` |
| — | Four dead flags | No consumer (`certificates`, `devicesPolicy`, `learnerDashboardV2`, `playerV2`) | Removed from config, validation, deploy sync and fixtures. Stale VPS values are ignored because the schema is not strict | flag e2e suites (91) | be `d538fd2` |
| I | No commerce UI | Backend-only | Platform Owner: Commerce → Course payments (review/approve/reject/proof), Payouts (create, mark paid), Commission (global, plan, org card). Client Owner: Academy → Revenue & payouts. Learner: self-service refund on `/my/purchases` | 32 + 22 page tests | fe `f750e50`, `4cce4dc` |
| I' | "Pending" course-payment queue listed every payment | `reviewStatus` accepted by the DTO, never applied | Passed through to the query | filter case in the isolation e2e | be `a428452` |
| J | No content-protection UI | Backend-only | Academy Settings → Content protection (watermark, video tier, device policy), owner-only as the backend enforces | 13 card tests | fe `99e4423` |
| K | Superseded certificate PDFs kept real names | Versioned keys; re-issue/regeneration left old versions; anonymisation re-renders only the current one | `purge-superseded` job on `certificate-jobs`: re-validate → delete → verify absent; the current version is never touched | `certificate-superseded-purge.e2e-spec.ts` | be `cce0de7` |
| — | Platform Owner deletion had only mocked-tx specs | — | Real-Postgres e2e: plan counts, anonymisation, membership removal, refusals | `platform-user-deletion.e2e-spec.ts` | be `a1dccdb` |
| — | `apiErrorMessage` rendered a translation group as garbled text | `errors.notFound` is a `{title, description}` group | Prefers `<key>.description`; never returns a non-string | `api-error-copy.utils.test.ts` | fe `067b8ce` |

### Decided as intentional (documented, not changed)

- **Per-academy learner sign-in.** This is design decision AD-5
  (`ATLAS_SECURE_LEARNING_MASTER_PLAN.md`): sessions store `surface` + `academy_id`, and
  the academy is re-verified against the request host. Per-academy device and session
  policy depends on it. Cross-academy SSO would contradict AD-5, so it needs an owner
  decision and a protocol design, not a patch.

### Blocked — needs the owner

- **Editable communication settings (G).** Making them editable moves the OTP control
  plane from deployment config into the database. That needs a migration (gated, see
  §2) and a security decision.
- **Public-media and Stream teardown on archive.** `ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md`
  §4 says teardown must not ship before the Client Owner grace decision is confirmed.
  Archive is also not established as irreversible, so destroying bytes on archive is a
  product decision. The `deleteObject` capability was deliberately not added without a
  caller.
- **Alert routing (L).** Nothing runs Prometheus or Alertmanager in production. Two
  things are needed: (1) a way to scrape `/metrics`, which accepts only a 15-minute
  Platform-Owner JWT — the proposal is an internal-only scrape token, e.g.
  `METRICS_SCRAPE_TOKEN`, which is a security design decision; and (2) receiver
  credentials of the owner's choosing (e.g. an SMTP or Slack webhook secret) placed in the
  VPS `.env`. No alert delivery has been verified.
- **Refund money movement.** The backend records a refund as `succeeded` without calling
  any provider, so the UI says the refund is *recorded*. How money actually returns under
  manual transfer is a business process to define.
- **Org payment-gateway settings UI.** No gateway adapter exists (manual transfer only).

### Deferred (P2 — independent, not touched)

- DB-level backstop for D. Switching the four learner FKs to `RESTRICT` would close the
  check-then-delete race, but it is a gated migration and would block every backend
  deploy until approved.
- Scheduled announcements (`publishDueScheduled`) publish without any fan-out, a
  pre-existing gap; route them through `AnnouncementFanOutProducer`.
- Live-session services share the no-RLS-context defect of A (latent while
  `coming_soon`).
- ~70 mutating routes skip `SubscriptionAccessInterceptor` (S6).
- S8 (Brevo secret in logged URL), S9 (reset-token race; access tokens survive a reset),
  S10.
- P2 scale items (§4): body limit, report row caps, `connection_limit`, two missing
  indexes.
- Frontend `BaseService` list helper ignores the server's total count (wrong page
  counts), and the `liveSessions` nav gate is unreachable.
- The download/PiP/context-menu content-protection flags are stored but never reach the
  player (shown as "always on"). `maxConcurrentSessions` is stored, but the learning lease
  is always one device.
- Commission rates can be set but not cleared, and course payments carry no org/academy
  names.

### Deferred (P3)

- `certificate-render:…` / `certificate-issue:…` job ids contain colons. BullMQ 5 accepts
  exactly-3-part ids and tested fine, but they break the house rule.
- `LearningLeaseService.revokeAll` is not called on deletion (sessions are already
  revoked).
- Legacy dead pages; empty `/blog` scaffold.
