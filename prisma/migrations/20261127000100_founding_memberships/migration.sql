-- B2 — Founding Academies: the first 20 paying academies, whose annual
-- price for one plan is locked for 24 months.
--
-- Additive: a new enum and a new table; nothing existing changes.
--
-- Integrity the application relies on, enforced here:
--   * a seat is 1..20 (CHECK) and unique among non-revoked rows (partial
--     unique index); revoking releases it, an ended lock keeps it;
--   * an organization holds at most one non-revoked membership;
--   * the lock end is after its start; amounts and hours are not negative;
--   * `revoked_at` is set exactly when the status is `revoked`.
-- Seats are assigned under a transaction-scoped advisory lock
-- (`FoundingMembershipsService`), so two concurrent creates queue and the
-- 21st is refused; the unique index is the backstop if that ever changed.

-- CreateEnum
CREATE TYPE "founding_membership_status" AS ENUM ('active', 'revoked', 'ended');

-- CreateTable
CREATE TABLE "founding_memberships" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "seat_number" INTEGER NOT NULL,
    "plan_id" TEXT NOT NULL,
    "locked_amount" DECIMAL(12,2) NOT NULL,
    "locked_currency" VARCHAR(3) NOT NULL,
    "lock_starts_at" TIMESTAMP(3) NOT NULL,
    "lock_ends_at" TIMESTAMP(3) NOT NULL,
    "status" "founding_membership_status" NOT NULL DEFAULT 'active',
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(500),
    "source_contact_submission_id" TEXT,
    "concierge_hours_used" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "notes" VARCHAR(4000),
    "price_notice_sent_for" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "founding_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "founding_memberships_organization_id_idx" ON "founding_memberships"("organization_id");

-- CreateIndex
CREATE INDEX "founding_memberships_status_created_at_idx" ON "founding_memberships"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "founding_memberships_plan_id_idx" ON "founding_memberships"("plan_id");

-- CreateIndex
CREATE INDEX "founding_memberships_source_contact_submission_id_idx" ON "founding_memberships"("source_contact_submission_id");

-- AddForeignKey
ALTER TABLE "founding_memberships" ADD CONSTRAINT "founding_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "founding_memberships" ADD CONSTRAINT "founding_memberships_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "founding_memberships" ADD CONSTRAINT "founding_memberships_source_contact_submission_id_fkey" FOREIGN KEY ("source_contact_submission_id") REFERENCES "platform_contact_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateCheck
ALTER TABLE "founding_memberships"
  ADD CONSTRAINT "founding_memberships_seat_number_check" CHECK ("seat_number" BETWEEN 1 AND 20),
  ADD CONSTRAINT "founding_memberships_lock_window_check" CHECK ("lock_ends_at" > "lock_starts_at"),
  ADD CONSTRAINT "founding_memberships_locked_amount_check" CHECK ("locked_amount" >= 0),
  ADD CONSTRAINT "founding_memberships_concierge_hours_check" CHECK ("concierge_hours_used" >= 0 AND "concierge_hours_used" <= 999),
  ADD CONSTRAINT "founding_memberships_currency_check" CHECK ("locked_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "founding_memberships_revoked_check" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL));

-- One seat per number, and one membership per organization, among the
-- rows that still hold a seat (active or ended).
CREATE UNIQUE INDEX "founding_memberships_seat_held_key"
  ON "founding_memberships"("seat_number")
  WHERE "status" <> 'revoked';
CREATE UNIQUE INDEX "founding_memberships_one_per_organization_key"
  ON "founding_memberships"("organization_id")
  WHERE "status" <> 'revoked';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- SELECT: Platform Owners (the management API), and the organization's
-- own tenant context, which reads its row for the owner's billing screen
-- and so the server can price that organization's checkout. A different
-- tenant, a learner and an anonymous caller see nothing.
-- INSERT / UPDATE: Platform Owners only, through `is_platform_owner(text)`
-- exactly like `platform_contact_submissions_platform_*`. No DELETE policy:
-- a membership is revoked, never deleted (an organization's deletion
-- cascades as its other rows do).

ALTER TABLE "founding_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "founding_memberships" FORCE ROW LEVEL SECURITY;

CREATE POLICY "founding_memberships_select" ON "founding_memberships"
  FOR SELECT
  USING (
    is_platform_owner(current_setting('app.current_user_id', true))
    OR "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

CREATE POLICY "founding_memberships_platform_insert" ON "founding_memberships"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "founding_memberships_platform_update" ON "founding_memberships"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
