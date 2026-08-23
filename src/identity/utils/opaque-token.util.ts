/**
 * Opaque bearer tokens (refresh tokens, password-reset tokens).
 *
 * Distinct from the access token (a signed JWT, `AccessTokenService`):
 * these are cryptographically random strings the backend hands out and
 * later looks up by their hash — never decoded, never carrying claims.
 * Master plan §8/§16: "never store raw tokens" — only `hashOpaqueToken`'s
 * output is ever persisted.
 */
import { randomBytes, createHash } from 'node:crypto';

const RAW_TOKEN_BYTES = 32; // 256 bits of entropy.

/** A new, cryptographically random raw token, base64url-encoded (URL-safe, no padding). */
export function generateOpaqueToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

/** One-way hash for at-rest storage — never reversible, matching `password_hash`'s posture in spirit (this is a lookup key, not a password, so SHA-256 over a high-entropy random input is the standard, appropriate choice — not Argon2id, which is deliberately slow and would make every refresh/reset lookup expensive for no security benefit against a 256-bit random token). */
export function hashOpaqueToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
