# Atlas Platform-Wide UX, Real-Time, Security and Operations Initiative: Final Report

**Date:** 3 October 2026
**Baseline:** frontend `atlas@af83043`, backend `atlas-backend@77e5120`
**Investigation report:** [`docs/ATLAS_PLATFORM_INITIATIVE_INVESTIGATION.md`](./ATLAS_PLATFORM_INITIATIVE_INVESTIGATION.md)

This report keeps four kinds of claim separate: **implemented**, **passed tests**, **merged**, and **deployed and verified in production**. Every claim says which one it is.

---

## A. Executive summary

**What changed.** All nine tasks are implemented. The table gives the user-facing problem behind each one.

| Task | Problem it solves |
|---|---|
| 1 | Owners saw an internal academy status that did nothing, and could take their own site offline through the API. |
| 2 | Verification links were left in the communications outbox for 90 days. Two links could be live at once. The verify page had one vague failure state, and users could not resend from it. |
| 3 | About 70% of audit actions read "made a change". The academy activity feed was always empty. Emails and IP addresses leaked into tenant-visible rows. |
| 4 | Academy Owners had no view of their course orders. Platform payment queues showed raw IDs and exposed payment instructions. |
| 5 | Create Course left the success card scrolled out of view. Tabs and filters jumped to the top, and Back lost the previous position. |
| 6 | Many lists and widgets stayed stale after a change until a manual refresh. |
| 7 | The Atlas homepage had no contact form, and Platform Owners had no inbox. |
| 8 | The course builder had no drag and drop, gave no visible feedback while saving, and accepted double-clicked or out-of-date reorders. |
| 9 | Owners and Managers were shown course categories they cannot manage. |

The work went through two independent internal reviews (security; UX/accessibility/test quality), a CodeRabbit review and 33 browser journeys. Those found further defects, which were fixed in scope (section C). They include:

- an owner could revive an archived academy and get past the plan's academy limit;
- visitor PII survived deletion of a contact enquiry;
- the masked buyer email could be recovered through order search;
- a curriculum reorder race;
- the "Published courses" count was always 0;
- the academy dashboard scrolled sideways on phones.

