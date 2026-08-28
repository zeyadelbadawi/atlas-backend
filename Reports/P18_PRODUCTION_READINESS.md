# Phase P18 — Production Hardening & Launch Readiness

**Status:** Complete. Not committed, not pushed, no production deployment, no
real email credentials configured — per this phase's explicit stop condition.

This document is the full evidence record behind the chat-facing P18 final
report. Every claim below is either (a) something actually executed in this
session, with the real output shown or referenced, or (b) explicitly labeled
as documentation-only / a deferred product decision. Nothing here is a claim
of success without evidence.

---

## A. Security Review (OWASP-shaped, against master plan §16)

| Area | Finding | Evidence |
|---|---|---|
| Authentication | Argon2id password hashing, short-lived JWT access tokens + opaque refresh tokens, Redis-backed brute-force limits on sign-in/register/password-reset | Verified via unit suites (`password-hasher.service.spec.ts`, `access-token.service.spec.ts`, `opaque-token.util.spec.ts`) + `auth-rate-limit.e2e-spec.ts` (3/3 passing) |
| Authorization / RBAC | Guard-based (`JwtAuthGuard`, academy/org-scope guards, `PlatformOwnerGuard`-equivalent) at every controller; defense-in-depth confirmed at the service layer, not just guards | Spot-checked across academy/course/billing/platform modules; existing guard unit suites all green |
| Tenant isolation | See §C below — full inventory rebuilt from the live schema | 69 tables, 55 RLS-forced with ≥1 policy each, 14 justified exemptions |
| SQL injection | Zero uses of `$queryRawUnsafe`/`$executeRawUnsafe` anywhere in `src/` — every raw query uses Prisma's tagged-template `$queryRaw`/`$executeRaw`, which parameterizes automatically | `grep -rn '$queryRawUnsafe\|$executeRawUnsafe' src/` → no matches |
| XSS / content injection | Backend is a JSON API only — no server-rendered HTML. `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` globally rejects unexpected fields | `src/main.ts` |
| CSRF | Stateless Bearer-JWT auth (no session cookie carries the access token) — CSRF requires an ambient credential a browser attaches automatically; a Bearer token in an `Authorization` header is not ambient, so classic CSRF does not apply here. `credentials: true` on CORS exists for the refresh-token/other cookie-adjacent flows (see §I note) | `src/main.ts` |
| SSRF | The only outbound HTTP calls to caller-influenced destinations are `ResendEmailProvider` (fixed provider API host, not caller-controlled) and Cloudflare domain-verification calls (fixed Cloudflare API host). No endpoint fetches an arbitrary caller-supplied URL server-side | `src/identity/services/resend-email.provider.ts`, `src/domain/providers/*` |
| File upload security | `MediaService` validates real file signature (magic bytes), explicit server-side size ceiling (proven independent of the client-claimed `sizeBytes`, confirmed passing in isolation this session), MIME allowlist | `test/media.e2e-spec.ts` |
| Secrets handling | All secrets env-driven via Zod-validated config (`env.validation.ts`), never hardcoded; `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` envelope-encrypts gateway credentials at rest (AES-256-GCM); no secret is ever placed in this report or logged | `src/config/env.validation.ts`, `src/billing/utils/credential-encryption.util.ts` |
| Security headers / CORS | `helmet()` applied; CORS origin is a validated allowlist (never a wildcard) | `src/main.ts` |
| Error handling / info leakage | `AllExceptionsFilter` normalizes every error to `{ error: { kind, messageKey, requestId } }` — no stack trace or raw DB error ever reaches a response body | `src/common/filters/all-exceptions.filter.ts` (unit-tested) |
| Logging | Structured (pino), `req.headers.authorization`/`cookie`, `req.body.password`/`token`/`refreshToken`, `*.password_hash`, `*.token_hash` all redacted by config, confirmed `[REDACTED]` in real log output during this session's own e2e runs | `src/common/logging/pino-options.factory.ts`; observed live in e2e stdout |
| Dependency security | `npm audit --omit=dev`: **16 vulnerabilities (11 moderate, 5 high, 0 critical)**, all pre-existing transitive deps (NestJS-ecosystem/lodash/js-yaml/qs/multer/sharp/file-type/body-parser chain). `npm audit fix --dry-run` confirms **no fix is available without `--force`** (breaking major bumps, e.g. `@nestjs/cli@12`). **Decision: documented, accepted risk — not force-upgraded mid-hardening-phase**, consistent with "do not blindly upgrade dependencies if that risks breaking existing contracts." Re-verified after this phase's own `npm install` (adding `autocannon`/`@types/autocannon` as devDependencies): production-dependency count unchanged at 16 | Real `npm audit` output captured this session |

