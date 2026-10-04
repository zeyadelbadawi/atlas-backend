# Atlas Large-Scale Platform Initiative: Final Report

**Date:** 4 October 2026
**Plan, contracts and decisions:** [`docs/ATLAS_LARGE_SCALE_INITIATIVE_PLAN.md`](./ATLAS_LARGE_SCALE_INITIATIVE_PLAN.md)
**W4 runbook:** [`docs/W4_UNIQUENESS_REMEDIATION.md`](./W4_UNIQUENESS_REMEDIATION.md)

This report keeps four kinds of claim separate: **implemented**, **passed tests**, **merged**, and **deployed and verified in production**. Each claim says which it is.

---

## A. Executive summary

All eight workstreams are implemented, merged and deployed.

**In production**

| | Backend | Frontend |
|---|---|---|
| Commit | `atlas-backend@7aade00` | `atlas@bbb5ed1` |
| Pull requests | zeyadelbadawi/atlas-backend#28, #29 | zeyadelbadawi/atlas#18, #19 |

**Migrations:** all 19 new migrations (`20261104000000`–`20261104000700`) are applied. The product owner gave the protected `production-migrations` approval.

**Production verification:** the read-only Release verify run 37184560768 on `main` reported **0 failing checks**.

**Not tested in production:** authenticated features. No production account was signed in to, and no production data was created. Those features were verified locally against the integrated stack (section G).

| WS | Problem solved |
|---|---|
| W1 | On Academy sites the cookie banner wore Atlas's teal and the visitor's OS dark mode. It now uses the Academy's palette. |
| W2 | The brand chosen during setup was lost on refresh, a skipped theme step produced no website, Retry did nothing, and the progress page gave no honest picture of what was happening. |
| W3 | There was no Platform Owner email section, no academy composer and no quota. Login and deletion codes sat in plain text for 90 days. Email logos were broken. |
| W4 | Organization, academy and learner names could be duplicated. |
| W5 | Staff of one academy could read another academy's data in the same organization (an IDOR). Switching academies could show the previous academy's data. |
| W6 | Course creation had no guided path from Create to Publish, and nothing checked readiness before publishing. |
| W7 | The quiz form showed every option at once. Several values could not be cleared, and some limits were not validated. |
| W8 | There were no gifted setup days. The trial ledger used a public salt. Billing had four defects (D1–D4). |

## B. Workstream results

### W1: Cookie banner uses the Academy palette (deployed)
- The banner and preferences dialog render once, inside the website palette scope, with their own portal.
- Contrast fallbacks guarantee at least 4.5:1, and the visitor's OS dark mode no longer applies.
- Consent logic, cookies and the SSR cache key are unchanged.
- Three first-visit baselines were re-recorded and reviewed.

### W2: Provisioning (deployed)
- The requested brand is validated on the server; `data:` URIs are refused. The orchestrator applies it.
- A default theme (`modern-education`) is used when none is picked, and starter pages are always generated.
- Retry removes the failed BullMQ job before re-adding it.
- `lastProgressAt` drives a `stalled` flag.
- Two tabs requesting the same subdomain are serialized; the second gets a 409 with the winning request's id.
- The progress page shows only real stages, polls adaptively, and announces changes in a live region.
- A failed branding step no longer blocks `ready`; it shows a warning with Retry.

### W3: Email and notifications (deployed)
- Platform Owner sidebar section **Email & Notifications** with exactly three pages: Compose and Send, Academy Email Activity, OTP & Security Monitoring.
- **Academy Messages composer:**
  - preview, a confirm step and history;
  - idempotent sends;
  - no silent truncation: 422 when the quota is exceeded, 409 when the audience changed since preview.
- **Shared campaign architecture:**
  - keyset expansion in batches of 200;
  - an allowlist sanitizer;
  - signed List-Unsubscribe headers and links;
  - provider-quota deferral instead of burning retries.
- **Monthly email quota:** plan limit `monthlyEmails` (default 50), per academy, by UTC calendar month. Reservation is a conditional UPDATE, and emails that fail terminally are refunded.
- **Logos:** a public logo route serves bounded PNGs with immutable caching and CORP set to cross-origin for that route only. The email layout uses an absolute URL with alt text and falls back to the academy name as text.
- **Security events:** a `security_events` table with HMAC-hashed email and IP and 90-day retention.

### W4: Uniqueness (deployed)
- `atlas_name_key()` normalizes names (Arabic- and accent-aware, ICU).
- Organization and academy names are unique platform-wide.
- Learner names are unique per academy. Automatic admissions are exempt, and deleted accounts are always exempt.
- Every duplicate-key handler now classifies the cause correctly.
- Registration answers the same whether or not a learner name is taken; the clash is surfaced after the email is verified.