**Final deployment state.** Both repositories are merged and deployed, and both migrations are applied. The read-only production verification (Release verify run 37136284699) finished with **0 failing checks**.
- **Backend:** `atlas-backend@cb8b2f1`. It contains the #25 initiative merge `9570a8d` plus the #26 verification checks.
- **Frontend:** `atlas@bd88096` (#17).
- **Not tested in production:** authenticated features. No account was signed in to, and no production data was created. Those features were verified locally against a real database (section E).

**Remaining limitations.** See section H. In short:

- Cross-user freshness relies on 45-second polling, not push.
- Rows written before this release keep their old outbox and notification copies until normal retention removes them.
- A few audit events have no before/after diff yet.

---

## B. Task-by-task results

Test counts are from the final local runs and from CI on the merged heads (section E).

### Task 1: Simpler Academy status for owners

- **Original problem.** The dashboard and Settings showed the internal lifecycle status (draft, active, suspended, archived).
  - Draft and active behave identically.
  - The investigation found that the tenant `PATCH /academies/:id` accepted `suspended` and `archived`. An owner could take their own site and academy sign-in offline, skipping `archive()`'s side effects.
- **Root cause.** The status was presented as owner-controlled even though nothing an owner does depends on it. The DTO accepted every enum value.
- **Implemented solution.**
  - **Frontend:** the dashboard shows "Website: Draft / Published / Publishing / Publish failed" (from `GET academies/:id/website/configuration`). Settings no longer has a status field or sends one. The Platform Owner pages still show the lifecycle status.
  - **Backend:** `UpdateAcademyDto.status` accepts only `draft` and `active`.
  - **Review fix:** a PATCH on an archived academy is refused (409 `errors.academy.statusLocked`), and so is a status change on a suspended academy. This closes a plan-limit bypass (section C).
- **Security and performance.** Server-side enforcement; no data migration.
- **Tests (all pass):**
  - `academy-status-simplified.test.tsx`: 4
  - `academies.e2e-spec.ts`: PATCH suspended/archived → 400; archived academy → 409; suspended academy status change → 409
  - J26 test 1 in EN and AR
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 2: Email verification link expiry and security

- **Original problem.** Tokens were already 256-bit, hashed, single-use and valid for 24 hours. The defects were:
  - the raw token stayed in `communication_outbox.values` for 90 days;
  - resend was not atomic, so two links could be live at once;
  - the token claim and the email-verified flag were written in separate transactions;
  - verify had no route limit;
  - resend was limited only per IP and shared the password-reset counter;
  - academy learners got a link on the management host;
  - there was no resend UI;
  - the page had a single failure state and left the token in the URL.
- **Implemented solution.**
  - **Backend:**
    - Resend rotates under a `FOR UPDATE` lock on the user, so exactly one link is live.
    - Consume is a single compare-and-swap with `emailVerifiedAt` in the same transaction.
    - Verify is throttled to 10 per minute per IP.
    - New `EmailVerificationResendRateLimitGuard` with separate per-account (3/h) and per-IP (20/h) budgets. An IP already over its limit no longer charges the account.
    - Learners get the link on the academy host.
    - Catalog `credentialValues` are scrubbed from the outbox once a message settles.
  - **Frontend:**
    - Distinct states: verifying, verified, invalid, expired, already used, network error.
    - The token is removed from the URL by a replace navigation and submitted only once.
    - `no-referrer` is set while the page is open.
    - Users can resend from the page.
    - Focus moves to each outcome.
- **Config.** `AUTH_EMAIL_VERIFICATION_RESEND_RATE_LIMIT_MAX` (3), `AUTH_EMAIL_VERIFICATION_RESEND_IP_RATE_LIMIT_MAX` (20) and `AUTH_EMAIL_VERIFICATION_RESEND_RATE_LIMIT_WINDOW_SECONDS` (3600), all with defaults.
- **Tests (all pass):**
  - `email-verification-link-security.e2e-spec.ts`: 11
  - `phase10-1-signup-email-security`
  - guard spec: 4
  - `credential-scrub.spec`
  - `verify-email-page.test.tsx`
  - J31 (invalid, expired in Arabic on a phone, resend, verify then reuse): 4
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 3: Detailed, localized audit logs

- **Original problem.** Only 27 of about 95 actions had copy; the rest read "{{actor}} made a change". Other problems:
  - `context` held only IDs, and only plans and domains had before/after values;
  - `GET academies/:id/activity` returned an empty page;
  - website, configuration, FAQ/testimonial, branding, payment-settings and media changes were not audited;
  - emails were stored in `target_label` and IP addresses in `context`.
- **Implemented solution.**
  - **Event catalogue** (`src/audit-log/catalog/audit-event-catalog.ts`): 155 actions, each with category, target type, scope, tenant visibility, allowed context keys and diff fields.
  - **Writer:** enforces the catalogue. Outside production, an unknown action throws. It keeps only allowed context keys and strips emails and IPs from tenant-visible rows. A new `record()` helper fills in the organization and role, and computes before/after over the allowed fields.
  - **Newly audited:** website pages, configuration, publish/unpublish, the FAQ and testimonial library, academy profile and branding, payment settings, gateway credentials (provider key only, never a value) and media.
  - **New diffs:** course, quiz and assignment updates.
  - **APIs:**
    - `GET academies/:id/activity` (cursor-paged, with filters) and `GET academies/:id/activity/:entryId`. Both are limited to the organization owner and to owner/administrator academy members.
    - `GET audit-log/feed` for the Platform Owner.
  - **Frontend:**
    - A shared formatter writes EN/AR sentences for all 155 actions; a test enforces the copy.
    - New Activity log page with filters, search, "only this person", load more, a details drawer and distinct loading/error/403/empty states.
    - The dashboard, Platform activity and Platform audit pages use the same row component.
- **Security.** Tenant feeds run under tenant RLS, use an allowlist of tenant-visible actions, and show actor names only (Atlas staff appear as "Atlas"). Emails are removed from older rows on read.
- **Performance.** Keyset pagination on `(occurred_at, id)` with no `count()`. Existing indexes cover the new queries, so no migration was needed.
- **Tests (all pass):**
  - catalogue and redaction specs
  - `task3-audit-activity-log.e2e-spec.ts`: 8
  - formatter tests: 169
  - page tests: 7
  - J28 (owner sentence and details in EN and AR; manager and instructor refused; Platform Owner list): 5
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 4: Orders and payments pages

- **Original problem.** Academy Owners had no course-order API, page or tenant RLS policy. The Platform lists showed raw IDs, ignored sort, searched narrowly and exposed manual payment instructions; one list filtered on the client after server pagination.
- **Implemented solution.**
  - **Migration `20261103000000_tenant_course_order_read_rls`:** SELECT-only tenant policies on course orders, course payments and refunds, scoped to the organization; `checkouts_platform_select` for the Platform Owner.
  - **Academy orders API:** `GET academies/:id/course-orders` and `GET academies/:id/course-orders/:orderId`.
    - Owner-only (`assertCanViewAcademyFinance`).
    - The buyer email is masked.
    - Search matches an email only on the exact address, with LIKE wildcards escaped (review fix).
    - Sorting by amount uses one bounded query (review fix).
  - **Platform lists:** organization, plan, academy and course names; server-side search, sort and filters; no payment instructions or proof notes.
  - **Frontend:**
    - Academy Orders list and detail pages.
    - Both Platform payment queues show names.
    - Search, filters, sort and page are kept in the URL, so Back preserves them.
    - A busy state shows while filtering.
    - The queues poll while open.
- **Tests (all pass):**
  - `academy-course-orders.e2e-spec.ts` (access, payload, filters, sort, RLS, platform lists)
  - repository spec
  - `academy-orders-page`, `platform-payment-review` and `platform-course-payments` page tests
  - J27 (owner list and detail, masked email, URL-kept filters, Arabic phone; manager refused; Platform Owner lists): 5
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 5: Scroll restoration

- **Original problem.** Reproduced in a real browser: after Create Course, the form was swapped for its success card in place at scrollY 937, so the card was off-screen. `<ScrollRestoration>` also reset the scroll on query-only changes (tabs, filters) and restored Back/Forward before the content had loaded.
- **Implemented solution.** `AppScrollManager` replaces `<ScrollRestoration>`:
  - a new page (PUSH/REPLACE) opens at the top, including `[data-scroll-container]` elements;
  - query-only changes keep the position;
  - a `#hash` scrolls to its target (and resets to the top first when the page changed);
  - Back/Forward restores the saved offset once the page is tall enough, waiting up to 5 seconds and cancelled by any user input;
  - a fresh load never inherits another page's offset (react-router's shared `default` key).

  `useResetScrollOnReveal` resets the scroll and focuses the heading when an in-page success view replaces a form. It is used by Create Course and onboarding.
