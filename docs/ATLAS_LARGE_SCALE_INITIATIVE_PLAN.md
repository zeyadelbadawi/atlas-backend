# Atlas Large-Scale Platform Initiative: Plan

Status: implementation in progress (started 2026-10-03). Branch: `claude/confident-bardeen-s216dw` in both repos.

The investigations for each workstream were done read-only against the code and a local disposable stack. Their findings, with file:line references, are summarized here. This document is the contract between the workstreams. The final report will be written in `docs/ATLAS_LARGE_SCALE_INITIATIVE_FINAL_REPORT.md`.

## 1. Workstreams, root causes, and design

### W1: The cookie banner uses the Academy brand
- **Root cause:** `CookieConsentBanner` and `CookiePreferencesDialog` are mounted in `src/App.tsx` RootRoute. That is outside the per-page `WebsiteThemeScope`, so they inherit Atlas `:root` tokens and the `html.dark` class from the dashboard `ThemeProvider`. The result is the wrong colors, a dark banner for visitors whose OS uses dark mode, and an SSR→hydration flash.
- **Design:**
  - RootRoute skips the banner on Academy hosts.
  - A `PublicWebsiteConsentLayer` inside the public website router wraps the banner and dialog (including the portal container) in the website palette scope. The palette comes from the per-request public website data that SSR already loads.
  - Contrast-safe fallbacks (≥ 4.5:1).
  - Consent logic, cookies and the SSR cache key are unchanged.
  - Only the three `shared/first-visit` theme baselines may change.

### W2: Academy provisioning experience
- Provisioning is already an async, resumable 7-step BullMQ state machine with an idempotency key. The defects are:
  - Branding is applied client-side after provisioning finishes, through `FinishBrandingCard` and `localStorage`. It can be lost on refresh, and it appears as a separate step.
  - The theme step is skipped when no theme card is clicked.
  - Retry is a no-op, because the fixed BullMQ `jobId` of the failed job is retained.
  - There is no stall detection.
  - Two tabs requesting the same subdomain fail in an unclear way.
- **Design:**
  - A validated server-side `requested_brand`, applied by the orchestrator's branding step.
  - A default theme key, and starter pages always generated.
  - Retry removes the failed job before re-adding it.
  - A `lastProgressAt` field with a `stalled` flag.
  - Only real stages are shown, with adaptive polling (about 1s for the first 30s, then 4s), no fake timers or percentages, and a live region for screen readers.
  - A branding failure does not block "ready"; it shows a warning with Retry.

### W3: Email and notifications platform
- **Urgent security finding:**
  - The OTP and account-deletion codes are stored in plaintext in the outbox `values` column for about 90 days.
  - The OTP code is in the email subject line.
  - `auth_email_challenges` are never pruned and keep raw IPs.
  - **Fix:** catalog credential scrubbing, removing the code from the subject, an idempotent scrub migration (no backup, by design), and retention pruning.
- **W3-core:**
  - **Email logos:** served from a public, immutable-cache logo route (PNG/JPEG, CORP cross-origin for that route only, exempt from the throttle). The layout uses an absolute platform-host URL with width, height and alt text, and falls back to the academy name as text.
  - **Platform Owner sidebar:** an "Email & Notifications" section with exactly three pages:
    - Compose and Send.
    - Academy Email Activity: keyset pagination, a partial index `(academy_id, created_at desc, id desc)`, masked emails, error categories instead of raw provider errors, and no bodies or secrets.
    - OTP & Security Monitoring: a `security_events` table with HMAC-hashed email and IP and 90-day retention. Pre-auth events are visible to the Platform Owner only.
