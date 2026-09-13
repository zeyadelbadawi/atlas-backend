-- Phase 11 — separate "never had a plan" and "trial ended" from "expired",
-- and move Free-Trial eligibility into the plan catalog.
--
-- THE BUG THIS FIXES AT ITS ROOT. A brand-new Organization was given a
-- subscription row with `status = 'expired'` (see
-- `OrganizationSubscriptionBootstrapService`), chosen at the time because
-- `expired` was already in every INACTIVE_STATUSES set and so "just
-- worked" for gating. It also meant the product had no way to tell a
-- customer who has never chosen a plan apart from one whose paid
-- subscription lapsed — they were byte-for-byte the same row. Every
-- surface that tried (`SubscriptionAccessService`, `useSubscriptionAccess`)
-- correctly reported `expired`, and the customer was greeted with "Your
-- subscription has ended" on a workspace created seconds earlier.
--
-- The same collapse hid a second distinction: `markExpired` set
-- `status='expired', trial_ends_at=NULL`, so a finished Free Trial became
-- indistinguishable from a fresh Organization the moment the sweep ran.
-- That is why trial expiry could not offer "continue with the plan you
-- were trialing" — the plan was still on the row, but nothing recorded
-- that a trial was what ended.
--
-- Two new states, not a new column: `status` is already the lifecycle
-- field every reader switches on, and adding a parallel boolean beside it
-- would create exactly the second source of truth this codebase avoids.
--
-- WHY THIS MIGRATION ADDS THE VALUES BUT DOES NOT USE THEM. PostgreSQL
-- forbids using an enum value in the same transaction that added it.
-- Prisma runs each migration directory in its own transaction, so the
-- backfill that actually assigns these lives in the next migration
-- (`p43b`), which is a separate transaction and may therefore use them.

ALTER TYPE "tenant_subscription_status" ADD VALUE IF NOT EXISTS 'no_plan';
ALTER TYPE "tenant_subscription_status" ADD VALUE IF NOT EXISTS 'trial_expired';

-- Free-Trial eligibility as CATALOG DATA.
--
-- The product rule is "Starter and Growth are trialable, Enterprise is
-- not". Expressing that as `if (key === 'starter' || key === 'growth')`
-- anywhere in application code would mean a future plan needs a code
-- change — and, worse, the same condition duplicated in the frontend
-- where it cannot be trusted anyway. A column makes eligibility a fact
-- the backend reads and the frontend merely displays.
--
-- DEFAULT false is the deliberate direction: a plan inserted by a future
-- migration, a seed, or an admin tool is NOT trialable until somebody
-- says so. For a rule that gives away paid product, silence must mean no.
ALTER TABLE "plans"
  ADD COLUMN "trial_eligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "trial_duration_days" INTEGER;

-- NOTE ON PRIVILEGES AND RLS. No GRANT or policy change is needed here.
-- `plans` is a platform-owned catalog table whose existing grants already
-- cover these columns (no column-level grants are used on it), and
-- `tenant_subscriptions` gains no new column at all — only its existing
-- `status` enum gains members, which no policy predicate enumerates.