- **Tests (all pass):**
  - unit tests: 10, including the review cases
  - J26 tests 2 and 3: Create Course from the bottom of the form shows the success card at scrollY 0 and the builder at the top; a tab switch keeps the position; Back restores it on a phone
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 6: Platform-wide state consistency

- **Original problem.**
  1. Invalidation keys ending in `undefined` never matched the cached lists.
  2. The builder read `unit-items` while the lesson, quiz and assignment hooks invalidated other keys.
  3. Each mutation invalidated a single root, so cross-domain views stayed stale (dashboard overview, stats, public identity, platform metrics).
  4. Focus refetch was off, so changes made by other users never appeared.
- **Implemented solution.**
  - Trailing-`undefined` key normalization.
  - A central `invalidation.ts` with domain matchers (course, academy tree, website, billing, provisioning, support, contact).
  - A key-aware placeholder policy: rows are kept when paging or filtering, but never across a change of academy or resource.
  - `LIVE_LIST_QUERY_OPTIONS`: 45-second polling, paused in background tabs, on cross-user queues and counts (support, contact submissions, roster, invites, stats, dashboard overview, both platform payment queues and the platform contact inbox).
  - Details are in `docs/STATE_CONSISTENCY_MATRIX.md` (frontend).
- **No new infrastructure.** There is no WebSocket or SSE transport today. Polling was chosen because it fits the volume, needs no new servers, and already works for notifications.
- **Tests (all pass):**
  - query tests: `mutation-invalidation`, `placeholder`, `query-utils`
  - academy-switch placeholder test
  - J30 (adding a lesson updates the curriculum and the counts without a reload)
  - J32 (a second session sees a new course count and the real published count without reloading)
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 7: Atlas homepage contact form and Platform Owner inbox

