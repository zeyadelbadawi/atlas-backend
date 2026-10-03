# Atlas Platform-Wide UX, Real-Time, Security and Operations Initiative: Investigation Report

**Date:** 3 October 2026
**Baseline:** frontend `atlas@af83043`, backend `atlas-backend@77e5120` (both on `main`)

Six read-only audits ran in parallel and covered all nine tasks, with `file:line` references. This report sets out the confirmed root causes, the plan, and how work was split among agents. The final report records the outcomes.

## Architecture relevant to all tasks

**Frontend**
- React 18 and Vite.
- TanStack Query v5.101 with one key factory, `services/query/query-keys.ts`, and the `useApiMutation`/`useInvalidate` helpers.
- react-router 6.30 data router: a single splat route with descendant `<Routes>`.
- i18next with English and Arabic (RTL).
- The public Academy site is server-rendered through the same `appRoutes`.

**Backend**
- NestJS and Prisma on Postgres with FORCE RLS. Tenant context is set per transaction.
- Redis is used for throttling and caches; BullMQ runs the communications outbox.
- There is no WebSocket or SSE transport.
- One deploy pipeline per repo (GitHub Actions to the VPS). Migrations need manual dispatch approval.

## Confirmed root causes

| Task | Root cause |
|---|---|
| T1 Academy status | `AcademyStatus` draft/active gates nothing; every gate checks only `archived`/`suspended`. Website publish state decides public availability. **Defect:** the tenant `PATCH /academies/:id` accepted `suspended`/`archived`, letting an owner take their site and sign-in offline while skipping `archive()`'s side effects. |
| T2 Verification links | Tokens are already 256-bit, hashed, single-use and expire after 24h. Defects: <ul><li>the raw token persists in `communication_outbox.values` for 90 days;</li><li>resend rotation is not atomic, so two links can be live;</li><li>claiming the token and marking the email verified happen in separate transactions;</li><li>verify has no route limit;</li><li>resend is limited by IP only and shares the password-reset counter;</li><li>academy learners get a link on the management host;</li><li>there is no resend UI;</li><li>the verify page has a single failure state and leaves the token in the URL.</li></ul> |
| T3 Audit logs | Only 27 of about 95 actions have localized copy, so the rest fall back to "{{actor}} made a change". Other problems: <ul><li>context holds only IDs, and there is no before/after except for plans and domains;</li><li>the academy activity endpoint returns an empty page;</li><li>website, configuration, FAQ/testimonial, academy branding, payment-settings and media mutations are not audited;</li><li>emails are stored in `target_label`, IP addresses in `context`, and `context` is not scrubbed.</li></ul> |
| T4 Orders | Both payment flows share one `payments` table, and the Platform Owner already has review pages. Academy Owners have no course-order API, page or tenant RLS policy. Platform lists show raw IDs, ignore sort, search narrowly, leak manual payment instructions, and one filters on the client after server pagination. |
| T5 Scroll | Reproduced: Create Course swaps the form for its success card in place, so the window keeps scrollY 937 and the card sits above the viewport. `<ScrollRestoration>` also resets on query-only changes and restores Back/Forward before content loads. |
| T6 Stale UI | <ol><li>Invalidation keys ending in `undefined` never match the cached lists (FAQ, testimonials, tenant payments, provisioning).</li><li>The course builder reads `unit-items` while lesson, quiz and assignment hooks invalidate `sections` or authoring keys.</li><li>Single-root invalidation misses cross-domain views: dashboard overview, stats, public identity (logo), platform metrics.</li><li>Focus refetch is off, so cross-user changes never appear.</li></ol> |
| T7 Contact form | There is no platform inquiry model and no homepage form. The academy contact form is the security pattern to follow, but its generic renderer lacks the honeypot and max lengths. |
| T8 Course builder | No DnD library is installed. Section moves are not disabled while pending, so a double click sends two stale reorders. Detach and delete give no feedback. Backend: `createLesson` orders by lesson-only max, so it can sort before an existing quiz; the legacy lesson reorder collides with other item types; there is no reorder concurrency control (last write wins). |
| T9 Categories | There is no category CRUD; only seed data has categories. The create/update APIs treat `categoryId` as optional, and omitting it preserves the existing value. |

## Strategy and ownership

- **Agents** (one owner per area; shared wiring files edited with small targeted insertions; the coordinator commits):
  - T2 email-verification agent
  - T3 audit agent
  - T4 orders agent
  - T6 cache-consistency agent (frontend, excluding the builder)
  - T7 contact agent
  - T8 builder agent (also owns builder cache consistency)
- **Coordinator:** T1, T5, T9, integration, reviews, browser journeys and the release.
- **Cross-task interfaces:** the audit catalogue includes the actions used by T7 (`platform.contact_submission.*`) and T8 (`course_section.reordered`, `course.curriculum.items_reordered`). The orders agent applies the T6 invalidation rules inside the payment hooks it owns.

## Security and tenant isolation

- Every new read path runs under tenant context with a server-side role check:
  - academy orders: owner only (`assertCanViewAcademyFinance`);
  - academy audit: the academy's managing roles;
  - platform pages: `PlatformOwnerGuard`.
- The new RLS policies are SELECT-only and additive.
- Public contact endpoint: whitelist DTO, honeypot, minimum fill time, deduplication, throttling, a hashed IP, and generic responses.
- No raw credentials are kept in the outbox after dispatch.

## Performance

- Cursor pagination for audit logs.
- Tenant-scoped indexes for new query paths.
- No count-per-request on hot lists where avoidable.
- Targeted invalidation instead of global invalidation.
- Polling (30–60s, paused in background tabs) only on cross-user queues. No new real-time infrastructure: there is no transport today, the volume is low, and polling already works for notifications.

## Migrations and compatibility

All migrations are additive:
- tenant SELECT policies for course orders, payments and refunds;
- the `platform_contact_submissions` table;
- optional audit indexes.

There are no destructive changes and no production data rewrites. Outbox credential scrubbing applies going forward; existing rows expire under the 90-day retention policy.

Deploy order: backend first (backward compatible), then frontend. Migrations go through the protected `production-migrations` dispatch.

## Test strategy

- Unit tests and backend e2e for each task: isolation, authorization, concurrency, validation, and rate limits.
- Frontend vitest for the states of each page.
- Playwright journeys on a fresh local stack for each role.
- Theme baselines and axe checks; English and Arabic parity.
- Full suites in both repos before merging.