- **W3-compose (one shared architecture):**
  - `communication_campaigns` and `campaign_recipients` tables.
  - Keyset set-based expansion in batches of 200.
  - Release into the outbox is quota-aware: the provider's daily cap defers sends instead of burning retries.
  - Client idempotency keys.
  - A server-side sanitizer.
  - List-Unsubscribe and an unsubscribe link for broadcast categories.
  - A confirm step for audiences of 1000 or more.
  - An Academy Owner composer that never silently truncates:
    - preview (no charge);
    - send returns `202`, `422 ACADEMY_EMAIL_QUOTA_EXCEEDED`, or `409` if the recipient count changed since preview.
  - A monthly quota with plan limit `monthlyEmails` (default 50), per academy, by UTC calendar month. A conditional-UPDATE reservation makes it safe under concurrency. Each email outbox row created is charged, and units are released on terminal failure where the provider never accepted the email. In-app notifications and Platform Owner campaigns don't count.

### W4: Uniqueness
- **Today:** only slugs are unique. Learner names are `users.name`, which is global to the account.
- **Duplicate-key handlers:** every existing handler assumes there is only one possible cause. Under FORCE RLS, Postgres leaves out the error detail that names the violated key, so a new unique index would produce wrong error messages, raw 500s, and failed payment application.
- **Design:**
  - An IMMUTABLE `atlas_name_key()` function (Arabic- and accent-aware, ICU lowercasing).
  - STORED generated `name_key` columns on organizations and academies.
  - For learners, `academy_students.name_key`, maintained by triggers, with a `name_unique_exempt` flag. Automatic admissions (auto-join, purchase) are exempt and never fail.
  - SECURITY DEFINER boolean check functions, used for messages and to classify duplicate-key errors.
  - Migrations:
    - M1: the function, columns, triggers and check functions.
    - M2: a gated, backed-up, reversible rename with suffixes like " (2)"; the oldest row keeps its name; ids and slugs never change.
    - M3: guarded unique indexes.
  - The recovery runbook is in `docs/W4_UNIQUENESS_REMEDIATION.md`.

### W5: Academy switching isolation
- **Root causes:**
  - Three sources of truth for the active academy: context/localStorage, `?academyId=`, and the route param.
  - Academy access is modelled at org level only.
  - There is no switch procedure.
  - Mutation callbacks capture the `academyId` at render time.
  - **F12, a backend IDOR:** several academy-scoped endpoints check org membership only, not the caller's academy role.
- **Design:**
  - The guard resolves the caller's `academyRole`, with an `@AcademyRoles` decorator. Every F12 endpoint is fixed.
  - `GET /academies` returns only the academies the caller staffs (org owners see all).
  - New `GET /academies/:id/me`.
  - The URL is the single source of truth, through `AcademyScopeRoute` and `<Outlet key={academyId}/>`.
  - Mutations take `academyId` in their variables, and a query-key registry test enforces scoping.
  - A `useSwitchAcademy` hook: prompts on unsaved changes, cancels in-flight queries, uses push navigation, and guards against responses for the old academy. A switching overlay is bound to real data.
  - A 403/404 for the current academy purges its cache and redirects.

### W6 / W7: Guided course creation and quiz basics
- **W6:**
  - New `GET /courses/:id/publish-readiness`, backed by a shared evaluator. Blocking checks: at least one published activity of any kind, and a price for paid courses. Warnings are returned as well.
  - An optional idempotency key on course create.
  - A wizard route `…/courses/:courseId/setup?step=` with eight steps: Basics, Details, Media, Curriculum, Assessments, Pricing, Review, Publish. Curriculum reuses an extracted `CourseCurriculumEditor`; Assessments reuses an extracted `QuizAuthoringForm`.
  - "Continue setup" for draft courses.
- **W7:**
  - Essentials are shown by default. Everything else is behind an accessible "Advanced options" disclosure, which opens automatically on a validation error or a non-default value.
  - Fixes for the preset vs server default mismatch, client validation gaps, and values that can't be cleared on edit.

### W8: Gifted setup days and durable trial eligibility
- **Gifted days:**
  - Configured per plan and billing cycle: `plans.gifted_days_monthly` and `plans.gifted_days_yearly`, each 5–15 when set. Seeded as 7 and 14 in a separate migration.
  - Given on the first-ever approved paid subscription, once per customer identity. The identity is an HMAC of the normalized owner email, recorded in an append-only `paid_gift_redemptions` table that survives account deletion.
  - The paid period starts when the gift ends.
  - Trialists who convert get the gift, because the gift is distinct from the trial.