- **Implemented solution.**
  - **Migration `20261103000100_platform_contact_submissions`:**
    - FORCE RLS;
    - an anonymous INSERT is allowed only for a fresh `new` row;
    - SELECT, UPDATE and DELETE require `is_platform_owner`.
  - **`POST public/contact`:**
    - a whitelisted DTO with length limits;
    - a honeypot field;
    - a minimum fill time;
    - Redis dedupe on email and message;
    - throttling (5 per 10 minutes per IP);
    - a keyed hash of the IP (the raw address is never stored);
    - the same response for every accepted outcome.
  - **Platform Owner inbox** (`platform/contact-submissions`): list, summary, detail, status change and delete, each audited without PII.
  - **Platform Owners are notified.**
    - The in-app notification carries only the topic.
    - The outbox drops the visitor's details once the email settles.
    - Deleting an enquiry also strips its outbox rows.
    - A notification batch share-locks the enquiry, so an enquiry deleted while queued produces no email (review fixes).
  - **Frontend:**
    - Homepage contact section: localized validation, double-submit protection, a success state.
    - Contact Enquiries inbox: filters kept in the URL, a status toggle group, a detail sheet, read/unread/archive, confirmed permanent delete, and focus that returns after a delete.
    - The academy website contact section gains the honeypot and max lengths with no visual change; the theme baselines pass.
- **Tests (all pass):**
  - `platform-contact-submissions.e2e-spec.ts` (RLS, abuse controls, PII scrub after dispatch and after delete)
  - intake and submissions service specs
  - `personal-values` spec
  - page and section tests, including double submit
  - J29 (validation in EN and AR; real submit; Platform Owner read/unread/delete; DB row gone): 3
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 8: Course builder loading states and drag and drop

- **Original problem.** There was no DnD library. Section moves were not disabled while a request was pending, so a double click sent two stale reorders. Detach and delete gave no feedback. On the backend:
  - `createLesson` ordered by the highest lesson position only, so a new lesson could sort before an existing quiz;
  - the legacy lesson reorder collided with other item types;
  - there was no concurrency control.
- **Implemented solution.**
  - **Backend:**
    - Ordering is unit-wide across all item types.
    - Course and section rows are locked with `FOR UPDATE`.
    - An optional `expectedOrderedIds` returns 409 `stale_resource_version` when the client's view is out of date.
    - Reorder arrays are capped at 1000 IDs.
    - Review fix: attach and detach take the same section locks, in a stable order, and re-read membership under the locks.
  - **Frontend:**
    - dnd-kit sortable with a drag handle only; keyboard, touch and mouse all work.
    - Screen-reader announcements in EN and AR; transitions are disabled under reduced motion.
    - Optimistic reorder with rollback; reorders are serialized per scope.
    - "Saving order…" and busy states while saving.
    - Move buttons name the item.
    - dnd-kit loads only with the builder chunk; it is absent from the public bundles.
- **Tests (all pass):**
  - `course-curriculum-reorder` and `unit-curriculum` e2e suites, including moving an item between units and the stale reorder that follows
  - builder and curriculum component tests
  - J30 (keyboard, button and real mouse drag; saving state; persistence after reload; Arabic phone): 5
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

### Task 9: Hide course categories from Owners and Managers

- **Implemented solution.**
  - The category column and filter are removed from the course list.
  - Category selection is removed from create and edit.
  - Edits never send `categoryId`, so a course keeps its existing category. Sending an empty value would have disconnected it.
  - No data is migrated or deleted.
- **Tests (all pass):** `course-category-hidden.test.tsx` (3); J26 test 2 (create, edit and list show no category).
- **Status:** implemented, tested, merged. **Deployed and verified in production (read-only)** on 3 Oct 2026.

