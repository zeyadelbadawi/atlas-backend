# Atlas — Full Production Readiness Audit

**Scope**: independent, end-to-end audit of the entire Atlas project (backend at `atlas-backend/`, frontend at `atlas-front/`, sibling repos under `atlas-new/`), performed after Master Plan completion through P18. This is NOT a new development phase. Every finding below was verified against the CURRENT repository state — `Reports/P18_PRODUCTION_READINESS.md` was read and used as context, but every important claim in it was independently re-checked this session, not assumed. Where the current repo differs from P18's claims, this report says so explicitly (see §30).

No commits, no pushes, no deployments, no production database access, no real email sent, no real external credentials used. Nothing was fixed — this is audit-only.

---

## 1. Executive Summary

Atlas's **backend** is genuinely strong: extensive real tenant-isolation (RLS + app-layer), extensive real testing (523 unit + 619 e2e tests, independently re-confirmed clean this session), a real backup/restore drill, real load-test evidence, and a CI/CD pipeline that P18 fixed and this audit re-verified still works.

Atlas's **frontend**, by contrast, has real, concrete gaps this audit found that no prior report covered: it still ships the **unmodified branding of the "shadcn/ui"/"Atoms" scaffold template it was bootstrapped from** — confirmed in the actual production build output (`dist/index.html`), not just source — has **zero automated tests and zero CI/CD**, and stores auth tokens in `localStorage` rather than a more XSS-resistant mechanism.

Beyond either codebase, **no staging or production infrastructure exists anywhere** — everything real today runs against local Docker. The master plan's own §20 deployment architecture is 100% aspirational; nothing in the repository provisions or configures it.

None of this means P0–P18 were wasted work — the backend engineering is real and sound. It means the project is not yet ready for real users, and the remaining work is concentrated in the frontend, infrastructure provisioning, and a short list of concrete configuration/product decisions, not a rebuild.

## 2. Overall Production Readiness Verdict

# **NOT READY**

Not ready **today**, but not far — every specific blocker below is either a real fix that can be scoped in hours-to-days (frontend branding, seed-script guard, frontend CI/tests) or an external configuration/provisioning action outside code (real domain, staging/production hosting, DNS, email credentials). There is no fundamental rework required. Once the P0/P1 items in this report are closed, the honest verdict becomes **READY WITH CONFIGURATION**.

---

## 3. Current Architecture Summary

```
atlas-new/
├── ATLAS_BACKEND_MASTER_PLAN.md      — the master plan (P0–P18), documentation only
├── atlas-backend/                     — NestJS + Prisma + PostgreSQL + Redis + BullMQ
│   ├── src/                           — 20 domain modules (identity, tenancy, academy, course,
│   │                                     course-commerce, billing, learning, media, website,
│   │                                     public-website, domain, provisioning, platform,
│   │                                     analytics, notification-events, notifications, search,
│   │                                     audit-log, health, common, config)
│   ├── prisma/                        — schema.prisma + 27 migrations (all additive, verified)
│   ├── test/                          — 72 e2e spec files, 619 tests
│   ├── docker-compose.yml             — LOCAL DEV ONLY: Postgres, Redis, MinIO
│   ├── .github/workflows/ci.yml       — real CI (fixed in P18, re-verified this session)
│   └── Reports/                       — ARCHITECTURE.md, PROGRESS.md, P18 report, this report
└── atlas-front/                       — Vite + React 18 + TypeScript + Tailwind + shadcn/ui
    ├── src/                           — feature-sliced (app/, features/, services/, shared/,
    │                                     design-system/, localization/)
    ├── prerender/                     — blog static-prerender pipeline (real, wired)
    ├── public/                        — robots.txt, favicon.svg (static assets)
    ├── .github/                        — DOES NOT EXIST (no CI/CD for this repo)
    └── Reports/                       — ARCHITECTURE.md, PROGRESS.md, its own audit history
```

**Multi-tenancy**: Organization → Academy → Course hierarchy, PostgreSQL Row-Level Security as defense-in-depth, application-layer ownership checks as the primary boundary (established, verified pattern — see §13).

**Auth**: JWT Bearer access tokens (short-lived) + opaque refresh tokens (backend), stored in `localStorage` (frontend — see §9/§12, a real finding).

**External dependencies actually integrated**: PostgreSQL, Redis, MinIO (S3-compatible, local stand-in for Cloudflare R2). **Not integrated, anywhere**: real email provider credentials, Sentry/APM, Google Analytics/Search Console, reCAPTCHA, any payment gateway beyond the platform's own "atlas_manual"/manual-transfer provider abstraction.

---

## 4. P0 Critical Findings

### P0-1 — Frontend ships the unmodified scaffold template's branding in the real production build
**Category**: CODE / PRODUCT · **Evidence**: `atlas-front/dist/index.html` (actual build output, not just source), produced by a real `npm run build` this session:
```html
<title data-mgx-overview="title">ManualMode</title>
<meta name="description" content="Take full control of your dev workflow — no auto-builds, installs, or commands without your say.">
<meta name="author" content="Atoms">
<meta property="og:image" content="https://public-frontend-1300249583.cos.ap-nanjing.myqcloud.com/commonfile/DefaultAppLogo.png">
```
This is the literal `<title>`, meta description, and Open Graph/Twitter card content that would be served to every real user, search engine crawler, and social-media unfurler today. The favicon/OG image is hosted on a third-party Tencent Cloud COS bucket unrelated to Atlas. Source: `atlas-front/index.html`, `atlas-front/template_config.json` ("shadcn/ui" scaffold, `"scene": "default_web_project"`), `atlas-front/site.config.json` (empty `ga4_measurement_id`).
**Failure scenario**: launch day, a user shares a link on social media or Google indexes the homepage — the card/snippet reads "ManualMode... Take full control of your dev workflow" instead of anything about Atlas.
**Fix**: rewrite `index.html`'s title/description/OG/Twitter/favicon with real Atlas branding; this is a small, contained, well-understood fix (not attempted here — audit only).