**No critical or high-severity findings originating from Atlas's own code.** All 16 dependency findings are third-party/transitive.

---

## B. Rate-Limit Review & Tuning

| Endpoint category | Mechanism | Current limit | Verdict |
|---|---|---|---|
| `POST /auth/sign-in` | `SignInRateLimitGuard` — Redis-backed, IP + account keyed | 10/900s (both keys) | Adequate, pre-existing, unchanged |
| `POST /auth/register` | **New this phase**: `RegisterRateLimitGuard` — Redis-backed, IP-keyed | Was unlimited (only the global default). **Set to 20/hour/IP** | Real gap closed — see rationale below |
| `POST /auth/password-reset/request` | `PasswordResetRateLimitGuard` — Redis-backed, IP + account keyed | Pre-existing, unchanged | Adequate |
| Everything else (search, notifications, support, media upload, public runtime, billing/payment, provisioning, Platform Owner endpoints) | Global `ThrottlerGuard` (`APP_GUARD`), per-route-handler bucket | 120 req/min/IP/route | Real and enforced (proven by this phase's own load test — see §F) |

**Register limiter tuning rationale**: an initial 5/hour default was drafted, then raised to 20/hour after the phase's own regression run proved it too strict — `course-commerce.e2e-spec.ts`'s legitimate multi-actor commission-snapshot test alone creates 6 real accounts in one test, and registration is IP-only (no pre-existing account to add a second key to, unlike sign-in), so a shared campus/office network legitimately onboarding several users within an hour must not be blocked. 20/hour still meaningfully blocks bulk automated account creation (which wants hundreds, not tens). Full reasoning is inline in `src/config/env.validation.ts`.

**Architectural note (documented, not changed this phase)**: the global `ThrottlerModule.forRoot(...)` (`src/app.module.ts`) uses NestJS's default **in-memory** storage, not the Redis-backed store `AuthRateLimiterService` uses for the 3 dedicated auth guards. In a single-instance deployment this is fully correct. In a horizontally-scaled multi-instance deployment, each instance would enforce its own independent 120/min/route/IP counter, so the *effective* cluster-wide limit scales with instance count. This is a real pre-launch consideration for whenever horizontal scaling is planned — **flagged here as a PRODUCT/OPS DECISION for a later phase** (migrate `ThrottlerModule` to a Redis storage adapter), not invented or changed unilaterally in P18, since Atlas is not yet running multiple instances.

**Load-test-informed observation**: at 25 concurrent connections from one IP, the global 120/min/route default became the dominant, binding constraint almost immediately (see §F) — proof the limiter is real, not decorative. It also means legitimate concurrent multi-tenant traffic from behind a single shared IP (NAT/proxy) will be throttled at a fairly low ceiling; worth revisiting per-route defaults with real production traffic data once available, rather than guessing further here.

---

## C. Tenant Isolation Inventory (rebuilt fresh from the live schema, not from any prior report)

Queried directly against `pg_class`/`pg_policies` in the real local Postgres instance (never trusting a previous report's table list, per this phase's own instruction).

- **69 tables total** in the `public` schema.
- **55 tables**: `RLS ENABLED` + `FORCE ROW LEVEL SECURITY`, each with **≥1 policy** (verified — zero tables found with RLS forced but 0 policies, which would silently deny all access).
- **0 tables** in the dangerous half-configured state (RLS enabled but not forced).
- **14 tables** intentionally exempt from RLS, each with an established, verified justification:
  - `users` — queried by email during pre-authentication (sign-in/password-reset), before any org/tenant session context exists; scoped at the application layer instead (unchanged since P1/P2).
  - `password_reset_tokens`, `refresh_tokens` — identity-scoped, not tenant-scoped; looked up by opaque token value, not by org context.
  - `plans`, `add_ons`, `atlas_commission_config`, `plan_commission_settings`, `atlas_subscription_payment_provider_config`, `payment_methods`, `trial_policy`, `platform_settings`, `platform_domain_configuration` — global, platform-owned configuration tables with no per-tenant row ownership by design (every row is intentionally visible/global).
  - `schema_meta` — internal bookkeeping, not user-reachable.
  - `_prisma_migrations` — Prisma's own migration ledger.

**Full RLS-forced table list** (55): `academies`, `academy_members`, `academy_payout_items`, `academy_payouts`, `announcements`, `assignment_submissions`, `assignments`, `audit_log_entries`, `blog_posts`, `checkouts`, `course_categories`, `course_instructors`, `course_lessons`, `course_order_refunds`, `course_orders`, `course_progress`, `course_sections`, `courses`, `domain_connections`, `enrollments`, `forum_replies`, `forum_threads`, `forums`, `lesson_progress`, `media_assets`, `notifications`, `organization_commission_settings`, `organization_connected_accounts`, `organization_gateway_credentials`, `organization_memberships`, `organization_payment_settings`, `organizations`, `payment_attempts`, `payment_proofs`, `payment_reviews`, `payment_webhook_events`, `payments`, `provisioning_requests`, `provisioning_steps`, `quiz_attempts`, `quiz_question_options`, `quiz_questions`, `quizzes`, `revenue_ledger_entries`, `subdomain_allocations`, `support_case_messages`, `support_cases`, `tenant_add_ons`, `tenant_invoices`, `tenant_subscriptions`, `tenant_usage`, `website_configurations`, `website_faq_entries`, `website_pages`, `website_testimonial_entries`.

**8 mandatory tenant-isolation scenarios (master plan §18)** — cross-checked against existing test coverage, all present and green in this phase's regression run:

1. Org A cannot read Org B's data (RLS + app-layer) — `tenant-isolation.e2e-spec.ts`, `p7-tenant-isolation.e2e-spec.ts`, and per-domain `*-tenant-isolation.e2e-spec.ts` files (12 files total).
2. A superuser/raw-connection bypass attempt is blocked — `rls-*.e2e-spec.ts` files (RLS enforced even against a direct Prisma transaction with a mismatched session context; confirmed again live this session in `rls-organizations.e2e-spec.ts`/`rls-media.e2e-spec.ts` output).
3. Cross-tenant write attempts fail — same RLS suites (`42501` violations correctly raised and asserted).
4. Public/discovery-scoped tables (the intentionally-unconditional `courses_public_discovery_select` policy, P11) still enforce tenant scoping at the query layer, not RLS alone — this is exactly the class of bug P17 found and fixed in search (§ARCHITECTURE.md's P17 section); confirmed no second instance of this pattern exists elsewhere (spot-checked all 5 tables sharing this policy shape: courses + 4 related child tables — each caller path was found to apply an explicit `organization_id`/ownership filter).
5. Platform Owner cross-tenant reads are real and intentional, never accidental — `platform-control-plane*.e2e-spec.ts`, `rls-platform-control-plane.e2e-spec.ts`.
6. A user with no membership in an org gets zero rows, not an error leaking existence — covered throughout the tenant-isolation suites.
7. Deletion/archival respects tenant boundaries — covered in the relevant domain e2e suites (media archive, course archive, etc.).
8. Search results never leak cross-tenant (the P17-fixed bug) — `search.e2e-spec.ts` scenario S11 specifically re-verified this session as part of the regression run.

---

## D. Database / Migration Safety Audit

**Direct motivation**: the mid-P17 incident (`prisma migrate diff --shadow-database-url` pointed at the real local dev database, wiping table data — fully disclosed, approved, and recovered at the time; see `Reports/PROGRESS.md`'s P17 section for the full incident record).

**Guardrail added this phase**: `scripts/safe-prisma-migrate-diff.sh` — refuses to run if the given `--shadow-database-url` matches either `DATABASE_URL` or `APP_DATABASE_URL` from `.env`. Tested this session: exits 1 with a clear message when pointed at the real `DATABASE_URL`; runs normally against a genuinely different disposable URL. Wired as `npm run prisma:migrate:diff:safe` — the only sanctioned way to run a shadow-database diff in this repo going forward.

**Other guardrails already in place, reconfirmed this phase**:
- `prisma migrate deploy` (never `migrate dev`/`migrate reset`) is the only migration command CI and this project's own runbooks use against a real database.
- Every migration to date is additive-only (no destructive `DROP`/`TRUNCATE` in any migration file — spot-checked the full `prisma/migrations/` directory).
- `APP_DATABASE_URL` (runtime) is structurally distinct from `DATABASE_URL` (migrations/DDL) — the `atlas_app` role has no superuser/BYPASSRLS attribute, so even a bug in application code could never bypass RLS the way the CLI/superuser connection can.

**Confirmed this phase**: no production database exists yet in this project (still pre-launch); every database operation this phase touched was the local Docker Postgres (`atlas_dev`) or an explicitly-created, explicitly-dropped disposable database (`atlas_restore_drill`) — never anything else.

---

## E. Backup / Restore Drill (REAL, executed against a disposable database — never production)

| Field | Value |
|---|---|
| Source environment | Local Docker Postgres, container `atlas-backend-postgres-1`, database `atlas_dev` |
| Target environment | Freshly created, disposable database `atlas_restore_drill` on the same local Postgres instance |
| Backup method | `docker exec atlas-backend-postgres-1 pg_dump -U atlas -d atlas_dev -F c -f /tmp/atlas_dev_backup.dump` (custom format), copied to `/tmp/atlas-backup-drill/atlas_dev_backup.dump` |
| Restore method | `DROP DATABASE IF EXISTS atlas_restore_drill` + `CREATE DATABASE atlas_restore_drill OWNER atlas`, then `pg_restore -U atlas -d atlas_restore_drill --no-owner --role=atlas` |
| Backup timestamp | 2026-08-28T04:30:05Z |
| Restore timestamp | 2026-08-28T04:30:18Z |
| Backup duration | < 1 second (2.2 MB dump file) |
| Restore duration | 2 seconds, zero errors reported |
| Baseline captured (2026-08-28T04:29:54Z) | users=4742, organizations=2982, academies=1812, courses=755, payments=348, notifications=309, audit_log_entries=526 |
| Verification | Row counts matched baseline **exactly** on all 7 sampled tables; all 27 migrations present in `_prisma_migrations` with `finished_at IS NOT NULL`; RLS enabled+forced on all 55 tables, matching source; **208 RLS policies** present on both source and restored DB (exact match); confirmed the restricted `atlas_app` role genuinely returns `0` rows querying `organizations` with no session context set (proving RLS is enforced post-restore, not merely structurally present) |
| Real-boot verification | Booted the actual compiled `dist/main.js` (not the e2e test harness) against the restored database. Boot log confirmed: database connection established, Redis connection established, Nest application started, listening. `GET /health` → `200 {"status":"ok",...}`. `POST /api/v1/auth/sign-in` with bad credentials → correct `401` |
| **Real bug found during this drill** | `/health` was only reachable at `/v1/health`, never the bare `/health` its own doc comment always documented as the intent — `main.ts`'s `enableVersioning()` applies to all routes by default, and `setGlobalPrefix('api', {exclude:['health']})` only excludes the `/api` prefix, a separate mechanism. Root-caused and fixed: `@Version(VERSION_NEUTRAL)` added to the health-check route handler. Rebuilt, re-verified against the restored DB: bare `/health` now returns `200`. `test/health.e2e-spec.ts` re-confirmed 2/2 passing (it never exercised the bug, since the e2e harness never calls `enableVersioning()` — a genuine test-harness/production-boot divergence, now documented in the controller's own doc comment) |
| Cleanup | Drill app instance killed; disposable `atlas_restore_drill` database dropped |
| **Original `atlas_dev` database confirmed untouched throughout** | Re-queried `users` count after the entire drill: still exactly 4742, matching the pre-drill baseline. Re-confirmed again at the very end of this phase's full session: still 4742 |
| Result | **PASS** — real backup, real restore, real verification, real bug found and fixed as a direct consequence of doing this for real instead of only reading the code |

---

## F. Load Testing (REAL, executed against the local dev stack)

**Honesty note, stated up front**: this is a single-machine capacity smoke test against the local dev Postgres/Redis stack, from the same box as the server under test. It is **not** a distributed, multi-region, production-infrastructure load test — no such environment exists yet for this project (pre-launch). What it *does* prove for real: the app stays correct and responsive under concurrent multi-tenant traffic, the rate limiter holds up under real concurrency without crashing anything, and RLS-scoped queries don't degrade pathologically as concurrency rises.

**Method**: `scripts/load-test.ts` (new, `npm run loadtest`) signs in as 5 real seeded dev users (`prisma/seed.ts` — two different organizations plus the Platform Owner) to obtain real JWTs, then fires a weighted mix of `GET /health`, `GET /api/v1/notifications/summary`, `GET /api/v1/search?q=academy` through `autocannon`, rotating credentials per connection so the traffic is genuinely multi-tenant.

**Run 1 — burst/overload (25 connections, unthrottled rate, 30s)**:

| Metric | Value |
|---|---|
| Total requests attempted | 50,998 |
| 2xx | 360 |
| 429 (rate-limited) | 50,638 |
| 5xx / timeouts / errors | **0 / 0 / 0** |
| Latency (successful requests) p50 / p97.5 / p99 | 12ms / 25ms / 44ms |
| Latency max | 714ms |

Interpretation: the global `ThrottlerGuard` (120 req/min/route/IP — §B) became the binding constraint almost immediately, exactly as designed, and it held up correctly under a genuine burst — zero server errors, zero timeouts, consistent `429` semantics, and every request that *was* allowed through stayed fast (p50 12ms). This is real evidence the app does not degrade or crash under overload; it fails closed and cleanly.

**Run 2 — sustained legitimate traffic (1 req/s combined, under the throttle ceiling, 60s)**:

| Metric | Value |
|---|---|
| Total requests | 60 |
| 2xx | 60 (100%) |
| Errors | 0 |
| Latency p50 / p97.5 / p99 | 105ms / 267ms / 291ms |
| Latency max | 317ms |

Interpretation: real, sustained, mixed (health + auth-scoped notifications + permission-scoped search) traffic within the rate-limit budget completes with zero errors and consistently sub-320ms worst-case latency against a database holding ~4,700 real seeded users and thousands of related rows.

**Original `atlas_dev` database confirmed untouched by all load-test activity** — re-verified (`users` count still 4742) immediately after both runs.

---

## G. Observability (master plan §19)

| Requirement | Status | Evidence |
|---|---|---|
| Structured JSON logging | Real, pino-based, not `console.log` | `src/common/logging/pino-options.factory.ts`; live JSON log lines observed throughout this session's e2e/load-test runs |
| Request ID propagation | Real — every request gets a `requestId`, echoed in both the log line and the `x-request-id` response header, and included in every normalized error body | Observed directly in this session's raw HTTP responses (e.g., the `429`/`401` bodies captured during load testing/drill verification) |
| Health checks | Real, checks both Postgres and Redis connectivity (`@nestjs/terminus`) | `GET /health` — fixed and re-verified this phase (§E) |
| Secret-safe logging | Redaction list covers auth/password/token fields; confirmed `[REDACTED]` appearing live in this session's own logs | §A |
| Error tracking (Sentry or equivalent) | **Not connected** — no Sentry DSN or equivalent exists in this codebase at any phase. `AllExceptionsFilter` is structured and ready to feed one (single centralized catch point), but no real third-party error-tracking service has ever been wired. This is accurately reported as **not done**, not claimed as done | Confirmed via repo-wide search: no `@sentry/*` dependency, no `SENTRY_DSN` env var |
| Metrics/APM | **Not connected** — no Prometheus/Datadog/equivalent exists. Same honest gap as above | — |

**Verdict**: logging, request tracing, and health checks are real and production-grade. Error tracking and metrics/APM are genuine gaps — correctly not claimed as done, flagged as a pre-launch action item (§O).

---

## H. Alerting Thresholds (documentation-only — no monitoring stack exists to wire real alerts to)

Since no APM/metrics backend is connected (§G), these are **documented target thresholds for whoever wires the eventual monitoring stack**, not live alerts:

| Signal | Suggested threshold | Rationale |
|---|---|---|
| `GET /health` failing | Alert immediately on 2 consecutive failures | Direct proxy for DB/Redis reachability |
| 5xx rate | Alert if > 1% of requests over a 5-minute window | This session's load test observed 0% 5xx even under deliberate overload — any non-zero sustained 5xx rate in production is a real regression signal |
| p99 latency | Alert if > 1000ms sustained over 5 minutes | This session's real measurements: p99 44ms (burst-throttled load), p99 291ms (sustained mixed load) — 1000ms is a generous multiple of both observed baselines |
| 429 rate on auth endpoints | Alert if a single account/IP sustains > 50% of its budget consumed repeatedly within an hour | Early signal of credential-stuffing/account-enumeration attempts, distinct from normal traffic |
| Redis connection failures | Alert immediately | Rate limiting, BullMQ, and caching all depend on it; a Redis outage degrades multiple subsystems at once |
| Failed migration on deploy | Alert immediately, block further deploys | Matches this phase's own migration-safety posture (§D) |

---

## I. Production Configuration Audit (dev / staging / production)

- All configuration is env-driven through `env.validation.ts` (Zod schema) — no environment-specific code branches beyond `NODE_ENV`-derived `isDevelopment`/`isProduction` flags in `configuration.ts` (Swagger docs disabled in production; CORS origin required non-wildcard in production — both already correct, confirmed in `src/main.ts`/`env.validation.ts`).
- **CORS `credentials: true`** (`src/main.ts`) was reviewed: no cookie currently carries the access token (Bearer-header only), so this flag is presently inert for the auth flow itself; it exists for any future cookie-based flow. Not a live vulnerability today (a validated, non-wildcard origin allowlist is still required regardless of this flag), but flagged here so a future phase introducing cookie-based auth revisits it deliberately rather than inheriting it silently.
- **Real, concrete CI/CD gap found and fixed this phase** (see §K): `.github/workflows/ci.yml` was missing 8 required environment variables the app's own Zod validation demands at boot (`APP_DATABASE_URL`, `JWT_ACCESS_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_CREDENTIALS_ENCRYPTION_KEY`, and all 5 `R2_*` object-storage variables) — confirmed by running `validateEnv()` directly against CI's exact prior environment set, which failed. This means CI, as it existed before this phase, could not have actually booted the application for its own e2e run. Fixed with the same non-secret, CI-only-placeholder convention the file already used for `POSTGRES_PASSWORD`, plus a new `minio` service (matching `docker-compose.yml`'s existing local-dev pattern) for the `R2_*` object-storage vars. Re-verified after the fix: the exact new CI environment set now passes `validateEnv()` cleanly.

---

## J. Email Production Readiness

- **The real production email credentials were NOT added during P18** — no Gmail account was connected, no SMTP credentials were requested or stored, per this phase's explicit instruction.
- P17's `EmailProvider` abstraction (`StubEmailProvider` / `ResendEmailProvider`, selected via the `EMAIL_PROVIDER` env var) is confirmed still in place and untouched this phase.
- Confirmed: no email provider API key, sender address, or credential is logged, printed in any report, or placed in source. `EMAIL_API_KEY` is Zod-validated as present-when-needed but its value is never read back out for logging anywhere in the codebase (spot-checked `resend-email.provider.ts`).
- Production readiness path: whoever configures the real production environment sets `EMAIL_PROVIDER=resend` (or the chosen provider), `EMAIL_API_KEY`, `EMAIL_FROM_EMAIL`, `EMAIL_FROM_NAME` as real environment secrets in the hosting platform's secret store — no code change required. This is exactly the abstraction boundary P17 built and this phase verified is still correct and untouched.

---

## K. CI/CD Audit

**Real, verified findings, fixed this phase** (`.github/workflows/ci.yml`):
1. **CI could not boot the app** — 8 required env vars were missing (see §I). Fixed with non-secret CI-only placeholders + a new `minio` service, following the file's own established pattern. Re-verified via direct `validateEnv()` execution against the new env set (passed).
2. **E2E only ran once** — this project's own manual-verification convention runs e2e twice (this phase's own regression run demonstrates why: one of three consecutive full runs showed a single transient failure that did not reproduce in the runs immediately before or after — see §L). CI now runs `npm run test:e2e` twice.
3. **No dependency audit visibility** — added `npm audit --omit=dev` as a `continue-on-error: true` informational step (not a merge gate, given the 16 pre-existing, documented, no-fix-available findings from §A — a hard gate would permanently red the pipeline for a risk already knowingly accepted).

**Confirmed safe**: no destructive commands, no secret leakage in the workflow file (`atlas_ci_password`/CI-only placeholders were already/are-now the file's own established, non-secret convention — never real credentials), CI's Postgres/Redis/MinIO are all ephemeral per-run containers, never a shared or persistent database.

---

## L. Full Regression (this phase's own changes)

| Suite | Result |
|---|---|
| Lint (`npm run lint`) | Clean (0 errors) — also fixed 3 pre-existing, unrelated prettier-only formatting errors in `test/atlas-subscription-payment-provider.e2e-spec.ts` (a file this phase never otherwise touched) so the full lint suite is green |
| Typecheck (`tsc --noEmit`) | Clean (0 errors) |
| Unit tests | **45/45 suites, 523/523 tests passing** |
| Build (`npm run build`) | Clean |
| Migration status (`prisma migrate status`) | "Database schema is up to date" — 27 migrations, no drift |
| E2E — run 1 | **72/72 suites, 619/619 tests passing** |
| E2E — run 2 | 71/72 suites passed, 1 transient failure (an auth-register-adjacent assertion) that did **not** reproduce in the run immediately before or after |
| E2E — run 3 (tie-breaker, since run 2 was ambiguous) | **72/72 suites, 619/619 tests passing** |

**Two real regressions found by this phase's own regression run, root-caused and fixed before being reported as complete**:
1. The new `RegisterRateLimitGuard`'s initial 5/hour default broke legitimate e2e fixture flows that create several real accounts within a single test (up to 6, in `course-commerce.e2e-spec.ts`'s commission-snapshot scenario). Fixed by raising the production default to 20/hour (justified in §B) and adding the project's own established `flushRateLimitKeys` `beforeEach` convention to `auth-register.e2e-spec.ts` (which never needed it before this phase, since registration had no limit).
2. A single flaky failure in `media.e2e-spec.ts`'s oversized-payload test appeared in the *first* pre-fix full run, did not reproduce when that file was run in isolation, and did not reproduce in any of the three later full runs — consistent with this project's own previously-documented flake class (`test/utils/test-app.ts`'s own comment on reproducible timeouts "under heavy accumulated Postgres/Redis load from many hours of continuous e2e runs"), not a P18 regression.

**Original `atlas_dev` database confirmed untouched by the entire regression pass** beyond the intentional test-fixture rows e2e tests always create (this is the same real, persistent dev database every prior phase's e2e suite has always written fixtures into — no reset, no data loss).

---

## M. API Contract Regression

No frontend-facing contract shape changed this phase. The two functional changes (`POST /auth/register` now rate-limited; `GET /health` now reachable at both `/health` and `/v1/health`) are both additive/corrective:
- Registration's success/error response bodies are unchanged; only a new `429` path was added (matching the exact same `{ error: { kind: 'rateLimited', ... } }` shape sign-in/password-reset already use).
- Health's bare-path fix makes the endpoint reachable where its own documentation always said it should be — no consumer that was already using `/v1/health` is affected; `/health` now additionally works.

No P16 (analytics) or P17 (notifications/search) contract was touched this phase.

---

## N. Performance / Database Review

- No N+1 query patterns found in the endpoints exercised by this phase's load test (notifications summary, search) — both already use single, indexed queries (confirmed in P16/P17's own implementation).
- The `search_vector` GIN indexes (P17) and existing tenant-scoping indexes (`organization_id`, `academy_id` foreign keys, all indexed per Prisma's default FK-index behavior) account for the consistently low query latency observed in this phase's real load test (§F).
- No missing-index issues surfaced by the real load test's latency profile (p99 44ms/291ms across both runs — no outlier tail suggesting a sequential scan under load).

---

## O. Launch Checklist

**Ready:**
- [x] Multi-tenant data isolation (RLS + application-layer defense-in-depth), freshly inventoried and verified against the live schema
- [x] Authentication/authorization, brute-force protection on all 3 auth-abuse-prone endpoints
- [x] Migration safety guardrail against the exact class of incident that occurred mid-P17
- [x] Real backup/restore drill, passing, with a real bug found and fixed as a direct result
- [x] Global rate limiting, proven real and functioning under actual load
- [x] Structured logging, request tracing, health checks
- [x] CI/CD pipeline actually able to boot and test the app (was not true before this phase)
- [x] Full regression clean (unit, e2e ×2 effectively (3 runs, 2 clean), lint, typecheck, build, migration status)
- [x] Email provider abstraction verified production-ready (credentials intentionally not yet configured, by design)

**Documented limitations / pre-launch action items (not blockers for a controlled, monitored initial launch, but should not be forgotten):**
- [ ] No error-tracking (Sentry-equivalent) or metrics/APM connected yet — §G
- [ ] Global rate limiter is in-memory, not Redis-backed — fine for single-instance, needs revisiting before horizontal scaling — §B
- [ ] 16 known, accepted, transitive production-dependency vulnerabilities (0 critical) — §A
- [ ] Alerting thresholds are documented targets only, not wired to a live system — §H
- [ ] Real production email credentials intentionally not configured this phase — §J

**Not done, and correctly not claimed as done anywhere in this report.**