---

## C. Additional issues discovered (all fixed in scope)

| # | Issue | Why it matters | Root cause | Fix | Evidence |
|---|---|---|---|---|---|
| 1 | Owner could suspend or archive through PATCH | Takes the site and sign-in offline; skips archive side effects | DTO allowed every status | Allowlist `draft`/`active` | academies e2e |
| 2 | **High:** an archived academy could be revived by PATCH | Gets past the plan's academy limit; revives a site whose domains were already released | `update()` never checked the current status | 409 `statusLocked` for archived (any PATCH) and suspended (status change) | academies e2e |
| 3 | Contact PII survived a delete | An erasure request left up to N copies in notifications (180 days) and the outbox (90 days) | `emit` copied all values into both | `personalValues` excluded from in-app; scrubbed after settle; `forgetEntity` on delete | contact e2e asserts no row holds the email or message |
| 4 | Masked buyer email recoverable through order search | Confirms or rebuilds hidden addresses | Substring email match; LIKE wildcards not escaped | Exact match; `escapeLikePattern` | orders e2e and repository spec |
| 5 | Sort by amount loaded every matching ID | Memory and DB load on large academies | ID list materialized in Node | One bounded raw query with the same filters | orders e2e (all filters × amount sort) |
| 6 | Resend limiter charged the account after the IP was refused | A shared IP could use up a user's quota | Both counters consumed unconditionally | Check the IP first | guard spec |
| 7 | Curriculum attach/detach could race a reorder | A reorder could validate against an item that was leaving | Membership changed without the section lock | Lock affected sections in sorted order; re-read under the lock; 409 | unit-curriculum e2e |
| 8 | Enquiry deleted while queued could still be emailed; lane drained after the queue closed; takeover session IDs dropped | Privacy, delivery delay, forensics | Found by CodeRabbit | `FOR SHARE` existence check; `beforeApplicationShutdown`; allowlist update | intake spec; CodeRabbit confirmed all five |
| 9 | `academy.student.joined` had no organization ID | Joins never appeared in the activity log | Organization not resolved at write | Resolve it before the write | auth-register e2e |
| 10 | "Published courses" always showed 0 | The dashboard number was wrong | Hardcoded `0`, left over from before courses existed | Count published courses | academies e2e; J32 |
| 11 | Academy dashboard scrolled sideways at 390px | Phone layout broken | Welcome-card button row did not wrap | Stack on phones | J33 (EN and AR) |
| 12 | Scroll edge cases (shared `default` key, hash to a new page, slow content) | Users could land mid-page after an OAuth return | Found in review | Per-URL key for fresh loads; reset before hash; 5-second wait | scroll unit tests; J26 |
| 13 | Previous academy's rows flashed after switching academy | Clicking one during the flash could act on the wrong academy | `keepPreviousData` overrode the key-aware default | Removed the overrides | academy-switch test |
| 14 | E2E DB helper put the DB URL (with password) in psql argv | A failure message could print it | argv-based connection | `PG*` env vars | code review |

Checked and **not** caused by this initiative: an intermittent theme-baseline failure on `modern-education home` at 1440px ("unstable screenshot"; the diff is only a photo still decoding). It reproduced on the pre-initiative fixtures and passes in CI. It is recorded in H.

---

## D. Architecture and data changes

**New or changed APIs (backend, prefix `/api/v1`)**

- **Academies**
  - `PATCH academies/:id`: status limited to `draft`/`active`; 409 `errors.academy.statusLocked` for archived/suspended.
  - `GET academies/:id/stats`: `publishedCourses` is now real.
  - `GET academies/:id/activity` (real, cursor) and `GET academies/:id/activity/:entryId`: owner and owner/administrator members.
  - `GET academies/:id/course-orders` and `GET academies/:id/course-orders/:orderId`: organization owner.
- **Audit:** `GET audit-log/feed` (Platform Owner, cursor). The existing list and detail return category, context and changed fields.
- **Platform payment lists:** search, sort and filter parameters; names instead of IDs; no instructions.
- **Contact**
  - `POST public/contact`: public.
  - `GET platform/contact-submissions`, `GET …/summary`, `GET …/:id`, `PATCH …/:id`, `DELETE …/:id`: Platform Owner.
