# Atlas — Full Project & Infrastructure Handover

**Version:** 1.0 · **Date:** 20 September 2026
**Audience:** the next Claude Code session, on a different account, same machine and repositories.

Everything below was verified by inspection on the date above. Where something could
not be verified it says so. **No secret values appear anywhere in this document, and
none should be added to it.**

---

## A. What Atlas is

A multi-tenant SaaS for education businesses. The tenancy chain is
**Organization → Academy → Course → Section → Lesson → Enrollment**.

- **Organization** — the billing tenant. Holds a subscription and a plan. Owns academies.
- **Academy** — the teaching unit. Has its own public website on a subdomain, its own roster and its own courses.
- **Learners** (AD-4) hold **no organization membership**. They are academy *students*, created through the roster, and they authenticate on the **academy surface**.
- **Staff/management** authenticate on the **management surface** at the platform host. The login page says so literally: *"Students sign in on their own academy website, not here."*

Three distinct surfaces, and the separation is a security boundary, not styling:

| Surface | Host | Who |
|---|---|---|
| Management | `atlass.dpdns.org/dashboard`, `/auth/sign-in` | staff, instructors, platform owner |
| Academy (public website) | `<slug>.atlass.dpdns.org` | anonymous visitors, sign-up/sign-in |
| Learner | `<slug>.atlass.dpdns.org/my/*` | enrolled learners |

**Plans (D10).** Six commercial variants — two families (`normal`, `premium`) × three
tiers (`basic`, `growth`, `enterprise`). Family determines video capability class; tier
determines commercial limits. `videoStorageMinutes` is 500 / 2,000 / 5,000 by tier,
**identical across both families** — it is an Atlas entitlement, deliberately
provider-independent.

**Media/video (AD-15).** `securityTier` (what Atlas promises) is kept separate from
`provider` (where the bytes live). Resolution is
plan → entitlement → security tier → provider registry → provider. `premium` is never
hard-wired to a provider class in the authorization layer.

- **Normal tier** → R2 + a Cloudflare Worker gate. Progressive MP4, single rendition, no ABR. **Live and production-verified.**
- **Premium tier** → Cloudflare Stream. Adapter complete and unit-tested; **credentials not configured**, so it refuses rather than silently downgrading.

**Maturity.** Roadmap phases 0–10 complete; P50–P62 shipped; P63 domains shipped;
P64 Phase 1 (identity/RBAC/learner foundation) and **Phase 2 (protected content, two
video tiers, devices) are complete, deployed and production-verified.**

---

## B. Local workspace

Root: `/Users/ziadelbadawi/Downloads/new/`

| Path | Purpose | Repo | Safe to modify? |
|---|---|---|---|
| `atlas-backend/` | NestJS API, Prisma, migrations, e2e tests, the Worker source | `zeyadelbadawi/atlas-backend` | Yes, via branch + PR |
| `atlas-front/` | React/Vite SPA — all three surfaces | `zeyadelbadawi/atlas` | Yes, via branch + PR |
| `atlas-backend/deploy/` | `deploy.sh`, `backup.sh`, `docker-compose.prod.yml`, `video-gate-worker/` | backend repo | Yes — but deployed separately |
| `atlas-backend/docs/` | Master Plan, investigations, this handover | backend repo | Yes |
| `*.md` at root | Historical phase reports, `ATLAS_PRODUCTION_ROADMAP.md` | **untracked, not in any repo** | Read-only reference |

The Worker is **not** a separate repository. It lives at
`atlas-backend/deploy/video-gate-worker/` and is deployed on its own lifecycle with
Wrangler, never by the API's CI.

`atlas-front/` carries three handover docs (`ATLAS_HANDOVER.md`, `MASTER_HANDOVER.md`,
`NEW_HANDOVER.md`) that are **deliberately excluded from commits** by project
convention. `MASTER_HANDOVER.md` is the authoritative pre-P64 handover — read it.

---

## C. Repositories

| Repository | Local Path | Remote | Branch (local) | HEAD | Purpose |
|---|---|---|---|---|---|
| atlas-backend | `/Users/ziadelbadawi/Downloads/new/atlas-backend` | `github.com/zeyadelbadawi/atlas-backend` | `feat/p64-phase2-lesson-content-authoring` | `cf760a8` | API, DB, migrations, Worker source |
| atlas (frontend) | `/Users/ziadelbadawi/Downloads/new/atlas-front` | `github.com/zeyadelbadawi/atlas` | `feat/p64-phase2-learner-experience` | `2eea2a4` | SPA — management, academy, learner |

**Both local branches are behind their own merge commits.** That is expected: the work
was merged via PR, so `origin/main` is ahead of the feature branch it came from.

| Repo | `origin/main` | Meaning |
|---|---|---|
| backend | **`4632fbf`** | merge of PR #4 (lesson-content authoring) |
| frontend | **`09ba905`** | merge of PR #2 (Phase 2 learner experience) |

Merged PRs relevant to current state: backend **#3** (Phase 2 core, `b934ac3`),
backend **#4** (lesson-content authoring, `4632fbf`), frontend **#2** (`09ba905`).

