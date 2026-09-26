# Atlas — Current State Snapshot

**As of 26 September 2026.** Operational facts only. Full context:
`ATLAS_PROJECT_HANDOVER.md`. No secrets are recorded here.

---

## Git & deployment

| | Value |
|---|---|
| Frontend `main` | **`8a8dd56`** — working tree clean |
| Backend `main` | **`9826b57`** + the onboarding docs closeout (docs/test only) — working tree clean |
| Frontend deployed | `8a8dd56` — run 36242299025 success |
| Backend deployed | `9826b57` — run 36242294781 success |
| Migrations | 124 (latest `20261017000000_onboarding_completed_at`, applied via the owner-approved gated run 36239402027) |
| Production | `https://atlass.dpdns.org` |
| Production health | `GET /api/v1/public/plans` → **200** |

Both repos are at their deployed SHA; nothing is pending deploy.

---

## Phases

| Phase | Status |
|---|---|
| Roadmap 0–10 | **COMPLETE** |
| Roadmap 11 (business widgets), 12 (final validation) | **NOT STARTED — by instruction** |
| P64 phases 1–3 | **COMPLETE in production** |
| P64 phase 4 | Executed; two blockers open (DL-40) |
| P64 Communications | **CLOSED in production** |
| **Account Deletion & Data Lifecycle** | **ACTIVE — `PARTIAL`** |
| Platform Owner Observability Center | **COMPLETE in production** (26 Sep) |
| **New Customer Onboarding** | **LIVE — flag `on`** (26 Sep). Open: production payment-method catalog is empty (owner data); trial-path production journey needs a never-trialed mailbox (`NEW_CUSTOMER_ONBOARDING.md` §9) |

---

## Active workstream: Account Deletion

`IMPLEMENTED` and production-verified:
- Self-delete freeze fix (fe `2380e51`) — 401-interceptor re-entrant deadlock.
- `DeletionPlanService` + `GET /users/me/deletion-plan` (be `5b79d9f`).
- Platform Owner administrative deletion (be `2965719`, live after hotfix `131ad8d`).
- Nest module-graph regression guard (be `a5ce4ec`).
- Platform Owner deletion UI on the user detail page (fe `933a7d4`).
- Ops script `src/scripts/delete-user.ts` — canonical service, IDs only (be `2304e5b`).
- Production defect fixes from real testing (be `d868382`, fe `4d512f0`): missing
  `confirm: true` on the wire, zero-count plan lines, misleading placeholder, Arabic
  `zero` plural gap.

`DESIGNED — NOT BUILT`:
- **Storage teardown.** Public R2 provider has **no delete method at all**; Stream
  `deleteAsset` is only called by the retention sweep; superseded certificate PDFs are
  orphaned. **"Deleted" for media currently means only a database row changed.**
- Learner deleted-course/academy fallback.
- RLS/e2e deletion tests against real Postgres.

---

## Feature flags (production)

| Flag | State |
|---|---|
| `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` / `_ACADEMY` | `new_device` |
| `FLAG_VIDEO_RETENTION_MODE` | `warn_only` — `on` **not approved** |
| `FLAG_LIFECYCLE_SEQUENCES_MODE` | `off` / `dry_run` |
| `FLAG_QUIZ_ENGINE_V2_MODE`, `FLAG_QUIZ_INTEGRITY_MODE` | `on` |
| `contentProtected`, `videoNormal`, `videoPremium`, `devicesPolicy`, `learnerDashboardV2`, `playerV2`, `certificates` | `off` / allowlist |
| `EMAIL_PROVIDERS` | `brevo` |

Frontend flag system is **inert** and not wired to these. No flag is a security
boundary.

---

## Platform Owner identity (no credentials recorded)

| id | email | State |
|---|---|---|
| `c9a8267c-…` | `zeyadelbadawi.ze@gmail.com` | **Intended Platform Owner.** Exactly one row; `is_platform_owner = true`; active; no organization, membership, academy role or studentship. OTP/new-device sign-in verified (challenge consumed, live `management` session, one trusted device). |
| `511d05bf-…` | `ziadelbadawi@gmail.com` | Platform Owner, signs in, owns an organization. **Preserved deliberately.** |
| `66cce5de-…` | `zeyadelbadawi@gmail.com` | Platform Owner, never signed in, owns nothing. |
| `51808bca-…` | `ziad.elbadawi.zd@gmail.com` | Platform Owner, never used. **Surplus** — needs an authorised removal step. |

---

## Blockers

**Human decision**
- Which surplus Platform Owner accounts to remove. The canonical service **refuses to
  delete a Platform Owner** by design, so this needs an explicit authorised step.
- Roadmap phases 11–12 await instruction.

**Credentials / access**
- Learner-session browser journeys need a person (tokens cannot be injected, passwords
  must not be typed) — DL-37.
- Any OTP verification needs the owner's inbox.

**Technical**
- Media bytes are never deleted (above).
- Cloudflare Stream cannot revoke an issued playback token.
- Archived rows stay in the GIN search index unless queries filter on status.

**Configuration**
- Caddy sets no `Cache-Control` on `index.html`; Cloudflare stamps `max-age=14400` on
  assets, so a tab open before a rollback keeps running the old SPA.

**Verification**
- Rollback and backup-restore are **not rehearsed — UNKNOWN**.

---

## Known test baselines (respect, do not "fix")

- Frontend typecheck: **34 errors** (platform-zoom 23, website 5, platform-add-ons 5,
  tenant 1).
- `AcademyReportsPage.test.tsx` — pre-existing timeout under parallel workers; passes
  in isolation.
- Backend CI cannot run (`pull access denied for minio/minio`). Deploys are not gated
  on CI.

---

## Immediate next actions

1. **Storage teardown** — add `deleteObject` to the public media provider, wire Stream
   deletion into course/academy/media deletion, stop orphaning certificate PDFs. Use
   the retention pipeline's pattern: one queue / one processor, no colons in job ids,
   re-validate at execution time, delete → verify absent → tombstone.
2. Learner deleted-course/academy fallback.
3. RLS/e2e deletion tests against real Postgres.
4. Product surface inventory against real routes.