- **Email verification**
  - `POST auth/verify-email`: throttled to 10/min.
  - `POST auth/verify-email/resend`: new guard.
- **Curriculum reorder:** optional `expectedOrderedIds` returns 409 `stale_resource_version`; arrays capped at 1000.

**Database.** Two additive migrations; no data rewritten or deleted.
- `20261103000000_tenant_course_order_read_rls`: SELECT-only policies.
- `20261103000100_platform_contact_submissions`: new table, two enums, two indexes, FORCE RLS.

**Real-time.** No new transport. 45-second polling, paused in background tabs, on cross-user queues and counts.

**Cache behaviour.**
- Trailing-`undefined` normalization.
- Central domain invalidation.
- Placeholders keyed to the resource.
- Curriculum invalidation covers unit items, available content and counts.

**Performance.**
- Keyset audit feeds with no `count()`.
- Bounded amount sort.
- dnd-kit only in the builder chunk.
- New table indexes: `(status, created_at desc)` and `(created_at desc)`.

**Configuration.** Three optional env vars for the resend limits, with defaults. No feature flags.

**Compatibility.**
- The backend was deployed first and is backward compatible with the old frontend; the new routes are additive.
- The old academy activity endpoint changed from an empty offset page to a cursor feed. Only the new frontend reads it.

---

## E. Testing evidence

All counts are from the final runs. Nothing was skipped or weakened to get a pass. Changed assertions are listed at the end with the evidence that the old assertion was wrong.

**Backend (`atlas-backend`)**

| Check | Result |
|---|---|
| CI on `main` (run 37128130603) | Lint, typecheck, migration check, unit tests and build passed. Unit: **172 suites passed, 2 skipped; 4,210 tests passed, 2 skipped**. Database e2e (3 shards, each run twice) passed. |
| PR CI | #25: run 37125717495 on `ca8193f`, all green. #26: run 37127130100 plus `Deploy script tests` 37127130114, green. |
| Local e2e, new or changed suites | `academies`, `auth-register`, `academy-course-orders`, `platform-contact-submissions`, `email-verification-link-security`, `phase10-1-signup-email-security`, `task3-audit-activity-log`, `course-curriculum-reorder`, `unit-curriculum`, `lms-authoring`: all pass. |
| Security review | 1 high, 3 medium and 4 low findings. All fixed except one low (L2: IPv6 /64 rotation around the contact throttle), which is documented in H4. |
| CodeRabbit | #25: 5 findings, all fixed and confirmed. #26: 1 valid finding fixed; 1 incorrect finding withdrawn by CodeRabbit. |

**Frontend (`atlas`)**

| Check | Result |
|---|---|
| CI on `main` (run 37133748214) | Lint, unit tests, builds and SSR tests passed. SSR tests: **67/67**. Public website accessibility and theme checks: **553 passed**. |
| Local vitest (full suite, final tree) | **207 files, 2,191 tests passed.** Also `tsc`, ESLint and Prettier clean. |
| Builds | `build`, `build:ssr` and `test:ssr` (67/67) pass. dnd-kit appears only in the builder chunk. |
| Local theme baselines | 1,053 of 1,056 passed on fixtures built from the branch. The 3 failures are the existing `modern-education home` 1440px "unstable screenshot" timing issue (section H6). CI's theme job passed. |
| UX/accessibility/test-quality review | 6 high/medium and 11 low findings, plus test-quality items. All fixed except the low-severity academy dashboard activity-card error state (H8) and the existing `role="button"` table rows (H8). |

**Browser journeys** (Playwright, Chromium, local full stack with a real Postgres and Redis)

A combined run of **J26–J33 passed 28 of 28** (7.1 minutes). Every journey covers EN and AR (RTL), desktop and phone (390px).