### W5: Academy isolation (deployed)
- `AcademyScopeGuard` resolves the caller's academy role on every request, with `@AcademyRoles` tiers.
- The org owner is the implicit owner of every academy in the organization. This is consistent across the guard, service checks and RLS helpers.
- `GET /academies` lists only staffed academies; new `GET /academies/:id/me`.
- The URL is the single source of truth (`<Outlet key={academyId}/>`). Mutations take `academyId` in their variables, and a registry test checks that query keys are scoped.
- Switching prompts on unsaved changes, cancels in-flight queries and handles revoked access.

### W6 / W7: Course wizard and quiz form (deployed)
- An eight-step wizard, with readiness checked on the Review step.
- New `GET publish-readiness`.
- Idempotent course create.
- An accessible Advanced options section in the quiz form. Clearing values now works, and the validation gaps are fixed.

### W8: Gifted days and trial ledger (deployed)
- Gifted days are configured per plan and cycle (5–15). The seed set 7 monthly and 14 yearly on 5 plans.
- The gift is granted once per owner-email identity through the append-only `paid_gift_redemptions` table. The paid period starts when the gift ends.
- The trial ledger moves to HMAC v2, and IP and user agent are cleared after 180 days.
- Defects D1–D4 are fixed.

## C. Root causes (confirmed in code)
- **W1:** the banner was mounted in RootRoute, outside every WebsiteThemeScope.
- **W2:**
  - Branding lived only in the browser.
  - `executeThemeStep` returned early when no theme was picked.
  - A fixed `jobId` combined with `removeOnFail:false` made Retry a no-op.
- **W3:**
  - The catalog had no `credentialValues` for the OTP and deletion-code entries, and the code was in the subject.
  - Retention for challenges was never scheduled.
  - Provider quota exhaustion was treated as a transient error.
- **W4:** Postgres omits the 23505 error detail under FORCE RLS, so every duplicate-key handler assumed a single cause.
- **W5:**
  - The guard admitted any organization member.
  - The active academy had three sources of truth.
  - Mutations captured `academyId` at render time.
- **W8:**
  - D1: a UNIQUE(org, kind) constraint made a second cancel a no-op.
  - D2: payment success was applied without a status check.
  - D3: the month-end calculation used local `setMonth` and overflowed.
  - D4: a NULL `billingCycle` was treated as monthly.

## D. Contracts (additive)
- **New endpoints:**
  - `platform-communications/email-activity[/summary]`
  - `platform-communications/campaigns`
  - `platform-security/summary|events`
  - `academies/:id/messages[/preview|/quota|/:messageId]`
  - `academies/:id/me`
  - `academies/:id/courses/:courseId/publish-readiness`
  - `public/websites/:academyId/logo`
  - `organizations/:id/provisioning-requests/:requestId/brand-logo`
  - the unsubscribe endpoints
- **Error shape:** `{ messageKey, violations?, details? }`, with EN and AR copy for every key.
- **New optional configuration:**
  - `CUSTOMER_IDENTITY_HMAC_KEY` (falls back to an HKDF derivation of the payment credentials key);
  - `PROVISIONING_STALL_SECONDS` (default 120).

## E. Security
An independent review found **no Critical issues**. Every finding was fixed with a regression test:

| Severity | Finding |
|---|---|
| High | Account deletion conflicted with the learner-name index |
| Medium | Learner-name enumeration at registration (confirmed by curl) |
| Medium | O(n²) sanitizer, run once per recipient |
| Low | Logo route throttle and caching |
| Low | Inactive staff were still authorized, in code and in the RLS helpers |
| Low | Unsubscribe throttled per IP instead of per token |

Organization and academy name probes at signup are accepted by design, behind the register rate limiter.

**Also hardened before release:** `EXECUTE` on the new org-owner RLS helper is revoked from `PUBLIC`; only `atlas_app` can call it.

**Verified properties:**
- Every SECURITY DEFINER function pins `search_path` and returns only booleans.
- RLS is forced on every new table (production-verified).
- No sign-in code is stored after dispatch (production-verified).
- Platform-only APIs return 403 to tenants; they answer 401 anonymously in production.

## F. Data and migrations

**Production:**
- 19 migrations are applied, with no unfinished migration rows.
- **W4 rename**, approved by the product owner and gated by the `production-migrations` approval plus a 100-row backstop:
  - 18 organization and 4 academy names were suffixed;
  - the mapping is in `atlas_migration_backups.w4_backup_*`, verified with counts 18 and 4;
  - the recovery SQL is in the runbook;
  - 104 learner rows were exempted; none were renamed.
- **W3 scrub:** removed codes only. No backup was kept, by design.
- **W8 seed:** backed up to `atlas_migration_backups`.

**Production duplicate-name report** (read-only, counts only): 0 duplicate organization or academy groups remain.

## G. Testing evidence (local integrated stack and CI)