Working trees are clean except documentation:
backend `docs/ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (the Phase 2 closeout record, plus
this handover); frontend, the three excluded handover docs.

---

## D. Git workflow

```
feature branch → PR → merge to main → GitHub Actions Deploy → VPS
```

- Branch naming: `feat/<phase>-<topic>` (e.g. `feat/p64-phase2-lesson-content-authoring`).
- **Never push directly to `main`.** Always branch + PR.
- Merging to `main` triggers the **Deploy** workflow automatically.
- **Migrations are NOT applied by that automatic deploy.** `deploy.sh` *aborts* when migrations are pending: *"a deploy that carries pending migrations aborts before touching the schema."* A failed deploy after a merge carrying migrations is **expected and harmless** — production is untouched.
- Applying migrations requires `workflow_dispatch` with `apply_migrations=true`, which runs the `migrate-and-deploy` job inside the **`production-migrations`** environment.

### Where human approval is mandatory

`production-migrations` has **`required_reviewers`** — reviewer `zeyadelbadawi`. That
approval is what releases `MIGRATION_SSH_KEY`. **Claude cannot supply it and must not
attempt to route around it.** Stop at the gate and report.

Claude may hit other permission boundaries (`git push`, `gh pr merge` have been denied
by the local permission classifier in past sessions). When that happens: **stop, report
the exact command, and let the human run it.** Do not look for a workaround.

---

## E. Current git state (authoritative snapshot)

| | Local HEAD | Production deployed |
|---|---|---|
| Backend | `cf760a8` (feature branch) | **`4632fbf`** — verified from the deploy image tag `ghcr.io/zeyadelbadawi/atlas-backend:4632fbf60ad1d5c16b581ffdf651cff40dba82d8` |
| Frontend | `2eea2a4` (feature branch) | **`09ba905`** |
| Worker | `deploy/video-gate-worker/` on the backend feature branch | deployed version **`82c8fe7c-3230-41d2-bb2b-dd5960b970d0`** (2026-09-19T23:33Z) |
| Master Plan | `docs/ATLAS_SECURE_LEARNING_MASTER_PLAN.md`, 1199 lines, Phase 2 closeout appended | — |

**Local HEAD ≠ production.** Production runs the *merge commits* on `main`
(`4632fbf` / `09ba905`), not the feature-branch heads.

⚠️ **Known drift:** `deploy/video-gate-worker/wrangler.toml` still contains
`REPLACE_WITH_KV_NAMESPACE_ID` placeholders, while the live Worker uses real namespaces
(see §J). **Committed config does not match what is deployed.** Fixing this is item 1
of the pre-Phase-3 list.

---

## F. The VPS

| | |
|---|---|
| Hostname | `atlas-production` |
| OS / arch | Ubuntu 24.04.4 LTS, **aarch64** (Oracle ARM64) |
| Origin IP | `84.13.157.58` (Oracle) |
| App directory | `/opt/atlas`, mode **750**, owner **`deploy:deploy`** |
| SSH user | `ubuntu` (uid 1001), in group `sudo`, **passwordless sudo** |
| Docker | 29.8.0 · Compose 5.5.1 |

`ubuntu` **cannot read `/opt/atlas` directly** — it is `750 deploy:deploy`. Every
inspection needs `sudo`, and `cd /opt/atlas` fails as `ubuntu`. Use
`sudo sh -c "cd /opt/atlas && …"`, never a bare `cd` followed by `sudo`.

### SSH architecture

```
local machine (SSH agent holds the key)
      │  ssh ubuntu@ssh.atlass.dpdns.org
      ▼
ssh.atlass.dpdns.org  →  84.13.157.58   (DNS-only, NOT proxied)
      ▼