- **Trial ledger (`trial_redemptions`):** HMAC v2 hashes with `hash_version`, while v1 hashes are still checked. IP and user agent are cleared after 180 days. Alias collapsing is kept. A dry-run backfill script is provided but not run in production.
- **Billing defects fixed:**
  - D1: a second cancel is a silent no-op.
  - D2: double payment application.
  - D3: month-end overflow.
  - D4: a yearly snapshot is treated as monthly.

## 2. Shared contracts and ownership
- **Migration timestamp ranges** (`20261104000xxx`):
  - W3-core: 000000–099
  - W3-compose: 000100–199
  - W2: 000200–299
  - W4: 000300–399
  - W5: 000400–499
  - W6/W7: 000500–599
  - W8: 000600–699
- **New journeys:** j34 W1, j35 W2, j36 W3-core, j37 W3-compose, j38 W4, j39 W5, j40 W6/W7, j41 W8.
- **Error shape:** `{ messageKey, violations?: [{ field }], details? }` with standard HTTP codes. EN and AR copy for every key.
- **Authorization:**
  - Platform Owner pages: platform role only, enforced server-side.
  - Academy operations: the academy role from W5's guard, plus the service checks. Org owners are implicitly allowed.
  - The academy composer: `owner` and `administrator` only.

## 3. Product decisions (defaults in place, reversible)

| # | Decision | Default implemented |
|---|---|---|
| D-W8-1 | Gifted days per cycle | 7 monthly / 14 yearly (separate seed migration; editable in plan admin, 5–15) |
| D-W8-2 | Gift identity | Normalized owner-email HMAC, across orgs |
| D-W8-3 | Trialists get the gift | Yes |
| D-W8-4 | Refund restores the gift | No |
| D-W8-5 | Backfill trial ledger from pre-ledger trials | Script only, not run in production |
| D-W8-6 | Trial IP/UA retention | 180 days |
| D-W3-1 | Quota scope, value, reset | Per academy, 50/month default, UTC calendar month |
| D-W3-2 | Who may send academy messages | owner, administrator |
| D-W3-3 | Unsubscribe | Broadcast categories carry List-Unsubscribe and a link; transactional emails don't |
| D-W3-4 | Provider capacity (~400/day on the free tier) | Sends are deferred rather than dropped; a provider plan upgrade is recommended |
| D-W3-5 | security_events retention | 90 days |
| D-W3-6 | Academy staff see learner OTP failures | No (Platform Owner only) |
| D-W2-1 | A branding failure blocks "ready" | No (warning + Retry) |
| D-W6-1 | Enforce publish readiness on the server and close the PATCH status bypass | Not yet (Phase 1: endpoint + wizard gate) |
| D-W4-1 | Learner uniqueness model | Model A (per-academy key; automatic admissions exempt) |
| D-W4-2 | Clashing profile rename | Refused |
| D-W4-3 | Academy name scope | Platform-wide, all statuses |
| D-W4-4 | Fold ى/ي, ة/ه, digits | No |
| D-W4-5 | Existing duplicates | Auto-suffix, backed up, reversible; the oldest row keeps its name |

## 4. Delivery sequence
1. Workstream agents implement and test in parallel, in a shared workspace with strict file ownership.
2. Integration: rebuild the local stack, apply all migrations, run full suites in both repos, run all journeys (EN/AR, desktop and 390px, per role), theme baselines, SSR tests.
3. Independent reviews: security (authorization matrix, tenant isolation, secrets), UX/a11y, performance (local only).
4. PRs, then CI green, then merge the backend, then the production migrations (manual approval in the protected `production-migrations` environment), then merge and deploy the frontend, then Release verify plus production read-only checks.
5. Final report (A–J).
