# Session Handoff — 2026-08-27

This is a working-session handoff note, not an architecture document. For architecture, read `ATLAS_BACKEND_MASTER_PLAN.md` and `Reports/ARCHITECTURE.md`'s P13 entry. For the product decisions that unblocked this phase, read `Reports/P13_PRODUCT_DECISIONS.md`.

## What was completed today

**Phase P13 — Course Pricing, Purchase & Payouts.** Explicitly authorized this session, with all five previously-blocking product decisions resolved as part of that authorization (full refund within 30 days, buyer-initiated and self-service; partial refunds deferred but the financial model kept extensible for them; a three-tier commission hierarchy — Organization override → Plan tier → Platform default — with the actual percentage still deliberately unset; Atlas Payments mode implemented via the existing `ManualTransferProvider`, no new gateway; tax/VAT still out of scope). Full technical account in `Reports/ARCHITECTURE.md`'s new P13 section; full "what was built" account in `Reports/PROGRESS.md`'s new P13 section — this document does not repeat either.

## P0–P12 status

Unchanged and verified regression-clean this session. See "What was tested" below for the actual re-run numbers.

## P13 status

Complete for the scope this session authorized. The real, live purchase flow (course order → payment → proof → Platform Owner review → atomic enrollment + commission ledger) and the real full-refund flow (buyer-initiated, 30-day window, atomic enrollment reversal + ledger reversal) are both implemented and e2e-tested against the real running application and a real Postgres database — not mocked.

Deliberately not built (see `Reports/PROGRESS.md`'s P13 boundary list for the complete account): partial refunds, any real external payment gateway, automated/scheduled payout execution, tax/VAT, a real Connect-style processor integration, any Platform Owner Control Plane UI (P15's job).

## What was tested

- Backend unit: 30 suites / 429 tests, all passing (`src/**/*.spec.ts` — includes the extended `commission-resolution.util.spec.ts` for the new three-tier hierarchy).
- New P13 e2e: 3 suites / 41 tests, all passing — `test/course-commerce.e2e-spec.ts` (20 functional scenarios), `test/course-commerce-tenant-isolation.e2e-spec.ts` (6 scenarios), `test/rls-course-commerce.e2e-spec.ts` (direct-Postgres RLS proof, no guards).
- Full backend e2e regression (every `test/*.e2e-spec.ts` file, P0 through P13, 63 files): run twice, deliberately, given this phase touched several shared P12 files (`PaymentsRepository`, `PlatformPaymentService`, `payment.contract.ts`, `AcademiesRepository`, `EnrollmentsService`, `CommissionService`, `commission-resolution.util.ts`). First run: 494/495, one isolated flake in `course-commerce.e2e-spec.ts` (a sign-in 401 immediately after a successful register, on the heaviest-sign-in-volume file deep into a long sequential run — investigated directly, no product/test defect found). Second, immediate re-run: **495/495 passing, 63/63 suites, zero failures.** Matches this codebase's own already-documented "heavy accumulated load" flake pattern (`test/utils/test-app.ts`'s `waitFor` doc comment), not a regression.
- Backend lint (`eslint`), typecheck (`tsc --noEmit`), and build (`nest build`): all clean.
- Migrations applied against the existing, already-seeded local dev database (3,332 users / 2,398 organizations / 1,502 academies / 595 courses / 228 payments before the first P13 migration) — verified intact throughout via direct row-count queries; no `migrate reset`, no destructive statement, at any point.

## Real bugs found and fixed this session (not caught by typecheck/lint/unit tests)

All three found by actually running the e2e suite against the real database, then reproduced in isolation with a minimal Node script before writing the fix — matching this codebase's established "manual smoke testing surfaces real bugs" precedent (P12's BullMQ `jobId` colon bug is the prior example). Full technical detail in `Reports/ARCHITECTURE.md`'s P13 entry:

1. Prisma's nested relational `connect` performs its own RLS-gated pre-flight SELECT, invisible to a non-member student/Platform Owner even when the row genuinely exists — fixed by switching to `UncheckedCreateInput` (scalar FKs) at three write sites.
2. A Platform-Owner-triggered atomic transaction must run under the reviewer's own `app.current_user_id`, not the buyer's (matching `PlatformPaymentService.approvePayment`'s P12 precedent) — required four small, additive RLS migrations once corrected.
3. PostgreSQL RLS also filters a write's `RETURNING` clause through the table's SELECT policies, which Prisma's `create()`/`update()` always generates — `course_progress`/`lesson_progress` had INSERT policies but no matching SELECT policy, producing the identical "violates row-level security policy" error as an outright-blocked INSERT. This is a genuinely reusable lesson for any future phase mixing Prisma ORM writes with `FORCE ROW LEVEL SECURITY`.

## Migrations added this session

Six, all additive, in order: `20260827095132_p13_course_pricing_purchase_payouts` (the schema itself — six new tables, `payments` extended, one CHECK constraint, the bulk of the new RLS policies), `20260827102718_p13_1_course_commerce_rls_fixes`, `20260827102832_p13_2_enrollments_platform_select`, `20260827103323_p13_3_progress_platform_insert`, `20260827103937_p13_4_progress_platform_select_for_returning`. None renames, restructures, or drops anything from a prior phase.

## Files touched outside `src/course-commerce/` (the new module) this session

Small, additive, behavior-preserving changes only, each documented at its own call site: `prisma/schema.prisma` (Payment model extension + new models), `src/billing/billing.module.ts` (new `exports` array), `src/billing/services/commission.service.ts` (three-tier resolution), `src/billing/utils/commission-resolution.util.ts` + its spec (three-tier signature), `src/billing/dto/commission.contract.ts` (plan-tier response shape), `src/billing/controllers/platform-commission.controller.ts` (two new routes), `src/billing/repositories/payments.repository.ts` (`findManyAnyOrganization` scoped to `checkoutId IS NOT NULL`; two new methods), `src/billing/services/platform-payment.service.ts` (`getPayment`/`loadReviewablePayment` reject course-order rows), `src/billing/dto/payment.contract.ts` (nullable `organizationId` fallback), `src/billing/utils/payment-proof-key.util.ts` (new sibling function), `src/billing/dto/update-plan-commission.dto.ts` (new file), `src/billing/repositories/plan-commission-settings.repository.ts` (new file), `src/learning/learning.module.ts` (new `exports` array), `src/learning/services/enrollments.service.ts` (extracted `createEnrollmentInTransaction`, zero behavior change to the existing free-enrollment path — proven by the pre-existing P6 suite passing unchanged), `src/academy/repositories/academies.repository.ts` (new `resolveOrganizationId` method, reusing the existing P11 `resolve_academy_organization` SQL function), `src/app.module.ts` (registers `CourseCommerceModule`).

## Pre-existing, unrelated working-tree changes (not made this session)

`.env.example` (`CORS_ALLOWED_ORIGINS` 5173→3001) and `package-lock.json` (a small dependency-metadata diff) were already present in the working tree before this session began (both predate this session's first commit-adjacent action; confirmed via `git diff` and `git log -1`). Neither was touched, reverted, or investigated further this session — flagged here only so a future session doesn't mistake them for P13 work.

## What was NOT pushed

Nothing was committed or pushed this session — no commit/push request was given. The working tree contains all P13 changes, uncommitted, on `main`, up to date with `origin/main` as of the start of this session. A future session (or this one, on request) should review the diff, commit, and push through the normal process.

## Next phase

**P14 — Provisioning Orchestration.** Not started. Do not begin without explicit approval — this session's own instruction was to stop after P13.
