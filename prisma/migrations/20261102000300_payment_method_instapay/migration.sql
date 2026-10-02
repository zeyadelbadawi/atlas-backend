-- InstaPay as its own manual payment method type (2 Oct 2026).
--
-- InstaPay is an instant bank-network transfer to an InstaPay address
-- (`name@instapay`), neither a bank account transfer nor a mobile wallet,
-- so it gets its own type rather than borrowing one of theirs. Additive:
-- a new enum value only; nothing existing changes. Its own migration, so
-- the value is committed before the next migration uses it.
ALTER TYPE "payment_method_type" ADD VALUE IF NOT EXISTS 'manual_instapay';