| Journey | Roles | Covers |
|---|---|---|
| J26 | Owner | Website status (T1), no categories (T9), scroll on create, builder, tabs and Back (T5) |
| J27 | Owner, Manager, Platform Owner | Orders and payment lists (T4) |
| J28 | Owner, Manager, Instructor, Platform Owner | Activity log (T3) |
| J29 | Visitor, Platform Owner | Contact form and inbox, including delete (T7) |
| J30 | Owner | Builder: keyboard, button and mouse reorder; saving state; live counts (T8, T6) |
| J31 | Visitor, Learner | Verify email: invalid, expired, resend, verify then reuse (T2) |
| J32 | Owner, two sessions | Cross-session freshness; real published-course count (T6) |
| J33 | Owner | Academy dashboard has no sideways scroll at 390px |

Students are covered by J31 (verification) and by the unchanged learner journeys from earlier releases. Managers and instructors are covered by the refusal paths in J27 and J28.

**Production verification** (Release verify run 37136284699, read-only, `rum_visits=0`, 0 failing checks)
- Server:
  - all 7 tracked migrations applied, including both new ones; no unfinished or rolled-back rows;
  - `platform_contact_submissions` RLS enabled and forced;
  - all four new read policies present on the right tables and SELECT-only;
  - backend `/health` 200; 0 backend error lines in the last 30 minutes;
  - backend, Caddy and the renderer healthy;
  - 27/27 published sites have a published snapshot.
- Anonymous checks:
  - `GET platform/contact-submissions`, `academies/:id/course-orders`, `academies/:id/activity` and `audit-log/feed` return 401;
  - `POST public/contact` (empty body) and `POST auth/verify-email` (malformed token) return 400.
- Chromium:
  - the homepage contact form renders in EN (`ltr`) and AR (`rtl`) with no page errors;
  - two published Academy sites are server-rendered in EN and AR with correct titles, direction and cache headers;
  - sign-in pages are not server-rendered.
- Not exercised in production:
  - authenticated features: no sign-in was used and no data was written, per the initiative's rules;
  - RUM: visits set to 0.

**Assertions changed, with evidence**
- `academies.e2e` previously expected `publishedCourses` to be `0` "until a courses table exists". The courses table exists, so the old expectation encoded the bug fixed in C10.
- `academy-course-orders.e2e` previously expected partial-email search to match. That behaviour was the M3 vulnerability; the test now asserts an exact match and no match for a partial address.
- `J26` tab-switch scroll: the old strict "unchanged offset" ignored the browser clamping to a shorter page. Frame-by-frame sampling showed the page shrinking to 829px while the tab loaded, so the test now expects exactly the clamped offset.
- `J26` edit URL: the test was opening a non-existent `/edit` address (a 404 screenshot is the evidence).

---

## F. Git and deployment

**Repositories and branch.** `zeyadelbadawi/atlas-backend` and `zeyadelbadawi/atlas`, developed on `claude/confident-bardeen-s216dw`.

