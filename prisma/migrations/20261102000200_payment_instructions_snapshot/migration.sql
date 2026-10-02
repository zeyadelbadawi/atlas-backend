-- Bank Transfer (2 Oct 2026): each payment keeps the instructions its payer
-- was shown, so editing or disabling the method later never changes what
-- an open payment asks the payer to do.
--
-- Additive: one nullable column. Existing manual-transfer payments are
-- filled from their method's current instructions (the ones they were
-- shown, as no write path to those instructions existed until now).

ALTER TABLE "payments" ADD COLUMN "instructions_snapshot" JSONB;

UPDATE "payments" p
SET "instructions_snapshot" = m."manual_instructions"
FROM "payment_methods" m
WHERE m."key" = p."method_key"
  AND m."manual_instructions" IS NOT NULL
  AND p."instructions_snapshot" IS NULL;