| Suite | Result |
|---|---|
| Backend unit | 191 suites, 4466 tests on the full run, plus the follow-up suites |
| Backend e2e, full serial run | 2255/2261 passed. The failures were root-caused and fixed (4 test bugs; 1 product bug, visual-identity rename returning 500). The one remaining local-only failure is the s3rver stand-in. |
| CI (GitHub, all PRs) | Green: lint, typecheck, migrations, unit tests, build, 3 database e2e shards run twice, deploy-script |
| Frontend vitest | 230 files, 2464 tests |
| Frontend build, build:ssr, test:ssr | 68/68 |
| Playwright journeys | 200 passed, 4 skipped (RUM-only). j23 timed out once under load and then passed 3/3. Coverage: EN/AR, desktop/390 px, platform owner, owner, manager, instructor, learner. |
| Theme baselines | 1056/1056. 11 were deliberately re-recorded and reviewed. |

## H. Deployment and production verification
- **Timeline:**
  1. #28 and #18 merged at 03:26 UTC.
  2. The frontend deployed automatically at 03:37.
  3. The backend deployed after the migration approval at 05:50.
- **The window between those deploys:** the new frontend ran against the old backend. Users saw "Page not found" on the new pages and an error on the wizard's first step, reported by the product owner. These cleared when the backend went live.
- **Lesson:** dispatch the backend deploy with migrations first and merge the frontend only after it.
- **Post-release fixes (#29, #19):**
  - A draft academy was refused by the Messages page. Root cause: an `active`-only status gate that also blocked reads.
  - Composer refusals showed a generic error. Root cause: message keys were translated outside the errors namespace.
  - Device ranking ties on `createdAt` allowed a lowered device cap to be exceeded. This caused the first post-merge CI failure.
  - A teardown deadlock in the p62 test.
- **Release verify run 37184560768:** 0 failures. It checked:
  - migrations;
  - health;
  - backend error lines (0 in 30 minutes);
  - outbox scrub;
  - RLS;
  - duplicates;
  - every new API answering 401 anonymously;
  - the logo route returning 404 for an unknown academy;
  - SSR pages in EN and AR;
  - caching;
  - the homepage in Chromium.

## I. Product decisions (as implemented; all reversible)
- **Gifted days:** 7 monthly / 14 yearly; identity is the owner email; trialists get the gift; a refund does not restore it; IP and user agent are kept 180 days.
- **Backfill:** approved by the product owner on 4 Oct 2026 for production, trials from evidence and prior paying customers (`--gifts`), without the inferred auto-trial era. It ships in the image (`dist/scripts/backfill-customer-ledgers.js`) and runs only through the `Customer ledger backfill` workflow (dry-run / verify / apply with a typed confirmation, a pinned key and a verified dump first).
- **Identity key:** `CUSTOMER_IDENTITY_HMAC_KEY` is pinned by `deploy.sh` to the currently derived value (approved 4 Oct 2026), so no hash changes and a later payment-key rotation cannot reset eligibility.
- **Quota:** 50 per academy per UTC month. Owners and administrators can send.
- **Message categories:** academy messages use the engagement category and platform broadcasts use operational.
- **Messaging and academy status:** draft and active academies can send; suspended and archived can only view.
- **Security events:** kept 90 days; Platform Owner only.
- **Provisioning:** a branding failure does not block `ready`.
- **Publish readiness:** not enforced on the server (`PUBLISH_READINESS_ENFORCED=false`).
- **W4:**
  - learner Model A;
  - a clashing profile rename is refused;
  - academy names are unique platform-wide, every status;
  - ى/ي and ة/ه are not folded;
  - existing duplicates are auto-suffixed, with the oldest keeping its name.

## J. Known limitations and follow-ups
- **Approved 4 Oct 2026 (operations, see section I):** pinning `CUSTOMER_IDENTITY_HMAC_KEY` (next deploy) and the trial and gift backfill (the `Customer ledger backfill` workflow; recovery SQL in `deploy/ledger-backfill/remote.sh`).
- **Decisions pending:**
  - an email provider plan (the free tier is about 400 emails a day; sends over the cap are deferred, not dropped);
  - enforcing publish readiness on the server.
- **Legal:** the privacy-policy wording about trial data needs review. Receipt emails don't mention gifted days yet.
- **UX:**
  - the onboarding first-course step still uses the old form;
  - there's no intro-video editor;
  - a logo picked during provisioning is lost if the page reloads before it uploads (the UI says so honestly);
  - org owners with no staff row don't receive staff notifications.
- **Auth:** an interrupted token refresh can sign a user out (a 401 inside the grace window).
- **Test hygiene:** about 13 journeys don't clean up their courses, and `e2e/j23` has an existing lint error.
- **Not reproduced:** the "You do not have access" toast seen during the deploy window did not reproduce on the current code with a platform owner who also owns an organization and a draft academy.
