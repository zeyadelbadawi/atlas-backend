-- Phase 10.2 — row-level security for `subscription_cancellations`.
--
-- Unlike `trial_redemptions` (platform-owned anti-abuse state, matching
-- `trial_policy`'s no-RLS precedent), a cancellation row is TENANT DATA:
-- it carries an `organization_id`, a reason, and free-text feedback that
-- belongs to one organization. Today the only reader is the
-- platform-admin overview, which is guarded — but "no endpoint reads it
-- yet" is not a security control, and the first tenant-facing billing
-- history screen would otherwise leak every other tenant's cancellation
-- reasons.
--
-- Defence in depth: the guard stops the wrong caller reaching the
-- endpoint; these policies stop the wrong rows reaching any caller.

ALTER TABLE "subscription_cancellations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_cancellations" FORCE ROW LEVEL SECURITY;

-- A tenant sees only its own organization's cancellations, keyed on the
-- same `app.current_organization_id` setting every other tenant-scoped
-- policy in this schema uses.
CREATE POLICY "subscription_cancellations_tenant_select"
  ON "subscription_cancellations"
  FOR SELECT
  USING (
    "organization_id" = current_setting('app.current_organization_id', true)
  );

-- Writes are tenant-scoped identically. `TrialRedemptionService` performs
-- them inside `runInTenantAndUserContext`, so this is satisfied by the
-- real code path rather than requiring an exception.
CREATE POLICY "subscription_cancellations_tenant_insert"
  ON "subscription_cancellations"
  FOR INSERT
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
  );

-- The platform owner reads across tenants — the same
-- `is_platform_owner(...)` SECURITY DEFINER function and the same
-- `*_platform_select` shape introduced in P15 for organizations,
-- memberships and academies. `AdminSubscriptionsService` runs inside
-- `runInUserContext(platformOwnerId)`, which is what sets
-- `app.current_user_id` for this check.
CREATE POLICY "subscription_cancellations_platform_select"
  ON "subscription_cancellations"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- No UPDATE or DELETE policy, deliberately. With RLS forced and no
-- permissive policy for those commands, they match zero rows for every
-- caller: a cancellation record, like a trial redemption, is history
-- rather than mutable state. Correcting a genuine mistake requires a
-- privileged, out-of-band operation, which is the intended bar.
