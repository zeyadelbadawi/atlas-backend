-- Phase 10.1 — email verification.
--
-- Atlas had no email verification of any kind before this migration: the
-- `users` table had no verified marker, and no verification-token model
-- existed anywhere in the schema. An account was fully trusted the moment
-- the signup request passed format validation, which meant an address
-- nobody could receive mail at was indistinguishable from a real one.
--
-- That matters beyond hygiene. Free-Trial eligibility is keyed on the
-- canonical email, so an unverifiable address would otherwise be a free
-- source of unlimited new trial subjects.

-- Nullable, with no default. Existing accounts become honestly
-- "unverified" rather than being retroactively claimed as verified — a
-- backfill to `now()` here would have quietly asserted something untrue
-- about every account created before today.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);

-- Deliberately the same shape as `password_reset_tokens`: hashed token at
-- rest, explicit expiry, single-use `used_at` marker. Reusing a proven
-- structure rather than inventing a second one.
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    -- SHA-256 of the emailed token. The raw token exists only in the
    -- email itself, so a database disclosure yields nothing usable.
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    -- Set on first successful use; a replay of the same link finds it
    -- already used and is refused.
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key"
    ON "email_verification_tokens"("token_hash");
CREATE INDEX "email_verification_tokens_user_id_idx"
    ON "email_verification_tokens"("user_id");

-- CASCADE is correct here, unlike on `trial_redemptions`: a verification
-- token is meaningless without its user, and nothing about anti-abuse
-- depends on it surviving. The durable anti-abuse record is the
-- redemption row, which is deliberately protected instead.
ALTER TABLE "email_verification_tokens"
    ADD CONSTRAINT "email_verification_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
