-- Phase 10.3 — real TOTP two-factor authentication.
--
-- Phase 10 deliberately deferred 2FA and shipped only a documented
-- insertion point in `AuthService.signIn`. This migration is the storage
-- half of actually implementing it.

CREATE TABLE "user_two_factor" (
    "user_id" TEXT NOT NULL,
    -- AES-256-GCM ciphertext of the base32 TOTP secret, under a key
    -- derived specifically for this purpose (see `TotpSecretCipher`).
    -- Never plaintext, in this column or anywhere else.
    "encrypted_secret" TEXT NOT NULL,
    -- NULL until the user proves they can generate a valid code.
    -- Enforcement hangs on this, not on the row existing: requiring a
    -- code before enrolment is confirmed would lock people out of their
    -- own accounts over a mis-scanned QR.
    "confirmed_at" TIMESTAMP(3),
    -- Replay protection: the TOTP time step of the last accepted code.
    -- A code must have a strictly greater time step to be accepted, so
    -- the same six digits cannot be used twice even within their own
    -- 30-second window.
    "last_time_step" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_two_factor_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "two_factor_recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    -- SHA-256 of the normalised code. Hashed for the same reason a
    -- password is: a database disclosure must not yield a working second
    -- factor. Plaintext is shown to the user once, at generation, and is
    -- unrecoverable afterwards.
    "code_hash" TEXT NOT NULL,
    -- Single use. Enforced by a conditional UPDATE rather than deletion,
    -- so the record that a code was consumed survives.
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "two_factor_recovery_codes_code_hash_key"
    ON "two_factor_recovery_codes"("code_hash");
CREATE INDEX "two_factor_recovery_codes_user_id_used_at_idx"
    ON "two_factor_recovery_codes"("user_id", "used_at");

-- CASCADE on both: a second factor and its recovery codes are
-- meaningless without the account they protect, and unlike
-- `trial_redemptions` nothing about anti-abuse depends on them
-- outliving it.
ALTER TABLE "user_two_factor"
    ADD CONSTRAINT "user_two_factor_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "two_factor_recovery_codes"
    ADD CONSTRAINT "two_factor_recovery_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- No RLS on either table, matching `users`, `refresh_tokens` and
-- `password_reset_tokens`: these are identity-layer tables scoped to a
-- single user id, not tenant data. Every access path resolves the user
-- id from a verified token or an authenticated challenge, never from a
-- caller-supplied parameter.
