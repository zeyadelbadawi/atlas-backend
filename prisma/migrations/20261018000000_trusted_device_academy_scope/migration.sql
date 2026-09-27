-- Launch Stabilization A6 — academy-scoped trusted devices.
--
-- A browser trusted on Academy A's website must never skip the emailed
-- sign-in code on Academy B's website (or on management). The trust row now
-- records which academy it was earned on; the application matches on it.
--
-- Additive and nullable: management rows stay NULL; academy rows recorded
-- before this column also stay NULL and simply no longer match an academy
-- sign-in (fail-closed — that browser is asked for a code once more). No
-- data rewrite, no RLS change (the existing self-only policies cover the new
-- column).
ALTER TABLE "trusted_devices" ADD COLUMN "academy_id" TEXT;

CREATE INDEX "trusted_devices_user_id_surface_academy_id_revoked_at_idx"
  ON "trusted_devices"("user_id", "surface", "academy_id", "revoked_at");
