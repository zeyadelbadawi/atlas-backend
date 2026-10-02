# Atlas backend — Claude session handover (Theme 1 programme)

Written 30 Sep 2026. **The full handover is in the frontend repo: `zeyadelbadawi/atlas` → `docs/ATLAS-CLAUDE-HANDOVER.md`** (project context, phase status, findings, images, continuation plan). This file records the backend-specific state. Verify every claim against the repository.

## ★★★★★★★ Status update — P1–P8 in production (2 Oct 2026). Read this first.

Full record: frontend `Reports/P1_P8_REMEDIATION_REPORT.md` §G.

- **`main` = `3d00417`:**
  - [atlas-backend#18](https://github.com/zeyadelbadawi/atlas-backend/pull/18) → `336891d`: P1–P8.
  - [atlas-backend#19](https://github.com/zeyadelbadawi/atlas-backend/pull/19): the reviewer's signals keep the exit an attempt ended in.
- **Migrations, deploy run #234 (`apply_migrations=true`):**
  - backup `atlas-20261002T073437Z.sql.gz`;
  - `20261101000000_public_content_library_read` and `20261101000100_quiz_event_fullscreen_unavailable` applied (134 total);
  - backend and Caddy healthy;
  - rollback record backend `b9278250…` + Caddy `bb1da23e…` at that point.
- **Unchanged:** RUM is off (`RUM_ENABLED` unset); `ATLAS_SSR` unset; no data reset.
- **CI:** backend `ci.yml` is still `disabled_manually`; evidence is local (report §B).
- **Next:** RUM enablement (privacy copy plus config) and the follow-ups in report §E (e2e memory retention, P63 test isolation, re-enable CI).

## ★★★★★ Status update — production deployment and closure remediation (1 Oct 2026) — remediation since merged and deployed, see above.

Full record: frontend `Reports/THEME_1_ACADEMY_WEBSITE_PLAN.md` §Z. The sections below this one describe earlier states and are kept as history.

**In production (verified by the Owner's read-only VPS output and the GitHub API):**
- **Gate B:** `zeyadelbadawi/atlas-backend#16` merged; `main` = `3053b3b` (tree = `742071b`).
- **Gate C:** deploy run #231 (`migrate-and-deploy`, `apply_migrations=true`) applied `20261024000000_website_template_provenance` and `20261030000000_public_website_presentation` (132 applied, 0 unfinished). Backups: `atlas-20261001T070325Z.sql.gz` (Gate A) and `atlas-20261001T105333Z.sql.gz` (Gate C). Backend image `atlas-backend@sha256:5f49760b…`.
- **Gate E (frontend, Caddy only):** this backend was not touched. `.last-good` now = backend `5f49760b…` + caddy `cb1d0469…`; the post-Gate-C record is preserved as `.last-good.after-gate-c` (caddy `814cfcc3…`).
- `ATLAS_SSR` unset (off); no `ssr` container.

**Corrections to the sections below:**
- The deploy-script harness has **60** checks, not 48 (`504df08` added `--check-rollback-record`, `742071b` rollback without the registry).
- It runs in `.github/workflows/deploy-script.yml`, not `ci.yml` (`d2c198c`), because `ci.yml` is `disabled_manually`.
- S-1, GEN-1 and J-ENV, listed as open further down, were implemented before Gate B and are on `main`.

**Closure remediation on `claude/practical-wozniak-pjcdhe` — uncommitted, not merged, not deployed:**
- **F-8**, the public contact route (`POST public/websites/:academyId/contact`):
  - `@Throttle` limit of 5 per 10 minutes per client IP;
  - an optional `company` honeypot, which, when filled, is discarded with the same success response;
  - accepted only when the website is published (otherwise 404).
- **F-11:** the public student count counts only active, unblocked students (`countActiveForAcademy`). The admin dashboard count is unchanged. Pre-merge check (OWNER-RUN, read-only): exactly 1 published Academy's public number will drop.
- **F-13:** neutral Theme 1 starter copy in EN/AR. It affects only newly generated websites; stored content is untouched, and a spec bans the old claims.
- Verification: the focused specs pass 58/58; `npx jest` with `ATLAS_FRONTEND_ROOT=/home/user/atlas` gives 160/160 suites and 4217/4217 tests; tsc reports 0 errors; eslint on the changed files is clean.
- No migration, schema, deploy or CI change.

## ★★★★ Status update — H1–H4 remediation (1 Oct 2026)

| Commit | Item |
|---|---|
| `1b0d3e5` | **`deploy/deploy.sh`:**<br>• `.last-good` records `<repo>@sha256:<digest>` resolved from each running container's image, and keeps the previous record if one cannot be resolved (it used to be always empty).<br>• `--rollback` validates, pulls first, re-tags and verifies the running digests.<br>• A full deploy pulls only application services, starts postgres/redis with `--no-recreate`, rolls application services with `--no-deps`, and logs stateful tag drift.<br>• The monitoring SIGHUP reload is fixed for `COMPOSE_PROFILES=ssr,monitoring`.<br>• `ATLAS_DIR` (default `/opt/atlas`) exists for the harness.<br>**`deploy/docker-compose.prod.yml`:** `init: true` on caddy and ssr; ssr `mem_limit`/`memswap_limit` 384m and `NODE_OPTIONS=--max-old-space-size=256`.<br>**`deploy/test/deploy-script.test.sh`:** 48 checks against a throwaway stack and a local registry.<br>**`ci.yml`:** new job `deploy-script`. |

Verified:
- the harness passes 48/48;
- with the old behaviour put back, 16 checks fail;
- `docker compose config` renders `init` and the limits.

Not run in production. Operational note: upgrading postgres or redis is now an explicit operator step. A deploy only logs `NOTE: postgres runs …; postgres:16-alpine now names …`.

## ★★★ Status update — Phase 8 SSR session (1 Oct 2026)

| Commit | Item |
|---|---|
| `73d620a` | `deploy/docker-compose.prod.yml`: `ssr` service (image `atlas-frontend-ssr`, profile `ssr`, no port, no `env_file`, read-only, health check); Caddy gets `ATLAS_SSR` (default `off`). `deploy/deploy.sh`: `ATLAS_SSR=on` in `.env` enables the profile (profiles compose with `monitoring`); `--frontend-only` rolls `ssr` before Caddy; `SSR_IMAGE` in `.last-good` / `--rollback`; renderer health is non-fatal; off → renderer stopped |

Verified:
- `bash -n`;
- the profile helper in isolation;
- `docker compose config` (the `ssr` service appears only with the profile; `ATLAS_SSR` defaults to `off`).

**No backend application code changed**: the renderer uses the existing public website API unchanged. Not run in production. Enabling it is the Owner's step (frontend `Reports/SSR_ARCHITECTURE_ANALYSIS.md` §14). The Themes 2–5 production migration and M-1 remain pending: BLOCKED here, as there is no production access.

## ★★ Status update — Phase 8 decisions session (30 Sep 2026)

| Commit | Item |
|---|---|
| `20cb0bf` | Themes 2–5 retired from selection: `SELECTABLE_WEBSITE_THEME_KEYS` / `RETIRED_WEBSITE_THEME_KEYS`; both DTOs refuse retired keys; provisioning maps a pre-retirement request to Theme 1; `npm run db:retire-website-themes` (gated dry run → `--apply --plan` → `--rollback`) |
| `4b4cbde` | The dry run lists sections Theme 1 hides until they have content |

Verified:
- the migration tool on a copy of the dev database (plan, apply, idempotent re-apply, rollback, content byte-identical);
- unit 156 suites / 4,194 tests (the two cross-repo suites with `ATLAS_FRONTEND_ROOT=/home/user/atlas`);
- e2e provisioning + website 50/50;
- tsc and lint clean.

**Not run in production:** the retirement migration (Owner, gated; frontend `Reports/THEMES_2_5_RETIREMENT.md` §5) and M-1. No migration was added.

## ★ Status update — continuation session (30 Sep 2026)

Since the first handover (branch `claude/practical-wozniak-pjcdhe`, nothing on `main`, no migrations added):

| Commit | Item |
|---|---|
| `f7cb5a5` | S-1 certificate SSRF fixed (`CertificateImageLoader`), S-3 fixed |
| `3ff090e` | GEN-1 generation matrix test |
| `bec84be` | OPS-1 BullMQ connection from the full `REDIS_URL` |
| `9b2d406`, `5dd37f6` | J-ENV: `npm run e2e:prepare-journeys` (local/CI only) |
| `5264331` | Checkout commission resolved in the Organization's tenant context (pre-existing bug found by J5; e2e 10b) |

Verified on the final code: unit 155 suites / 4,186 tests; e2e 166/166 suites (fresh DB, migrate + seed, MinIO); lint 0 errors; format and typecheck clean. Remaining backend item: M-1 (gated production migration, Owner). Full status: frontend `docs/ATLAS-CLAUDE-HANDOVER.md` (★ section) and plan §V.

## Git state at handover

- Branch: `claude/practical-wozniak-pjcdhe` (tracks `origin/claude/practical-wozniak-pjcdhe`). **Continue here; never push to `main`.**
- HEAD before the handover commit: `d81ba0335d36686a9a37cb9044193f1b62f6932d` ("Theme 1 Phase 8: tenant-isolation audit and logo validation").
- Working tree before the handover: clean (no staged, unstaged or untracked files); ahead/behind the remote branch `0 0`.
- `origin/main` = `ba0d0df` = the branch's merge base, so `main` has not moved and there's no divergence. The branch is 8 commits ahead.
- **No implementation work was done in the latest session.** The only new commit is this document.

## Theme 1 commits on this branch

| Commit | Purpose | Phase |
|---|---|---|
| `45dfec9` | Export each theme's generated website as render fixtures (`scripts/export-website-template-fixtures.ts`) | 0 |
| `1824ab3` | Brand engine mirror: derivation + validation (`src/website/brand-engine/`) | 1 |
| `a66c7cc` | Section contracts, public categories, sample stripping, publish `sampleContent`, brand palette persistence | 2 |
| `330480a` | Provenance migration `20261024000000_website_template_provenance` | 2 |
| `7a97646` | MediaAsset paths accepted in image fields; absolute email logos; parity cases | 2 |
| `9ced7f5` | Hostname lookup returns theme + public colours; migration `20261030000000_public_website_presentation` | 6 |
| `c777bb9` | Theme 1 template v2 (`src/website/templates/modern-education.template.ts`) + generation service changes | 7 |
| `d81ba03` | Adversarial tenant-isolation e2e; `IsLogoReference` on `PATCH /academies/:id/branding` | 8 |

## Verified in the previous session on `d81ba03`

- Full e2e: **166/166 suites, 2009/2009 tests** on a fresh DB that was migrated **and seeded** (like CI), with Redis and MinIO.
- Unit: 152 suites / 4151 tests.
- Typecheck, lint and format: clean.
- `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code`: no difference.

## Backend open items (details in the frontend handover §G)

- **S-1 Certificate SSRF: investigated, NOT implemented.**
  - `src/certificates/services/certificate-renderer.service.ts` `fetchImage` fetches any http(s) URL with `redirect: 'follow'` and no address vetting.
  - `src/certificates/services/certificates.service.ts` `absolutePublicMediaUrl` / `publicBaseUrl()` turn own media into a public URL fetched back over HTTP (dev base `http://localhost:3001`).
  - Chosen design:
    1. read own media (`/api/v1/public/media/academies/<uuid>/<uuid>.<ext>`) through `MEDIA_STORAGE_PROVIDER.getObject`;
    2. decode legacy `data:image/*;base64` in-process;
    3. send any other http(s) URL through a vetted fetch reusing `src/domain/utils/outbound-address.util.ts` (`isPublicAddress`, `isIpLiteralHostname`), with the connection pinned via a custom `lookup`, no redirects, a timeout and a byte cap (see `src/domain/services/https-probe.service.ts`).
  - Add tests.
- **S-2 Other outbound fetches:** reviewed and acceptable. Zoom recording downloads use URLs from Zoom's authenticated API (`src/live-sessions/providers/zoom.provider.ts`); the rest are platform-configured or fixed hosts.
- **GEN-1:** add a generation-service matrix test for all 5 themes × {complete, empty}, validating output with `sectionInstanceArraySchema`.
- **J-ENV:** `prisma/seed.ts` creates `web-development-academy` but no website or subdomain, so `GET /public/websites/resolve?hostname=web-development-academy` returns 404. The frontend journeys J1–J6 need it created and published first. **Not prepared.**
- **M-1 Migrations:** the two additive migrations above are pending in production. They must go through `.github/workflows/deploy.yml` with `workflow_dispatch` `apply_migrations=true` **and** approval of the protected `production-migrations` environment. A push that carries a pending migration makes `deploy.sh` abort. Never run them without the Owner's authorisation.
- **OPS-1:** BullMQ's Redis connection drops the URL's DB index and TLS.
- **Test-environment facts:**
  - e2e databases must be migrated **and seeded**: `p63-domain-operations` needs the seeded platform owner, and `plans-catalog` needs the seeded plan catalog.
  - `p64-phase2-security` needs real S3 semantics (MinIO, not s3rver).
  - Backend unit tests need a sibling `/home/user/atlas-front` symlink to the frontend repo for 2 suites.
