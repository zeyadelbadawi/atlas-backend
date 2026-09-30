# Atlas backend — Claude session handover (Theme 1 programme)

Written 30 Sep 2026. **The full handover is in the frontend repo: `zeyadelbadawi/atlas` → `docs/ATLAS-CLAUDE-HANDOVER.md`** (project context, phase status, findings, images, continuation plan). This file records the backend-specific state. Verify every claim against the repository.

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