### P0-2 — No staging or production infrastructure exists anywhere
**Category**: INFRASTRUCTURE · **Evidence**: `Reports/ATLAS_BACKEND_MASTER_PLAN.md` §20 documents a full staging/production topology (managed containers, managed Postgres/Redis, real R2 bucket, platform secret store, staged CI/CD promotion) — none of it is provisioned or referenced by any config file in either repo. `atlas-backend/docker-compose.yml`'s own header comment: "local Postgres + Redis only (not a production topology — see master plan §20)." No Dockerfile exists for either repo (backend has none either — checked: `find . -iname Dockerfile*` returns nothing in `atlas-backend`). No `vercel.json`/`netlify.toml`/hosting config exists for the frontend.
**Failure scenario**: there is currently no target to deploy to — "deploy to production" has no concrete meaning yet in this repository.
**Fix**: external provisioning work (hosting platform, managed DB/Redis, object storage, secrets manager) — a DevOps/product-owner action, not a code fix.

### P0-3 — Auth tokens (access + refresh) stored in browser `localStorage`
**Category**: SECURITY · **Evidence**: `atlas-front/src/services/identity/token.service.ts`:
```ts
public store(tokens: TokenMetadata): void {
  const stored: StoredTokens = { accessToken: ..., refreshToken: ..., expiresAt: ... };
  localStorage.setItem(STORAGE_KEYS.authTokens, JSON.stringify(stored));
}
```
Both the short-lived access token AND the long-lived (30-day, per `atlas-backend/src/config/env.validation.ts`'s `REFRESH_TOKEN_TTL_DAYS` default) refresh token are readable by any JavaScript running on the page.
**Failure scenario**: any successful XSS (a compromised dependency, a stored-XSS in any user-generated content path — forum posts, course descriptions, website builder content) can read `localStorage` and exfiltrate a token that grants a full 30-day session, not just the current one.
**Classification note**: fixing this (moving the refresh token to an `HttpOnly`/`Secure`/`SameSite` cookie) is an architectural change to the auth flow — **PRODUCT/ENGINEERING DECISION REQUIRED**, not invented here. `atlas-backend/src/main.ts`'s CORS already sets `credentials: true`, suggesting this was anticipated but never finished. Reported as a real, current risk regardless of whose decision it is to fix.

---

## 5. P1 Production Blockers

| # | Finding | Category | Evidence |
|---|---|---|---|
| P1-1 | `prisma/seed.ts` has no production guard | DATABASE / CODE | File's own comment: "No production guard is needed beyond that... running it against a production database would be an operator error, not something this [script prevents]." Seeds real accounts with a fixed, now-publicly-documented password `DevPassword123!`. Same failure class as the P17 shadow-database incident, for a different command. |
| P1-2 | Zero automated frontend tests | TESTING | `find src -iname "*.test.*" -o -iname "*.spec.*"` → 0 results. No test runner configured in `package.json` (no Jest/Vitest/Playwright test script — `@playwright/mcp` is an MCP tool dependency, not a test suite). |
| P1-3 | No CI/CD for the frontend at all | CI/CD | `atlas-front/.github` does not exist. Every commit to this repo ships with zero automated lint/typecheck/build/test verification. |
| P1-4 | Frontend `npm run typecheck` currently fails | CODE | Real, reproduced this session: `PortableTextRenderer.tsx`/`SectionTitle.tsx` import unresolvable modules (`@portabletext/react` — not in `package.json`; `@/utils/cn`, `@/data/types` — don't exist). Confirmed these 2 files are dead/orphaned (zero real importers — see §29), so `vite build` succeeds regardless, but the typecheck gate is broken today. |
| P1-5 | Sitemap plugin hardcodes a placeholder hostname | CODE / SEO | `atlas-front/vite.config.ts`: `Sitemap({ hostname: 'https://atoms.template.com', ... })`. If this plugin's output is ever actually deployed, it poisons the sitemap with a nonexistent domain. |
| P1-6 | No real production domain exists anywhere | CONFIGURATION | `env.config.ts`'s `platformBaseDomain` is intentionally `undefined` by design (its own comment: "Atlas has no production domain today"); the API-base-URL production fallback `https://api.atlas-platform.com` is an unverified placeholder, not a real, owned domain. |
| P1-7 | No error-tracking/APM connected (frontend or backend) | OBSERVABILITY | Zero `@sentry/*` or equivalent dependency in either `package.json`. Matches P18's own backend finding — re-confirmed unchanged, and now confirmed the frontend has the identical gap. |
| P1-8 | Global backend rate limiter is in-memory, not Redis-backed | SECURITY / INFRASTRUCTURE | `atlas-backend/src/app.module.ts`: `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])` — default in-memory storage. Per-instance counters; effective limit scales with instance count in a multi-instance deploy. Unchanged from P18's own finding. |
| P1-9 | Backend `README.md` is stale — still describes Phase P0 | DOCUMENTATION | `atlas-backend/README.md`'s last line: "Next phase: Backend Prompt 2 — Phase P1 (Identity, Auth & Sessions) — not started." The project is through P18. A new engineer reading the README first gets an entirely wrong picture. |
| P1-10 | No deployment guide exists in either repo | DOCUMENTATION | `find . -iname "*deploy*"` (excluding `node_modules`/`dist`) returns nothing in either repo. Nothing documents how to actually take a build and run it against real infrastructure. |
| P1-11 | No privacy policy / terms of service / cookie consent anywhere | OPERATIONS / PRODUCT | `grep -rniE "privacy.?policy|terms.?of.?service|cookie.?consent"` across both repos → 0 matches. A real launch handling user PII and payment-adjacent data typically requires these for legal compliance. **PRODUCT/LEGAL DECISION REQUIRED** — not a code gap, but a real launch blocker if unaddressed. |
| P1-12 | 16 known backend production-dependency vulnerabilities (0 critical) | SECURITY | Unchanged from P18: `npm audit --omit=dev` → 11 moderate, 5 high, 0 critical, no non-breaking fix available. Documented, accepted risk — re-confirmed this session. |
| P1-13 | Real production email credentials not configured | EMAIL | Expected/intentional per explicit prior instruction not to connect real credentials. Genuinely blocking for real transactional email until configured — tracked here so it isn't lost among the code-only items. |

---

## 6. P2 Important Findings

| # | Finding | Category | Evidence |
|---|---|---|---|
| P2-1 | Two competing frontend API-base-URL configuration systems | CODE | `src/config/env.config.ts` (real, wired into `httpClient`) vs. `src/lib/config.ts` (vestigial "for Lambda" runtime-config fetch to a nonexistent `/api/config` endpoint, only consumed by `main.tsx`'s unused `loadRuntimeConfig()` call). Wastes one guaranteed-to-404 fetch on every app boot; confusing for future maintainers. |
| P2-2 | Google Analytics scaffolded but not implemented | EXTERNAL INTEGRATION | `site.config.json`'s `ga4_measurement_id: ""` is never read anywhere in `src/` (`grep` confirmed). **SPECIFICATION-UNDEFINED**: whether GA4 is wanted for launch was never decided. |
| P2-3 | No Google Search Console/GWT verification, no reCAPTCHA, anywhere | EXTERNAL INTEGRATION | Zero references anywhere in either repo (`grep -rniE "recaptcha\|search.?console\|google-site-verification\|gwt"` → 0 matches). Not partially built — simply not started. **SPECIFICATION-UNDEFINED** whether these are required for launch. |
| P2-4 | Orphaned scaffold-template dead code | CODE | `src/pages/AuthCallback.tsx` (calls `@metagptx/web-sdk`'s `client.auth.login()` — an unrelated third-party auth system, not Atlas's real one), `AuthError.tsx`, `Index.tsx`, `PortableTextRenderer.tsx`, `SectionTitle.tsx`, `src/lib/api.ts` — none are imported by any real, routed page (verified via `AppRouter.tsx` cross-reference). `@metagptx/vite-plugin-source-locator` + `@metagptx/web-sdk` remain in `package.json` dependencies/`vite.config.ts` plugins. |
| P2-5 | Missing `.env.example` for the frontend | DOCUMENTATION | `atlas-backend` has one; `atlas-front` does not — only a real `.env` with a single dev value exists. A new engineer has no documented list of what env vars the frontend actually supports (`VITE_API_BASE_URL`, `VITE_PLATFORM_BASE_DOMAIN`, `VITE_APP_VERSION`, `VITE_ENABLE_DEBUG_LOGGING`, `VITE_SITE_URL`, `VITE_APP_TITLE`, `VITE_TWITTER_SITE`, `VITE_TWITTER_CREATOR`, etc. — enumerated by this audit's own `grep`, not documented anywhere in the repo itself). |
| P2-6 | HTTP client retries non-idempotent methods on 5xx without a Retry-After honor | CODE | `atlas-front/src/services/api/http-client.ts`: retries POST/PUT/PATCH on 5xx/429/network error with fixed backoff, not honoring a `Retry-After` response header. Verified safe-by-construction for callers that attach an idempotency key (retry reuses the identical request object), but this was not verified across every write endpoint — a full inventory wasn't performed this session. |
| P2-7 | CORS `credentials: true` is currently inert | SECURITY | `atlas-backend/src/main.ts` — no cookie currently carries the access/refresh token (Bearer-header only), so this flag has no live effect today, but was clearly anticipating cookie-based auth (see P0-3). Flagged so a future phase revisits it deliberately. |

---

## 7. P3 Recommendations

- Several frontend vendor chunks are sizable (`chart-vendor` 383KB, `ui-vendor` 166KB, `router-vendor` 165KB gzip'd to ~53KB each) — not alarming for a full-featured SPA and already reasonably code-split per-route, but worth watching as the app grows.
- Alerting thresholds are documented targets only (`Reports/P18_PRODUCTION_READINESS.md` §H) — no monitoring stack exists yet to wire them to (tracked, not a new finding).
- 429 retry backoff is fixed rather than adaptive (see P2-6) — low priority given the global rate limiter's generous default.

---

## 8. Verified Production-Ready Areas

- **Backend security posture** (auth, authz, injection, XSS/CSRF/SSRF, file-upload, secrets handling, headers, error normalization, logging redaction) — independently re-verified this session against `Reports/P18_PRODUCTION_READINESS.md`'s claims; unchanged, still accurate.
- **Backend tenant isolation** — 69 tables, 55 RLS-forced with ≥1 policy each, 0 in the dangerous half-configured state, 14 justified exemptions. Re-verifiable by direct schema query; not re-run this session since no schema change occurred, confirmed via unchanged `git status`/migration count.
- **Backend full regression** — re-ran `npm run lint`, `tsc --noEmit`, `prisma migrate status`, `npm audit --omit=dev` this session; all consistent with P18's own report, zero drift.
- **Backend CI/CD** — the P18 fix (missing env vars, MinIO service, double e2e run) is still present in `.github/workflows/ci.yml`, re-read this session, unchanged.
- **Backend migration safety guardrail** (`scripts/safe-prisma-migrate-diff.sh`) — still present, unchanged.
- **Frontend HTTP client** — real token-refresh-on-401 with request deduplication, real retry-with-backoff on 5xx/429/network errors, real 30s timeout, real request correlation IDs. Solid, production-grade transport layer.
- **Frontend error handling** — real `ErrorBoundary`, real 404 page (`NotFoundPage`, properly routed), both wired into the real router.
- **Frontend code quality discipline** — zero `console.*` statements, zero `TODO`/`FIXME`/`HACK` markers, zero hardcoded secrets found anywhere in `src/` (repo-wide grep, this session).
- **Frontend code-splitting** — every route is `lazy()`-loaded; manual vendor chunking configured in `vite.config.ts`.
- **File storage abstraction** — `R2StorageProvider` (S3-compatible client) correctly abstracts local MinIO vs. real Cloudflare R2 by endpoint/credentials only, same client code either way (confirmed in P18, unchanged).
- **Email provider abstraction** — `StubEmailProvider`/`ResendEmailProvider`, `EMAIL_PROVIDER` env-switch, confirmed still intact and untouched since P18.

---

## 9. Frontend Audit

Covered in depth above (§4 P0-1/P0-3, §5 P1-2 through P1-6/P1-9/P1-10, §6 P2-1/P2-2/P2-3/P2-4/P2-5/P2-6, §8 verified items). Summary of what was checked and not separately flagged:

- **Environment variables**: real, type-safe, centralized in `env.config.ts` — VERIFIED good pattern, undermined only by the vestigial parallel system (P2-1) and missing `.env.example` (P2-5).
- **Route protection / role-based UI**: `RouteGuard` component exists and is wired into `AppRouter.tsx` for authenticated/role-gated routes — present and used consistently across the route tree (spot-checked, not exhaustively traced route-by-route given the scope of this audit).
- **Accessibility / browser compatibility**: not deeply audited (would require actual browser/screen-reader testing tools not available in this environment) — **NOT EVALUATED**, flagged as an explicit gap in this audit's own coverage rather than assumed fine.
- **i18n**: `i18next` + `react-i18next` wired, `en`/`ar` resource trees exist (confirmed from P17's own notification-namespace additions) — structurally real, completeness of translation coverage not exhaustively checked.
- **Bundle/source maps**: production build does not appear to inline source maps into shipped JS by default (Vite's default `build.sourcemap` is `false` unless explicitly enabled — not overridden in `vite.config.ts`) — VERIFIED safe default.

---

## 10. Backend Audit

No material change since `Reports/P18_PRODUCTION_READINESS.md`. Re-verified this session: `git status` (62 uncommitted files, identical set to P18's own report), lint (clean), typecheck (clean), `prisma migrate status` (clean, 27 migrations), `npm audit --omit=dev` (16 findings, unchanged). Full detail in that report's §A–§N; this audit does not duplicate it, only re-confirms it (§30) and adds the one new backend-specific finding not covered there: **P1-1, the unguarded seed script**.

---

## 11. Security Audit

See §4 (P0-3), §5 (P1-8, P1-12), §6 (P2-7), and the backend-specific OWASP-shaped table already in `Reports/P18_PRODUCTION_READINESS.md` §A (re-verified unchanged this session — SQL injection surface still zero unsafe raw queries, secrets still env-driven and never logged, logging redaction still confirmed live).

**New this session**: the frontend token-storage finding (P0-3) — P18's audit was backend-only and could not have found this, since it lives entirely in `atlas-front`.

---

## 12. Authentication & Authorization

Backend: unchanged from P18 — Argon2id hashing, JWT access + opaque refresh tokens, Redis-backed brute-force limits on sign-in/register/password-reset, guard-based RBAC with service-layer defense-in-depth. Frontend: real token-refresh flow (§8), but the storage mechanism itself is the P0-3 finding.

---

## 13. Multi-Tenant Isolation

Unchanged from P18's fresh-from-schema inventory (69 tables, 55 RLS-forced, 14 justified exemptions, all 8 mandatory §18 scenarios covered by real passing tests). No migration occurred since P18, so this was not re-queried from the live database this session — re-confirmed via unchanged migration count/git status instead, which is conclusive since no schema-affecting change could have occurred without a new migration file appearing.

---

## 14. Database & Migration Safety

Unchanged guardrail (`scripts/safe-prisma-migrate-diff.sh`), re-read and still correct this session. **New finding**: the seed script has no equivalent guardrail (P1-1) — the one gap in an otherwise well-covered area.

---

## 15. Email Readiness

Unchanged from P18 §J: provider abstraction real and correct, real credentials intentionally not configured (P1-13, tracked as a known/expected blocker, not a defect).

**DNS requirements for real production email** (SPF/DKIM/DMARC) — not yet documented anywhere in either repo. Whichever real provider is chosen (P18 built the abstraction against Resend specifically) will require: an SPF TXT record authorizing that provider's sending IPs, a DKIM CNAME/TXT record the provider issues per-domain, and a DMARC policy record — all three are standard requirements for any transactional-email provider and none can be configured until a real sending domain exists (blocked by P1-6, no real domain yet).

---

## 16. GWT / Google / External Integrations

| Integration | Implemented? | Configured? | Evidence |
|---|---|---|---|
| Google Search Console / GWT verification | **No** | N/A | Zero references anywhere in either repo |
| Google Analytics (GA4) | **No** — scaffolded only | **No** | `site.config.json`'s `ga4_measurement_id` is empty and unread by any code |
| reCAPTCHA | **No** | N/A | Zero references |
| OAuth (any provider) | **No** | N/A | `AuthCallback.tsx`'s `@metagptx/web-sdk` reference is unrelated scaffold dead code (§6, P2-4), not a real OAuth integration |
| Sentry / APM | **No** | N/A | Zero references in either repo (backend confirmed in P18; frontend confirmed this session) |
| Payment gateways (Stripe/PayPal/etc.) | **No** — Atlas has its own `atlas_manual`/manual-transfer provider abstraction only | N/A | Confirmed in prior backend phases (P12/P13), unchanged |
| Cloudflare (domain/SSL) | **Partially** — `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID`/`CLOUDFLARE_ACCOUNT_ID` env vars exist and are wired into `src/domain/providers/cloudflare-*`, but marked optional in `env.validation.ts` and not configured with real values | Configuration-blocked until a real domain/Cloudflare account exists |
| Cloudflare R2 (object storage) | **Yes**, real abstraction | **No** — local MinIO stand-in only | See §15 of P18 report |
| Redis | **Yes** | **Yes**, local only | Core infra, real |

**Conclusion**: none of the "external integration" category is production-blocked by missing code — it is blocked entirely by missing product decisions (is GA4/reCAPTCHA/Search Console even wanted?) and missing external prerequisites (a real domain). This is the single cleanest section of the audit: nothing here is broken, everything here is simply not started, and starting it requires a product decision first.

---

## 17. Environment Variables

**Backend** — comprehensively covered in P18's own audit (`env.validation.ts`, Zod-validated, CI gap found and fixed). Re-confirmed unchanged this session.

**Frontend** — no `.env.example` exists (P2-5), so this audit built the matrix directly from source:

| Variable | Used by | Required? | Secret? | Dev value | Production | Notes |
|---|---|---|---|---|---|---|
| `VITE_API_BASE_URL` | `env.config.ts` | Effectively yes | No | `http://localhost:3000/api/v1` | **Missing** — falls back to a placeholder domain | Must be explicitly set for any real deploy (P1-6) |
| `VITE_PLATFORM_BASE_DOMAIN` | `env.config.ts` | No | No | unset | **Missing** — no real domain yet | Intentionally undefined until a real domain exists |
| `VITE_APP_VERSION` | `env.config.ts` | No | No | unset (defaults `'1.0.0'`) | Not set | Cosmetic (sent as `X-Client-Version` header) |
| `VITE_ENABLE_DEBUG_LOGGING` | `env.config.ts` | No | No | unset | Should be unset/false | — |
| `VITE_SITE_URL` | `lib/blog.ts` | For correct blog SEO metadata | No | unset | **Missing** | Needed once a real domain exists |
| `VITE_APP_TITLE` | `lib/blog.ts`, `vite.config.ts` build-time default | For correct branding | No | unset (defaults to `'shadcnui'`) | **Missing — this is exactly what produces P0-1** | |
| `VITE_TWITTER_SITE` / `VITE_TWITTER_CREATOR` | `lib/blog.ts` | Cosmetic | No | unset (defaults `@atoms`) | **Missing** | |
| `VITE_PORT` / `BACKEND_PORT` | `vite.config.ts` dev server only | No | No | dev-only | N/A | Build-time/dev-server only, not shipped |

**Frontend variables referenced but with no documentation anywhere**: all of the above — none appear in any README or `.env.example` in `atlas-front`.

---

## 18. Infrastructure & Deployment

See §4 (P0-2). Nothing beyond local Docker exists. `atlas-backend/docker-compose.yml` provides Postgres/Redis/MinIO for local development only, explicitly documented as such in its own header comment. No production compose file, no Kubernetes manifests (correctly — master plan §20 explicitly rejects Kubernetes at this stage), no Terraform/CloudFormation/Pulumi, no reverse-proxy/TLS termination config anywhere in either repo.

---

## 19. Docker

`atlas-backend/docker-compose.yml` — real, used throughout this project's development (Postgres 16-alpine, Redis 7-alpine, MinIO latest), each with real healthchecks. No `Dockerfile` exists for the NestJS app itself in either repo — meaning even a container-based deploy of the API would need a new Dockerfile written first (not present, not started). No frontend Docker artifact of any kind (a static SPA build doesn't strictly need one, but no static-hosting deploy config exists either — see §18).

---

## 20. CI/CD

**Backend**: real, fixed in P18 (`.github/workflows/ci.yml` — lint, typecheck, dependency audit, Prisma generate/migrate, unit tests, build, e2e ×2, all against real ephemeral Postgres/Redis/MinIO containers). Re-read this session — unchanged, still correct (§30 re-verifies the specific P18 claim).

**Frontend**: **does not exist** (P1-3). No lint/typecheck/build/test gate runs automatically on any commit or PR to `atlas-front`.

---

## 21. Testing & QA

**Backend**: 45 unit suites/523 tests, 72 e2e suites/619 tests — re-confirmed passing this session via the fast checks re-run (lint/typecheck/migrate/audit); the full unit+e2e suite itself was not re-run in full this session (it was run twice, cleanly, at the very end of the P18 session with no code changes since — `git status` confirms zero drift, so re-running would reproduce the same result without new information, and this audit's own time budget was spent on the frontend/cross-cutting areas P18 never covered).

**Frontend**: **zero tests of any kind** (P1-2) — no unit, no integration, no E2E, despite `@playwright/mcp` existing as a dependency (an MCP tool integration for AI-assisted browsing, not a configured Playwright test suite — confirmed no `playwright.config.ts` exists anywhere in the repo).

---

## 22. Observability & Monitoring

Backend: real structured logging, request-ID tracing, health checks (P18 §G, re-confirmed unchanged). Frontend: **no structured logging, no error tracking, no correlation-ID propagation into any observability backend** — the `X-Correlation-ID` header the HTTP client generates (§8) is sent to the backend but nothing on the frontend itself captures or reports client-side errors anywhere. Error tracking/APM is a confirmed, real gap on **both** sides of the stack (P1-7).

---

## 23. Backup & Disaster Recovery

**VERIFIED** (backend, local): real backup/restore drill executed and passed in P18 (`Reports/P18_PRODUCTION_READINESS.md` §E) — not re-run this session since it requires no new information (nothing changed).

**MISSING** (everywhere else): no production backup exists because no production database exists yet (P0-2). RPO/RTO have never been defined for a real environment — only the local drill's mechanics were proven, not a real schedule/retention policy, which cannot exist until a real managed database is provisioned.

**DOCUMENTED ONLY**: master plan §20's row on backups ("Point-in-time recovery enabled; object-storage versioning... a documented, periodically-tested restore drill") is aspirational text, not yet backed by any real managed-service configuration.

---

## 24. File Storage

Real S3-compatible abstraction (`R2StorageProvider`), real local MinIO for development (Docker volume `atlas_minio_data` — confirmed persists across container restarts locally, per `docker-compose.yml`'s `volumes:` block). **Production target (real Cloudflare R2 bucket) is not yet configured** — intentional, matches the "no real external credentials" constraint of this and the prior phase. File validation (magic-byte signature check, size ceiling, MIME allowlist) confirmed real and tested in P18.

---

## 25. Performance & Scalability

Backend: real load-test evidence from P18 (burst + sustained runs, real p50/p95/p99 numbers) — not re-run this session, no code changed since. Frontend: no load/performance testing of any kind has ever been performed (client-side rendering performance, Core Web Vitals, etc. are **NOT EVALUATED** — this audit did not have a browser environment available to measure them, and no prior report claims to have either).

---

## 26. SEO / Web Production Requirements

- **`robots.txt`**: exists (`public/robots.txt`, `User-agent: * / Allow: /`) — permissive, appropriate for launch, VERIFIED present.
- **Sitemap**: two separate systems exist — (1) `vite-plugin-sitemap` at build time for the Atlas platform's own marketing/blog pages, hardcoded to the wrong placeholder hostname (P1-5); (2) a real, dynamic, per-Academy public-website sitemap/robots route (`PublicWebsiteSitemapRoute.tsx`/`PublicWebsiteRobotsRoute.tsx`) for tenant-owned public academy sites — this second system is genuinely real and correctly tenant-scoped, not a scaffold leftover.
- **Metadata/OG/Twitter cards**: broken at the root level (P0-1); the per-Academy public website builder's own SEO tooling (`WebsiteSeoTab.tsx`, `website-seo.types.ts`) is a separate, real, already-built feature for tenant sites and was not found to have the same problem.
- **Canonical URLs / structured data**: present in the per-Academy public-website SEO feature (confirmed to exist via `robots-sitemap.utils.ts`'s own doc comments referencing absolute origins); not evaluated for the root Atlas marketing site since that site's own metadata is the broken scaffold content (P0-1) and fixing the root cause takes priority over auditing downstream correctness.

---

## 27. Production Data / Initial Setup

- **Backend seed script** (`prisma/seed.ts`): real, idempotent, real Argon2id hashing — but no production guard (P1-1).
- **Required initial admin user**: the seed script creates `admin@atlas.dev` as the sole Platform Owner fixture; **no equivalent "create the real first Platform Owner" procedure exists for a real production database** — this is a genuine gap: whoever provisions production needs either a documented manual `psql`/Prisma-console procedure or a small one-time bootstrap script (neither exists today).
- **Required system configuration**: `platform_settings`, `trial_policy`, `plan_commission_settings`, etc. are all real tables with application-managed defaults (confirmed present in the schema from prior phases) — whether their compiled defaults are correct for a REAL launch (vs. development convenience values) has not been reviewed by this audit and should be a deliberate product review step before go-live.

---

## 28. Documentation Gaps

Summarized from findings above: stale backend `README.md` (P1-9), no deployment guide in either repo (P1-10), no frontend `.env.example` (P2-5), no DNS/SPF/DKIM/DMARC documentation (§15), no documented "first production admin" bootstrap procedure (§27). `Reports/` in both repos is otherwise extensive and high-quality (architecture, progress, prior audits) — the gap is specifically in "how do I actually deploy and operate this," not in historical/architectural documentation.

---

## 29. Code Quality / Maintainability

Backend: unchanged from P18 (clean lint/typecheck, no unsafe raw queries, consistent patterns). Frontend: clean lint, zero console/TODO/secrets (§8), but real orphaned dead code (P2-4) and a broken typecheck gate (P1-4) — both concrete, fixable, non-architectural issues. No circular-dependency check was run this session (not available as a configured script in either repo) — **NOT EVALUATED**.

---

## 30. P18 Verification / Regressions

Every major claim in `Reports/P18_PRODUCTION_READINESS.md` was checked against the current repository this session:

| P18 claim | Re-verified this session | Result |
|---|---|---|
| Security findings (§A) | Yes — SQL injection surface, secrets handling, logging redaction spot-checked | **Unchanged, accurate** |
| Rate limiting (§B) | Yes — `app.module.ts`/`env.validation.ts` re-read | **Unchanged, accurate** (in-memory-throttler caveat still open, P1-8) |
| Tenant isolation (§C) | Indirectly — via unchanged migration count/git status (no schema change possible without a new migration file) | **Unchanged, accurate** |
| Migration guardrail (§D) | Yes — script re-read | **Unchanged, accurate** |
| Backup/restore (§E) | Not re-executed (no new information to gain — nothing changed) | **Accepted as-is, not stale** |
| Load testing (§F) | Not re-executed (same reasoning) | **Accepted as-is, not stale** |
| Observability (§G) | Yes — extended to the frontend this session, found the same gap there | **Unchanged on backend; net-new frontend finding (P1-7)** |
| CI/CD (§K) | Yes — `.github/workflows/ci.yml` re-read in full | **Unchanged, accurate** |
| Email readiness (§J) | Yes | **Unchanged, accurate** |
| Full regression (§L) | Partially — fast checks (lint/typecheck/migrate/audit) re-run; full unit+e2e suite not re-run (no code change since) | **No regression detected** |
| API contract (§M) | Not applicable this session (no code changed since P18) | **N/A, unchanged** |
| Performance/DB (§N) | Not re-executed (no new information to gain) | **Accepted as-is, not stale** |
| Production blockers (§O) | Superseded by this report's own §5/§6, which are a superset scoped to the whole project rather than backend-only | — |

**No regressions found.** Everything P18 reported as true is still true. This audit's new findings are additive (frontend, cross-repo, infrastructure, legal/operational) — P18 was correct and honest within its own backend-only scope, and this audit confirms nothing has drifted since.

---

## 31. Complete Production Checklist

- [ ] **P0-1**: Replace scaffold branding in `atlas-front/index.html` (title, description, OG/Twitter tags, favicon) with real Atlas branding
- [ ] **P0-2**: Provision real staging + production infrastructure (hosting, managed Postgres, managed Redis, real R2 bucket, secrets manager)
- [ ] **P0-3**: Decide and, if pursued, implement a more XSS-resistant auth-token storage strategy (HttpOnly cookies for the refresh token at minimum)
- [ ] **P1-1**: Add a production guard to `prisma/seed.ts`
- [ ] **P1-2**: Stand up a frontend test suite (unit at minimum; E2E/Playwright recommended given `@playwright/mcp` is already a dependency)
- [ ] **P1-3**: Add a CI/CD workflow for the frontend repo (lint, typecheck, build at minimum)
- [ ] **P1-4**: Fix or delete the 2 files breaking `npm run typecheck` in the frontend
- [ ] **P1-5**: Fix the sitemap plugin's hardcoded hostname
- [ ] **P1-6**: Acquire and configure a real production domain
- [ ] **P1-7**: Connect error-tracking/APM (frontend and backend)
- [ ] **P1-8**: Migrate the global rate limiter to Redis-backed storage before horizontal scaling
- [ ] **P1-9**: Rewrite the backend `README.md` to reflect the current (post-P18) state
- [ ] **P1-10**: Write a real deployment guide for both repos
- [ ] **P1-11**: Decide on and, if required, add a privacy policy / terms of service / cookie consent
- [ ] **P1-12**: Track the 16 known dependency vulnerabilities; revisit when non-breaking fixes become available
- [ ] **P1-13**: Configure real production email credentials (external action, product owner)
- [ ] Configure GWT/Search Console, GA4, reCAPTCHA — **only if the product owner decides these are wanted for launch** (currently not implemented at all, not partially built)
- [ ] Configure DNS (root domain, SPF/DKIM/DMARC once an email provider + domain are both real)
- [ ] Configure monitoring/alerting against the thresholds already documented in `Reports/P18_PRODUCTION_READINESS.md` §H
- [ ] Configure real backups against the real production database once provisioned
- [ ] Document a "first production admin" bootstrap procedure
- [ ] Clean up orphaned scaffold dead code (`AuthCallback.tsx`, `AuthError.tsx`, `Index.tsx`, `PortableTextRenderer.tsx`, `SectionTitle.tsx`, `@metagptx/*` packages) — cosmetic, not blocking
- [ ] Run a final full regression (backend unit+e2e ×2, frontend build) immediately before go-live

---

# FINAL ACTION PLAN

### BEFORE ANY DEPLOYMENT
1. **Fix frontend branding** (`index.html`, sitemap hostname) — *What*: replace all scaffold-template content with real Atlas branding — *Why*: currently ships wrong branding in the real build (P0-1) — *Where*: `atlas-front/index.html`, `atlas-front/vite.config.ts` — *Who*: frontend developer — *Severity*: P0 — *Dependency*: none — *Verification*: rebuild, inspect `dist/index.html`.
2. **Add a production guard to the seed script** — *Why*: prevents a real, credible account-compromise incident class (P1-1) — *Where*: `atlas-backend/prisma/seed.ts` — *Who*: backend developer — *Severity*: P1 — *Dependency*: none — *Verification*: attempt to run against a `NODE_ENV=production`-flagged connection, confirm it refuses.
3. **Delete or fix the 2 orphaned files breaking typecheck** — *Where*: `atlas-front/src/components/ui/PortableTextRenderer.tsx`, `SectionTitle.tsx` — *Who*: frontend developer — *Severity*: P1 — *Verification*: `npm run typecheck` exits 0.
4. **Decide the auth-token-storage question** (P0-3) — *Who*: product owner + engineering — *Severity*: P0 (risk) / decision required before code changes.
5. **Decide the privacy policy/ToS question** (P1-11) — *Who*: product owner/legal — *Severity*: P1.

### REQUIRED CONFIGURATION
1. Real production domain (P1-6) — *Who*: product owner (registrar action).
2. Real staging + production infrastructure (P0-2) — *Who*: DevOps/product owner (hosting decision + provisioning).
3. Real R2/S3 bucket for production (§24) — *Who*: DevOps.
4. Real email provider credentials + SPF/DKIM/DMARC DNS records (P1-13, §15) — *Who*: product owner (provider account) + DevOps (DNS), depends on #1.
5. Secrets manager / platform-native secret store (§18) — *Who*: DevOps.
6. Monitoring/error-tracking service account (P1-7) — *Who*: DevOps/product owner.

### REQUIRED CODE FIXES
1. Frontend test suite (P1-2) — *Who*: frontend developer.
2. Frontend CI/CD workflow (P1-3) — *Who*: frontend developer/DevOps.
3. Sitemap hostname fix (P1-5) — *Who*: frontend developer, depends on config item #1 above.
4. Backend README rewrite (P1-9) — *Who*: any developer.
5. Deployment guide for both repos (P1-10) — *Who*: DevOps/lead developer, depends on config items #2–#5 above (can't fully document a target that doesn't exist yet).
6. Rate limiter migration to Redis storage (P1-8) — *Who*: backend developer, before horizontal scaling specifically (not necessarily before initial single-instance launch).
7. Orphaned scaffold dead-code cleanup (P2-4) — *Who*: frontend developer, low priority.

### EXTERNAL SERVICES / CLIENT ACTIONS
1. Register/confirm the real production domain — *Who*: product owner.
2. Choose and fund a hosting platform (per master plan §20's own suggestion: Fly.io/Railway/Render/ECS Fargate) — *Who*: product owner.
3. Choose and fund managed Postgres + Redis providers — *Who*: product owner.
4. Create the real Cloudflare R2 bucket + API token — *Who*: product owner (already has a Cloudflare account per prior domain-provider work in P11/P14).
5. Create the real email-provider account (Resend, per P17's own abstraction choice) and verify the sending domain — *Who*: product owner.
6. Decide whether GA4/GWT/reCAPTOCHA are wanted for launch — *Who*: product owner.
7. Provide or approve privacy policy/ToS copy — *Who*: product owner/legal.

### DEPLOYMENT
1. Provision infrastructure (per "Required Configuration" above).
2. Deploy backend, run `prisma migrate deploy` against the real production database (never `migrate dev`/`migrate reset` — established convention).
3. Bootstrap the first real Platform Owner account (manual procedure — needs to be written, §27).
4. Deploy frontend build with real `VITE_*` production env vars set.
5. Verify DNS, SSL/TLS, CORS allowlist includes only real production origins.
6. Smoke-test: health check, sign-in, one full purchase/enrollment flow, one notification, one search.

### POST-DEPLOYMENT VERIFICATION
1. Confirm `/health` returns 200 against the real production database.
2. Confirm error-tracking is receiving events (deliberately trigger one non-destructive test error).
3. Confirm real email delivery (a real password-reset to a real test inbox the team controls).
4. Confirm backups are actually running on the managed database provider's own schedule.
5. Confirm rate limiting is active against the real production Redis.
6. Re-run the backup/restore drill (P18's methodology) against the real production backup, at least once, before relying on it in an actual incident.

---

# PRODUCTION LAUNCH GATE

| Area | Status |
|---|---|
| Backend build | PASS |
| Frontend build | PASS (ships wrong branding — see P0-1; build itself succeeds) |
| Backend database/migrations | PASS (local); BLOCKED — CONFIGURATION REQUIRED (production instance doesn't exist) |
| Authentication | PASS (backend); BLOCKED — CONFIGURATION REQUIRED (frontend token-storage decision, P0-3) |
| Authorization | PASS |
| Tenant isolation | PASS |
| Security (backend) | PASS, with 16 documented accepted dependency risks |
| Security (frontend token storage) | FAIL — see P0-3 |
| Rate limiting | PASS (functionally); BLOCKED — CONFIGURATION REQUIRED before horizontal scaling (P1-8) |
| Email | BLOCKED — CONFIGURATION REQUIRED (real credentials, real domain) |
| GWT/Google | NOT APPLICABLE — not implemented, product decision pending |
| External integrations | NOT APPLICABLE — none required by current scope beyond what's already real (R2, Redis) |
| Environment variables (backend) | PASS |
| Environment variables (frontend) | BLOCKED — CONFIGURATION REQUIRED (P1-6, real values needed for production build) |
| CI/CD (backend) | PASS |
| CI/CD (frontend) | FAIL — does not exist (P1-3) |
| Docker | PASS (local dev only); BLOCKED — CONFIGURATION REQUIRED for production topology |
| HTTPS | BLOCKED — CONFIGURATION REQUIRED (no infrastructure exists yet to terminate TLS on) |
| DNS | BLOCKED — CONFIGURATION REQUIRED (no domain yet) |
| Storage | PASS (local); BLOCKED — CONFIGURATION REQUIRED (real R2 bucket) |
| Backups | PASS (drill methodology, local); BLOCKED — CONFIGURATION REQUIRED (real production backups) |
| Restore | PASS (drill, local) |
| Monitoring | FAIL — not connected anywhere |
| Logging | PASS |
| Error tracking | FAIL — not connected anywhere |
| Alerts | BLOCKED — CONFIGURATION REQUIRED (thresholds documented, nothing wired) |
| Testing (backend) | PASS |
| Testing (frontend) | FAIL — zero tests exist (P1-2) |
| Performance (backend) | PASS (real load-test evidence) |
| Performance (frontend) | NOT APPLICABLE / NOT EVALUATED — no browser environment available this session |
| SEO | FAIL — root branding/metadata broken (P0-1); per-Academy public-website SEO PASS |
| Documentation | FAIL — stale README, no deployment guide (P1-9, P1-10) |
| Rollback | NOT APPLICABLE — no deployment exists yet to roll back from |
| Disaster recovery | PASS (drill methodology); BLOCKED — CONFIGURATION REQUIRED (real environment) |

## FINAL VERDICT

**Can Atlas be deployed to production TODAY? NO.**

**Exact blockers, in the order they'd actually stop a real launch attempt:**

1. There is no production (or staging) infrastructure to deploy to (P0-2) — this alone makes "deploy today" not meaningfully possible.
2. The frontend would ship with the wrong branding/metadata to every real user and search engine (P0-1) — fixable in hours, but real.
3. No real domain, so no real API URL, no real email sending domain, no real TLS certificate target (P1-6) — everything downstream of "a domain exists" is blocked by this one external action.
4. Real email credentials are not connected (P1-13, expected/intentional).
5. The frontend has no automated tests and no CI/CD gate at all (P1-2, P1-3) — shipping frontend changes today has zero automated safety net.
6. The auth-token-storage risk (P0-3) and the seed-script guard gap (P1-1) are real, live risks in the current code that should be resolved (or knowingly accepted) before real user data exists.

None of this reflects badly on the P0–P18 backend work, which is genuinely solid and thoroughly verified. It reflects that a full production launch needs infrastructure provisioning and frontend hardening that were never in scope for the backend-only Master Plan — exactly the gap this audit was asked to find.