| Repo | PR | Merge commit | PR CI |
|---|---|---|---|
| atlas-backend | [#25](https://github.com/zeyadelbadawi/atlas-backend/pull/25): initiative (Tasks 1–4, 7, 8 and review fixes) | `9570a8d` | Backend CI 37125717495 ✅ |
| atlas-backend | [#26](https://github.com/zeyadelbadawi/atlas-backend/pull/26): Release verify checks | `cb8b2f1` | Backend CI 37127130100 ✅, Deploy script tests 37127130114 ✅ |
| atlas | [#17](https://github.com/zeyadelbadawi/atlas/pull/17): initiative (Tasks 1–9 and review fixes) | `bd88096` | CI 37126249952 ✅ (lint/unit/builds/SSR, accessibility and themes) |

**Deployments**

| Step | Run | Result |
|---|---|---|
| Backend CI on `main` (`9570a8d`) | 37126732148 | ✅ |
| Backend migration deploy, dispatched with `apply_migrations=true` and approved by the owner in the protected `production-migrations` environment | 37126744365 | ✅ Pre-migration backup `atlas-20261003T153329Z.sql.gz` uploaded. Both migrations applied. Backend, Caddy and renderer healthy. Last-good digests recorded. |
| Automatic deploy of `9570a8d` (superseded while queued) | 37127582627 | Cancelled by the concurrency group; the next run covered the same image plus #26. |
| Backend CI and automatic deploy (`cb8b2f1`) | 37128130603 / 37128877112 | ✅ |
| Frontend CI and automatic deploy (`bd88096`) | 37133748214 / 37134607349 | ✅ Caddy and renderer rolled; backend untouched; all healthy. |
| Release verify (read-only) | 37136284699 | ✅ 0 failing checks |

**Deployed images** (rollback record after the frontend deploy)
- backend `ghcr.io/zeyadelbadawi/atlas-backend@sha256:baa570a4c253…`
- caddy `ghcr.io/zeyadelbadawi/atlas-frontend@sha256:e466192b6765…`
- ssr `ghcr.io/zeyadelbadawi/atlas-frontend-ssr@sha256:14c46df6ddb3…`

**Rollback.** `deploy.sh --rollback` re-pins the recorded digests. Both migrations are additive and backward compatible, so the previous images run correctly against the new schema.

**Repository visibility** was not changed. No secrets appear in commits, logs or this report.

---

## G. User-visible changes

**Academy Owner**
- The dashboard shows whether the website is published instead of an internal status.
- "Published courses" shows the real number.
- The dashboard fits a phone screen.
- Settings no longer has a status field.
- New **Orders** page (list and detail; buyer email masked) and new **Activity log** page (readable EN/AR sentences, filters, before/after details).
- Course pages no longer show categories.
- **Course builder:**
  - drag and drop or move buttons, with "Saving order…";
  - stays current without refreshing;
  - a stale reorder asks for a refresh instead of overwriting.
- Create Course shows its success card at the top, and the builder opens at the top.
- Tabs and filters keep the scroll position, and Back restores it.

**Manager**
- The same builder, scroll and freshness improvements.
- No categories.
- No access to Orders or Activity log (owner-only, as is billing).

**Instructor**
- Builder and scroll improvements on the courses they manage.
- No Activity log.

**Student / learner**
- The verification email links to their academy's site.
- The verify page explains invalid, expired and used links and lets them resend.
- Their academy's catalogue and dashboards reflect changes without refreshing.

**Platform Owner**
- New **Contact Enquiries** inbox.
- Readable audit log with a cursor feed.
- Payment queues show names, keep filters in the URL and refresh on their own.
- Approving or rejecting a payment refreshes the related views.

**Public visitor**
- The Atlas homepage has a contact section, in EN and AR.
- Academy website contact forms look the same; they now carry a hidden honeypot and length limits.

---

## H. Remaining risks and follow-up

These are known limitations, not defects left within scope:

1. **Freshness relies on polling.** Cross-user changes appear within about 45 seconds while a page is visible, not instantly. Pages without polling (website editor, FAQ library, branding) update another session only on focus after their data goes stale. Push (SSE or WebSocket) would need a future initiative.
2. **Existing rows.** Outbox and notification rows written before this release keep their values (including old verification tokens) until the 90-day and 180-day retention windows remove them. No production data was rewritten.
3. **Audit gaps.**
   - `certificate_template.updated` and `course.completion_rule.updated` have no before/after diff.
   - Organization-level events (payment settings, gateways, subscription) appear on the organization dashboard widget but not in a single academy's log.
   - Titles filled in for older rows show current names.
4. **Abuse limits on the contact form.** Throttling is per full IP, so IPv6 rotation inside one /64 can get around it. Each stored enquiry sends one email per Platform Owner, which is subject to the existing operational daily cap and digest.
5. **Academy dashboard widget.** Any academy member can read it, as before. Managers and instructors now see readable sentences that include staff names; they used to see emails.
6. **Test-environment flake.** On a loaded machine, `modern-education home` at 1440px can fail the theme baseline's "two stable screenshots" check while a photo decodes. It exists on the pre-initiative code, does not involve changed code, and passes in CI.
7. **Same-time edits.** Only curriculum ordering has stale-version protection. Other editors keep their existing last-write-wins behaviour.
8. **Small UX follow-ups from review (low severity).**
   - If the academy dashboard's activity request fails, the card shows "No recent activity" instead of an error state.
   - The shared `DataTable` puts `role="button"` on table rows (this predates the initiative).
   - The Orders and payments tables scroll sideways on phones instead of switching to a card list.