VPS atlas-production  →  sudo  →  /opt/atlas
```

**Why a dedicated SSH hostname exists.** `atlass.dpdns.org` is Cloudflare-**proxied**
(104.21.x / 172.67.x). Cloudflare proxies HTTP(S) only, so port 22 never reaches the
origin — SSH to the web hostname fails with *No route to host*.
`ssh.atlass.dpdns.org` is a **DNS-only (grey-cloud)** record pointing at the origin.

**Never use `atlass.dpdns.org` for SSH.** Never guess other hosts or IPs.

The private key is passphrase-protected and lives in the user's **SSH agent**. Claude
authenticates through `SSH_AUTH_SOCK` — it does not read the key file, and
`BatchMode=yes` is safe because agent auth needs no prompt.

---

## G. Docker topology

```
                Internet
                    │
              Cloudflare (proxied)
                    │
        ┌───────────┴────────────┐
        │                        │
  atlass.dpdns.org        video.atlass.dpdns.org
  *.atlass.dpdns.org      (Worker route — bypasses the VPS entirely)
        │                        │
        ▼                        ▼
   atlas-caddy-1          Cloudflare Worker
   :80 :443                "atlas-video-gate"
        │                        │
        ├── SPA (static)         └── R2 binding → atlas-media-prod-protected
        └── /api/* ──► atlas-backend-1 :3000
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
       atlas-postgres-1 :5432      atlas-redis-1 :6379
```

| Container | Image | Ports | Status | Notes |
|---|---|---|---|---|
| `atlas-caddy-1` | `ghcr.io/…/atlas-frontend:latest` | 80, 443 | healthy | Caddy + SPA in one image; terminates origin TLS, proxies `/api/*` |
| `atlas-backend-1` | `ghcr.io/…/atlas-backend:latest` | 3000 (internal) | healthy | `env_file: .env` |
| `atlas-postgres-1` | `postgres:16-alpine` | 5432 (internal) | healthy | named volume |
| `atlas-redis-1` | `redis:7-alpine` | 6379 (internal) | healthy | named volume |

All `restart: unless-stopped`, all with healthchecks. Backend `depends_on` postgres +
redis **healthy**. Only Caddy publishes ports to the host.

**Note the naming trap:** the frontend container is called **`atlas-caddy-1`**, not
`atlas-frontend-1`.

---

## H. Production configuration (names only — never values)

43 variables in `/opt/atlas/.env`.

| Category | Variables | Secret? |
|---|---|---|
| Database | `DATABASE_URL`, `APP_DATABASE_URL`, `ATLAS_APP_DB_PASSWORD`, `POSTGRES_USER/PASSWORD/DB` | **yes** |
| Redis | `REDIS_URL`, `REDIS_PASSWORD` | **yes** |
| Public R2 | `R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_PUBLIC_URL_BASE`, `R2_FORCE_PATH_STYLE`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | keys **yes** |
| **Protected R2** | `R2_PROTECTED_BUCKET`, `R2_PROTECTED_ACCESS_KEY_ID`, `R2_PROTECTED_SECRET_ACCESS_KEY` | keys **yes** |
| Backups | `R2_BACKUP_BUCKET`, `R2_BACKUP_ENDPOINT`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` | keys **yes** |
| **Video** | `VIDEO_PROVIDER`, `BASIC_VIDEO_DELIVERY_HOST`, `BASIC_VIDEO_SIGNING_SECRET` | signing secret **yes** |
| Cloudflare | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` | token **yes** |
| Auth/session | `JWT_ACCESS_SECRET` | **yes** |
| Payments | `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` | **yes** |
| Email | `EMAIL_PROVIDER` | no |
| Feature flags | `FLAG_VIDEO_NORMAL_MODE` (**currently `off`**) | no |
| Observability | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `LOG_LEVEL` | DSN sensitive |
| Other | `NODE_ENV`, `PORT`, `PLATFORM_BASE_DOMAIN`, `CORS_ALLOWED_ORIGINS`, `MEDIA_MAX_UPLOAD_BYTES`, `ZOOM_WEBHOOK_SECRET_TOKEN` | Zoom token **yes** |

**Absent by design:** `BASIC_VIDEO_REVOCATION_ENDPOINT`, `BASIC_VIDEO_REVOCATION_TOKEN`
(no HTTP receiver exists — §L), `BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED`,
`FLAG_VIDEO_NORMAL_ACADEMY_IDS`, all `FLAG_CONTENT_PROTECTED_*`, all `FLAG_VIDEO_PREMIUM_*`,
all `CLOUDFLARE_STREAM_*`. Unset flags default to **`off`** — an unset variable must
never be why a rollout reaches an un-canaried academy.

> Secrets must not be committed to Git, must not appear in handover files, and must
> **never be pasted into Claude chat**. Ask the human to set them on the VPS instead.

---

## I. The production env file

- `/opt/atlas/.env` — mode **664**, owner **`deploy:deploy`**. Requires `sudo`.
- **Consumption:** `docker-compose.yml` uses `env_file: .env` for backend and caddy. A change requires `docker compose up -d --force-recreate backend`; editing the file alone does nothing.
- **There is no env-sync step in CI.** `deploy.yml` does not push env. The file is maintained manually on the VPS. GitHub repo secrets are only `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `ZOOM_WEBHOOK_SECRET_TOKEN`.
- **Backup convention:** before every edit, `sudo cp -a .env .env.bak.$(date +%Y%m%d-%H%M%S)` then `chmod 600` + `chown root:root`. **8 backups exist.**
- Recently added: the three `R2_PROTECTED_*`, `BASIC_VIDEO_DELIVERY_HOST`, `BASIC_VIDEO_SIGNING_SECRET`, `VIDEO_PROVIDER`.
- **Never print this file.** Verify by *name and presence* only (`grep -qE "^KEY=" && echo present`), or compare hashes.

---

## J. Cloudflare

Account **`dcf34fac74feb35cef2f8fbd59dd1e6e`** — the same id as the R2 S3 endpoint host,
so Workers, R2 and KV all live in one account.

**Zone: `atlass.dpdns.org`** — the apex `dpdns.org` stays on DigitalPlat nameservers;
only this subdomain is delegated to Cloudflare (`ashton`/`ainsley.ns.cloudflare.com`).
A Worker route must therefore name `atlass.dpdns.org`, **not** `dpdns.org`.

| Resource | Value |
|---|---|
| Worker | `atlas-video-gate`, version **`82c8fe7c-3230-41d2-bb2b-dd5960b970d0`** |
| Worker route | `video.atlass.dpdns.org/*` |
| Worker secret | `GATE_SIGNING_SECRET` (name only) |
| KV | `GATE_DENYLIST` = `553a234e0a1142d49cc7e567f649234e` · preview `badb2a58244b40e08d32e44aac396b43` |
| R2 buckets | `atlas-media-production`, `atlas-media-prod-protected`, `atlas-backups-production` |

Deployment is manual: `npx wrangler deploy` from
`atlas-backend/deploy/video-gate-worker/`. **Never by the API's CI.**

---

## K. R2 storage

| Bucket | Purpose | Access | Credentials |
|---|---|---|---|
| `atlas-media-production` | public media — avatars, thumbnails, course images | durable public URL via `R2_PUBLIC_URL_BASE` | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` |
| `atlas-media-prod-protected` | protected lesson media and Normal-tier video | **no durable URL ever**; presigned PUT in, Worker-gated GET out | `R2_PROTECTED_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` |
| `atlas-backups-production` | database backups (`backup.sh`) | private | `R2_BACKUP_*` |

**The two credential pairs are deliberately separate.** The protected token
("Atlas Protected Media") is scoped to `atlas-media-prod-protected` **only**, so a leak
of either credential is contained to its own bucket. `ProtectedMediaStorage` shares the
account's endpoint/region but takes its **credentials** from `protectedMedia`, falling
back to the public pair only when the dedicated pair is unset.

**Do not replace the public credentials with the protected ones** — the protected token
cannot read the public bucket, and doing so takes down all customer media.

Note `R2_BUCKET` is `atlas-media-production`, so the derived default
`${R2_BUCKET}-protected` would be `atlas-media-production-protected` — **wrong**. This
is exactly why `R2_PROTECTED_BUCKET` must be set explicitly.

---

## L. The video Worker

`atlas-backend/deploy/video-gate-worker/` — `wrangler.toml`, `src/index.js` (463 lines),
`src/gate.js` (413), `README.md`. Zero runtime dependencies.

`gate.js` is deliberately runtime-agnostic (Web Crypto only) so the same verifier runs
on Workers *and* Node — one source, two runtimes, no second copy of security-critical code.

**Token format**, fixed by `basic-video.provider.ts`:
```
token  = base64url(JSON.stringify(claims)) + "." + hex(HMAC-SHA256(payload, secret))
claims = { k: objectKey, e: expUnixSeconds, u: userId, s: sessionId, d: deviceId }
URL    = https://{BASIC_VIDEO_DELIVERY_HOST}/v/{objectKey}?t={token}
```

`GATE_SIGNING_SECRET` (Worker) **must equal** `BASIC_VIDEO_SIGNING_SECRET` (API). One
value in two places; a mismatch **does not fail loudly**.

| Setting | Value |
|---|---|
| Methods | GET / HEAD / OPTIONS only — **POST returns 405** |
| `REVOCATION_MODE` | `kv` — denylist key `rev:s:<sessionId>` |
| `DENYLIST_FAIL_MODE` | **`closed`** — unreadable denylist ⇒ refuse |
| `DENYLIST_CACHE_TTL_SECONDS` | `30` (Cloudflare's documented minimum) |
| `ALLOWED_ORIGINS` | empty ⇒ **allow-all**, not lockout |
| Bindings | `VIDEO_BUCKET` → `atlas-media-prod-protected`; `GATE_DENYLIST` → KV |

Serves ranged requests via `head()` then `get()`; 401 without a token, 403 on a bad one,
404 for a non-playback path.

**Tooling:** Wrangler 4.135.0 requires **Node ≥ 22**. The machine's default is v20.20.2;
use `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`. Wrangler is already
authenticated via OAuth.

⚠️ `wrangler.toml` in Git still has KV **placeholders**; the live Worker has the real ids.

---

## M. DNS

| Record | Resolves to | Proxy | Why |
|---|---|---|---|
| `atlass.dpdns.org` | 104.21.42.225 / 172.67.167.34 | **proxied** | platform web host |
| `*.atlass.dpdns.org` | same | **proxied** | wildcard — every academy subdomain |
| `ssh.atlass.dpdns.org` | 84.13.157.58 | **DNS-only** | SSH; Cloudflare proxies HTTP(S) only, so port 22 needs the origin directly |
| `video.atlass.dpdns.org` | same as wildcard | **proxied** | Worker route |

**Why the Worker route works independently of the SPA.** `video.atlass.dpdns.org` is
covered by the wildcard, which normally serves the SPA. A **Worker route takes
precedence over the origin** for matching requests, so the Worker answers first and no
new DNS record was needed. Verified live: `GET /v/none` → **401**, `POST /v/none` →
**405** — the SPA would return 200 HTML for both.

---

## N. CI/CD

`.github/workflows/` — `ci.yml` and `deploy.yml`.

⚠️ **CI is `disabled_manually`.** It does not run on PRs. The frontend repo has **no CI
workflow at all**. There are therefore **no required status checks**; verification is
whatever is run locally. CodeRabbit skips large PRs ("files exceed the limit of 100").

**Deploy** (active) jobs:
1. `build` — builds and pushes the image to GHCR. Holds no SSH identity.
2. `deploy` — runs on **push to main**. Code only. Uses `DEPLOY_SSH_KEY`. **Aborts if migrations are pending.**
3. `migrate-and-deploy` — only on `workflow_dispatch` + `apply_migrations=true`. Environment **`production-migrations`** with `required_reviewers`; approval releases `MIGRATION_SSH_KEY`.

Concurrency group `atlas-vps-deploy` serialises deploys across both repos.

**Phase 2 deployment evidence:** run `35469728785` applied the five Phase 2 migrations
(103 → 108) and reported `Backend healthy.` Run `35477932705` deployed `4632fbf`
("No pending migrations", `Backend healthy.`).

**Rollback:** `deploy.sh --rollback` re-pins images from `/opt/atlas/.last-good`. It
**re-pins images only and never reverts a migration**. `backup.sh` writes to
`atlas-backups-production`. **Restore has never been rehearsed — treat as UNVERIFIED.**

---

## O. Database & migrations

PostgreSQL 16 in `atlas-postgres-1`. Production database **`atlas_production`** (local
dev uses `atlas_dev` — a common trap). Prisma 5.22; migrations in
`prisma/migrations/`.

**108 migrations in the repo; 108 applied in production.** Phase 2 contributed five:

| Migration | What |
|---|---|
| `20261009000000_…protected_content_video_devices` | `lesson_contents`, `lesson_resources`, `content_access_log`, `student_devices`, `access_policies`, `can_access_lesson()`, RLS, **plus a one-time backfill of `lesson_contents`** |
| `…000100_…video_tiers` | `plan_family`, `plan_tier`, `video_security_tier`, `r2_worker` enum value |
| `…000200_…premium_plans` | the three premium plans + add-on compatibility repair |
| `…000300_…media_asset_learner_select` | **SEC-1/SEC-2 fix** — learner-scoped SELECT on `media_assets` |
| `…000400_…disable_jit_for_app_role` | `ALTER ROLE atlas_app SET jit = off` |

### Security posture (verified)

- **74 tables FORCE RLS, 0 enabled-but-not-forced.**
- App role `atlas_app`: **NOBYPASSRLS**, not superuser, `rolconfig={jit=off}`.
- RLS uses `SECURITY DEFINER` functions (`can_access_lesson`, `can_access_media_asset`) — an inline `EXISTS` in a policy evaluates the joined table's own policies per row, the mistake Phase 1 spent two corrective migrations removing.
- `content_access_log` is append-only: **no UPDATE policy**; DELETE restricted to `created_at < now() - 90 days`.
- Never mark RLS functions `LEAKPROOF` — `jit=off` is the correct fix for the planner issue.

### ⚠️ `search_vector` — OUTSIDE PHASE 2

Migration `20260922000000_p44_live_sessions_addon` **drops** the `search_vector` columns
and GIN indexes from `academies`, `courses`, `organizations`, `users`. Only
`20260828120000_p17` ever creates them; **nothing restores them**. Cause: they are raw
SQL, absent from `schema.prisma`, so Prisma's diff proposed dropping them and the
generated DDL was committed with the drop unreviewed — the hazard the `p19` migration's
own header warns about.

`src/search/repositories/search.repository.ts` still queries them, so a database built
from the chain returns **500 on every search** (`42703: column c.search_vector does not
exist`) — 7 e2e tests.

**p44 predates Phase 2 by weeks. Production status is UNKNOWN**: the old dev database
had the columns despite p44, and the repo documents "the long-known raw-SQL
`search_vector` items" in `prisma migrate diff` drift, which implies running databases
carry them out of band. **Needs its own migration and its own PR.** Do not fold it into
Phase 3 work.

---

## P. Redis

`redis:7-alpine`, internal only, password-protected (`REDIS_PASSWORD`, `REDIS_URL`).
Used for: BullMQ queues (subscription sweep, domain verification sweep, P64 Phase 2
maintenance — `p64-phase2-maintenance`, one repeatable job every 10 min), rate limiting
(`ratelimit:*`, `ClientIpThrottlerGuard`), the learner **session lease**, and caches
(e.g. `email:mx:*`). The codebase deliberately uses **one queue with one repeatable job**
and explicitly rejects adding `@nestjs/schedule`.

---

## Q. Caddy / reverse proxy

Caddy ships **inside the frontend image** (`atlas-caddy-1`) — it is not a separate
service. It publishes 80/443, terminates **origin** TLS with a DNS-01 Let's Encrypt
wildcard, serves the SPA, and proxies `/api/*` to `atlas-backend-1:3000`.

Public TLS as seen by browsers is **Cloudflare's edge certificate**; Caddy's is the
origin certificate behind it.

`/health` is **not publicly reachable** — the SPA catch-all answers it, so
`curl https://atlass.dpdns.org/health` returns **HTML, not backend health**. Judge
backend liveness by `401` on a guarded API route instead. (This has misled at least one
session.)

---

## R. Backend architecture

NestJS 10 · Prisma 5.22 · URI versioning (`/api/v1`), global prefix `api`, `health` and
`metrics` excluded.

Key modules: `identity` (auth, 2FA, sessions, devices, account deletion), `tenancy`
(context service, guards, principal resolver), `academy`, `course` (curriculum,
**lesson-content authoring**), `learning` (lesson content/grant, progress, quizzes,
assignments, roster, learner dashboard, sequence), `media` (public + **protected**
storage, `video/` provider registry, webhook), `plans` (entitlements, six-variant
catalog, usage, video tier), `provisioning` (the **only** academy create path),
`website` (CMS), `domain` (P63), `course-commerce`, `billing`, `platform`, `audit-log`,
`observability`, `search`.

**Tenancy context** is the spine: `runInTenantContext` (`app.current_organization_id`),
`runInUserContext` (`app.current_user_id`), `runInTenantAndUserContext`,
`runWithoutContext`. RLS reads these settings — **the guard decides and RLS
independently agrees**; that principle is what caught SEC-1.

No global auth guard. The only `APP_GUARD` is `ClientIpThrottlerGuard` (rate limiting),
so **every controller must opt into `@UseGuards` explicitly**. The video webhook
deliberately has none and authenticates by signature.

---

## S. Frontend architecture

React 18 · Vite 5 · TanStack Query · i18next (EN + **AR RTL**).

| Surface | Route root | Notes |
|---|---|---|
| Management | `/dashboard/*`, `/auth/sign-in` | platform host only |
| Academy (public website) | `/`, `/courses`, `/sign-in`, `/sign-up` | `src/features/public-website/` |
| Learner | `/my/*` | `src/features/learner/` — overview, courses, player, assessments, certificates, **devices**, **security**, profile |

Route constants live in `src/app/routes/route-paths.ts`. Learner sign-in is on the
**academy domain**; the management login explicitly says students do not sign in there.

---

## T. Security architecture

**Tenant isolation** — organization → academy, enforced by guards *and* RLS
independently. Learners hold no org membership (AD-4).

**Learner entitlement — the seven conditions** in `LessonContentService` (identity,
academy context, enrollment, enrollment state, publication/preview, drip schedule,
suspension), all refusing with the **404-by-default** shape so unreachable content is
indistinguishable from non-existent content.

**Devices & sessions** — per-academy device cap (platform default 2) and **one learning
session at a time**; takeover is audited. The lease is taken **last**, so a request that
was going to be refused never steals another device's lease (SEC-3).

**Protected media** — separate bucket, academy/course key prefixing, short presigned
TTLs (capped, not just defaulted), **no durable URL ever** for protected assets.

**Worker gate** — verifies Atlas's HMAC token, enforces expiry, checks the KV denylist,
fails **closed**. It enforces a decision Atlas already made; it never makes one.

**Capability honesty (AD-16)** — the grant reports what is actually enforced. Both tiers
report `boundToSession: false` and `boundToDevice: false` (D-5: Cloudflare mints
`accessRules: any/allow` and ignores custom claims; the Normal gate is cross-site and
sees no Atlas session). `revocableBeforeExpiry` and `originRestricted` are driven by
whether they are **configured**, never assumed.

**Honest limits, do not re-claim otherwise:** a lifted token plays elsewhere until it
expires; revocation is prompt, not instant (KV propagation + cache TTL); never promise
"piracy-proof".

**Audit & rate limiting** — `content_access_log` records grants *and refusals* with tier
and provider; grants are rate-limited per learner.

Feature flags are **not security boundaries**: `content.protected` being off does not
make protected content readable, and the seven conditions run either way.

Decisions D1–D11 and AD-15/AD-16 stand. **Do not change them without an explicit new
owner decision.**

---

## U. Phase 2 final state

**COMPLETE · DEPLOYED · PRODUCTION-VERIFIED.**

| | |
|---|---|
| Backend | `4632fbf` |
| Frontend | `09ba905` |
| Worker | `82c8fe7c-3230-41d2-bb2b-dd5960b970d0` |
| Migrations | **108** (103 → 108) |
| Phase 2 e2e | **138/138** |
| Backend unit | **1238/1238** |
| Typecheck | **0 errors** |
| Full backend e2e (clean DB) | 1290/1299 — the 9 being `search` (7) + two pre-existing flakes |

### Production smoke test (end to end, real deployment)

| Step | Result |
|---|---|
| Create video upload | 201, `tier=normal` |
| PUT → protected R2 | 200 |
| Complete + duration | 201, `ready`, **3s**, **`parsed`** (measured, not declared — D-4) |
| Attach `videoAssetId` | 200 |
| **Grant before authoring** | **404** ← the bug |
| **Author content** | **200** |
| **Grant after authoring** | **200**, host `video.atlass.dpdns.org` |
| **Worker playback** | **200, 2,437 bytes, `video/mp4`**, valid `ftyp` |
| Tampered signature / forged key / expired / no token | **403 / 403 / 403 / 401** |

Also verified: cross-academy asset **404**; learner write **403** with zero rows; public
asset as protected `file` **400**; public R2 unaffected by the credential split.

### The lesson-content authoring fix (PR #4)

`lesson_contents` shipped with a table, RLS, a backfill and a reader — but **no writer**.
Every lesson created after that migration had no content row, so the grant refused at
`if (!lesson.content)`. Attaching `course_lessons.video_asset_id` says which asset a
lesson *plays*; `lesson_contents` is the row the grant *resolves*. Both are required;
only the first had a writer.

`PUT /api/v1/academies/:id/courses/:courseId/sections/:sectionId/lessons/:lessonId/content`
— `video` / `file` / `external`, upsert on the UNIQUE `lessonId`, **no migration needed**.

---

## V. Phase 2 files worth knowing

**Backend — authorization & grant**
- `src/learning/services/lesson-content.service.ts` — **the policy decision point.** Seven conditions, refusal vocabulary, SEC-3 lease ordering. Its `if (!lesson.content)` refusal is *correct* — do not "fix" it.
- `src/course/services/course-curriculum.service.ts` — `upsertLessonContent()` + `videoAssetId` attach, both academy-scoped.
- `src/course/dto/upsert-lesson-content.dto.ts` — why `kind: text` is refused.
- `src/course/repositories/lesson-contents.repository.ts` — upsert on unique `lessonId`.

**Backend — media/video**
- `src/media/video/video-provider.registry.ts` — **the only place** that maps tier → provider.
- `src/media/video/basic-video.provider.ts` — Normal tier; token minting, capability honesty.
- `src/media/video/cloudflare-stream.provider.ts` — Premium.
- `src/media/services/protected-media.service.ts` — upload reservation, completion, quota (AD-14).
- `src/media/storage/protected-media-storage.provider.ts` — the protected/public credential split.
- `src/plans/services/video-tier.service.ts` — answers in **tiers**, names no provider class.

**Config/flags** — `src/config/env.validation.ts` (both-or-none rules, prod CORS refusal), `src/config/configuration.ts`, `src/common/flags/feature-flags.service.ts` ("NONE OF THESE IS A SECURITY BOUNDARY").

**Worker** — `deploy/video-gate-worker/{wrangler.toml,src/index.js,src/gate.js,README.md}`.

**Tests** — `test/p64-phase2-api.e2e-spec.ts` (largest; includes the authoring regression), `-security`, `-rls-tiers`, `-quota`, `-tiers`, `-downgrade`.

**Docs** — `docs/ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (authoritative), `ATLAS_PHASE2_RECONCILIATION.md`, `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md`, `ATLAS_NORMAL_VIDEO_WORKER_SPIKE.md`, this file.

---

## W. Known issues / outside Phase 2

| # | Issue | State | Blocks Phase 3? |
|---|---|---|---|
| 1 | **`search_vector`** — p44 drops columns `search.repository.ts` queries; chain-built DB 500s on every search. Production status **UNKNOWN**. | Open, outside Phase 2 | No — but user-visible if production is affected |
| 2 | **`text` authoring** — refused; no sanitiser exists and one must not be hand-rolled. `bodyHtml` is not on the DTO, so `forbidNonWhitelisted` blocks it. Backfilled text lessons work. | Deferred by decision | No |
| 3 | **Revocation before expiry** — Worker has no HTTP receiver (POST → 405); env vars unset so capability reports **false**. Control today is the 10-min TTL. | Deferred by decision | No |
| 4 | **Premium** — adapter complete; no `CLOUDFLARE_STREAM_*`; refuses rather than downgrading. | Not configured | Only if Premium must be sold |
| 5 | **Staff authoring UI** — API delivered, UI not built. | Open | No |
| 6 | **`wrangler.toml` KV placeholders** vs live namespaces | Drift | No, but fix early |
| 7 | **CI disabled**; frontend has none | Open | Consider before more merges |
| 8 | **`media` / `p53` flakes** — pass in isolation, fail late in long runs. Regex, heap-ceiling and DB-size hypotheses all **disproved**. | Open, mechanism unknown | No |
| 9 | **Dev DB never reset**; full e2e exhausts the default heap ~suite 106/116 | Environment | No |

For #9: reset with `npx prisma migrate reset --force` and run with
`NODE_OPTIONS=--max-old-space-size=8192`. **Never** raise transaction timeouts, sweep
batch sizes or page limits to make accumulation-driven failures green — those are
production safeguards behaving correctly.

---

## X. Production test-data methodology

Disposable academies are created through the **real production API** — never direct SQL:

```
register staff → sign-in → create organization → start trial
→ POST /organizations/:id/provisioning-requests   (the ONLY academy create path)
→ poll until academyId → create course → section → lesson → publish
→ POST /academies/:id/students (roster creates the learner)
→ POST …/students/:userId/enrollments
→ POST /academies/:id/website/publish
```

Gotchas learned the hard way:
- Org creation grants **no trial** — start one or entitlements block provisioning.
- Provisioning requires an `idempotencyKey`.
- Learners must sign in with `surface: 'academy'` + `academyId`; management surface gives **403**.
- The roster endpoint **creates its own user** — pre-registering the same email causes a 409.
- Production rejects disposable domains and requires valid **MX**; `@example.test` fails.

**Cleanup order matters: accounts first, then the academy.** Deleting the academy first
orphans the learner, who can then no longer authenticate to delete themselves. That
mistake happened once and left an orphan account.

**Cannot be deleted:** organization rows. There is no organization-deletion endpoint by
design — *"the organization row is retained: it anchors billing."* Several ownerless
`TEMPORARY …` organizations remain from smoke tests. They are harmless; **do not attempt
raw SQL deletion.**

---

## Y. Runbook (read-only unless marked)

```bash
# Enter the VPS
ssh ubuntu@ssh.atlass.dpdns.org          # agent-backed key; NEVER atlass.dpdns.org

# Containers / health
sudo docker ps --format "{{.Names}} | {{.Status}}"
sudo docker inspect --format='{{.State.Health.Status}}' atlas-backend-1

# Logs
sudo docker logs --tail 100 atlas-backend-1

# Backend liveness from outside (/health returns SPA HTML — use a guarded route)
curl -s -o /dev/null -w "%{http_code}\n" https://atlass.dpdns.org/api/v1/plans   # 401 = healthy

# Production revision
gh run list --workflow=deploy.yml --limit 3
gh run view <id> --log | grep -aoE "atlas-backend:[0-9a-f]{40}"

# Migrations (production)
sudo docker exec atlas-postgres-1 psql -U atlas -d atlas_production -X -t -A \
  -c "SELECT count(*), count(*) FILTER (WHERE finished_at IS NULL) FROM _prisma_migrations;"

# Env — presence only, NEVER print values
sudo grep -qE "^R2_PROTECTED_BUCKET=" /opt/atlas/.env && echo present

# Worker
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # Wrangler needs Node >= 22
cd atlas-backend/deploy/video-gate-worker
npx wrangler deployments list ; npx wrangler secret list ; npx wrangler kv namespace list
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://video.atlass.dpdns.org/v/none  # 405 = Worker live

# Git
git -C atlas-backend fetch -q origin && git -C atlas-backend log --oneline -1 origin/main

# Local tests
npx jest --config jest.config.js                                  # unit
npx jest --config ./test/jest-e2e.json test/p64-phase2-api.e2e-spec.ts
NODE_OPTIONS="--max-old-space-size=8192" npx jest --config ./test/jest-e2e.json   # full
```

### ⚠️ Destructive / state-changing — confirm with the human first

```bash
npx prisma migrate reset --force                                   # DESTROYS the local dev DB
sudo sh -c "cd /opt/atlas && docker compose up -d --force-recreate backend"   # brief prod restart
gh workflow run deploy.yml -f apply_migrations=true                # then STOP at the approval gate
npx wrangler deploy                                                # changes live video delivery
```

Never `cat /opt/atlas/.env`. Never edit it without a timestamped backup first.

---

## Z. Troubleshooting history — do not rediscover these

| Problem | Root cause | Solution | State |
|---|---|---|---|
| SSH "No route to host" | `atlass.dpdns.org` is Cloudflare-proxied; only HTTP(S) is proxied | dedicated **DNS-only** `ssh.atlass.dpdns.org` | Resolved |
| SSH `Permission denied (publickey)` after key install | home dir modes; sshd `StrictModes` | `/home/ubuntu` 755, `.ssh` 700, `authorized_keys` 600 | Resolved |
| Key accepted then "denied"; `we did not send a packet` | key is **passphrase-protected**; `BatchMode` can't prompt | load into the **SSH agent**; use `SSH_AUTH_SOCK` | Resolved |
| Protected R2 upload **500** | protected bucket unreachable with the public token | dedicated `R2_PROTECTED_*` credentials (code fallback preserved) | Resolved |
| `wrangler` refuses to run | Wrangler 4 needs **Node ≥ 22**; default is v20 | nvm `v22.23.2` on PATH | Resolved |
| `routes` silently ignored | placed **after** `[observability]`, so TOML parsed it as `observability.routes` | `routes` must precede any table header | Resolved |
| Worker route vs wildcard SPA | `*.atlass.dpdns.org` serves the SPA | Worker **route** takes precedence over origin; no DNS record needed | Resolved |
| **Grant 404 despite everything correct** | `lesson_contents` had **no writer** | `PUT …/content` (PR #4) | Resolved |
| Backend env change had no effect | edited `.env` without recreating the container | `docker compose up -d --force-recreate backend` | Resolved |
| Restart "succeeded" but didn't run | `cd /opt/atlas` fails as `ubuntu` (750 deploy:deploy) | `sudo sh -c "cd /opt/atlas && …"` | Resolved |
| Orphaned smoke-test learner | academy deleted before the account | **delete accounts first** | Resolved |
| Full e2e dies ~suite 106/116 | one jest worker, default ~4.1 GB heap | `NODE_OPTIONS=--max-old-space-size=8192` | Mitigated |

---

## AA. Boundaries

- Claude Code has repo access but **does not bypass GitHub permission boundaries.** `git push` and `gh pr merge` have been denied by the local permission classifier; when that happens, report the exact command and let the human run it.
- The **`production-migrations`** environment requires a human reviewer. **Stop at the gate.**
- Cloudflare access is account-dependent (currently OAuth-authenticated).
- SSH uses the user's agent; Claude never reads the private key.
- **Secrets stay out of Git, out of handover files, and out of chat.** Do not ask the user to paste them — have them set values on the VPS instead.
- Do not weaken security controls, RLS, entitlement checks, transaction limits or pagination limits to make tests pass.

---

## AB. Phase 3 starting point

**PHASE 2: CLOSED. PHASE 3: NOT STARTED.**

Begin read-only:

1. Read `docs/ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (Phase 2 closeout is at the end).
2. Read this handover.
3. Read `atlas-front/MASTER_HANDOVER.md` for pre-P64 context.
4. Verify git state in both repos (`origin/main` = `4632fbf` / `09ba905`).
5. Verify the production revision from the latest Deploy run.
6. Verify VPS health (four containers healthy).
7. Verify migrations (108 = 108, 0 unfinished).
8. Reconcile documentation vs repository vs production.
9. **Only then** propose Phase 3.

Phase 3 scope is **not defined in this document**. Do not infer it — ask.

---

## AC. Do NOT redo

- Do not redesign Phase 2 or rebuild the Normal video architecture.
- Do not replace the R2 / Worker architecture or reopen provider-tier decisions.
- Do not change **D1–D11** or **AD-15 / AD-16** without an explicit new owner decision.
- Do not recreate verified production infrastructure (Worker, KV, buckets, DNS).
- Do not regenerate or rotate secrets during handover.
- Do not re-run settled investigations unless new evidence contradicts this document.
- Do not "fix" `lesson-content.service.ts`'s `if (!lesson.content)` refusal — it is correct.
- Do not hand-roll an HTML sanitiser.
- Do not fold `search_vector` into Phase 3 — it needs its own PR.
- Do not start Phase 3 during handover.

---

## AD. Machine-readable state

```yaml
ATLAS_HANDOVER_VERSION: 1.0
PROJECT: Atlas
PHASE_2: COMPLETE
PHASE_2_PRODUCTION: VERIFIED
BACKEND_PRODUCTION_SHA: 4632fbf
FRONTEND_PRODUCTION_SHA: 09ba905
BACKEND_LOCAL_HEAD: cf760a8        # feature branch, behind origin/main
FRONTEND_LOCAL_HEAD: 2eea2a4       # feature branch, behind origin/main
WORKER: DEPLOYED version 82c8fe7c-3230-41d2-bb2b-dd5960b970d0 route video.atlass.dpdns.org/*
WORKER_CONFIG_DRIFT: wrangler.toml KV ids are placeholders in Git
DATABASE_MIGRATIONS: 108 applied / 108 in repo / 0 unfinished
PHASE_2_E2E: 138/138
BACKEND_UNIT: 1238/1238
TYPECHECK: 0 ERRORS
NORMAL_VIDEO: PRODUCTION_VERIFIED
PROTECTED_R2: PRODUCTION_VERIFIED
LESSON_CONTENT_AUTHORING: PRODUCTION_VERIFIED
PREMIUM: IMPLEMENTED_NOT_CONFIGURED
TEXT_AUTHORING: DEFERRED_NO_SANITIZER
REVOCATION_BEFORE_EXPIRY: DEFERRED_NO_RECEIVER
SEARCH_VECTOR: OUTSIDE_PHASE_2 production_status_unknown
STAFF_AUTHORING_UI: NOT_BUILT api_only
CI: DISABLED_MANUALLY backend / NONE frontend
FLAG_VIDEO_NORMAL_MODE: off
PHASE_3: NOT_STARTED
NEXT_ACTION: READ_ONLY_PHASE_3_READINESS_RECONCILIATION
```
