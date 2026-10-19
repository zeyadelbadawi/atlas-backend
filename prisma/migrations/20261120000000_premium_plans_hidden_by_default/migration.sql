-- B0-CAT-03 — the Premium (Stream) family is not customer-facing.
--
-- Production was contained on 15 Oct 2026 by the owner-approved Catalog
-- containment workflow (`display_order` 4/5/6 -> 0), so there this is a
-- no-op. It makes every other database the 20261009000200 migration
-- created (CI, staging, a fresh install) match: the three Premium rows
-- exist, are bought and renewed by key, and are hidden from the public
-- catalog, signup and the signed-in plan lists (`display_order > 0` is the
-- customer-facing floor).
--
-- Only rows still visible are touched (`display_order > 0`), with
-- `version` + 1 so a console editor holding the old version gets a 409.
-- To show the family again: Actions -> Catalog containment -> revert
-- (puts 4/5/6 back, owner-approved).

UPDATE "plans"
   SET "display_order" = 0,
       "version" = "version" + 1,
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "key" IN ('premium-starter', 'premium-growth', 'premium-enterprise')
   AND "family" = 'premium'
   AND "display_order" > 0;
