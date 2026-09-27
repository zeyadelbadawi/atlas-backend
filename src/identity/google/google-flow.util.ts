/**
 * Google Identity — small, pure helpers for the sign-in flow. No I/O.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A 256-bit URL-safe random secret (state, nonce, binder, handoff, PKCE verifier). */
export function newFlowSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex — every flow secret is stored only in this form. */
export function hashFlowSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented secret against its stored hash. */
export function flowSecretMatches(
  presented: string | undefined,
  storedHash: string,
): boolean {
  if (!presented) return false;
  const a = Buffer.from(hashFlowSecret(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** RFC 7636 S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Where to land after signing in, as a RELATIVE path only — never a scheme,
 * a host, a protocol-relative `//host`, or a backslash trick. Anything else
 * becomes `null` (the page's own default), so the flow can never be turned
 * into an open redirect.
 */
export function sanitizeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (path.length === 0 || path.length > 512) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (path.includes('\\') || [...path].some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  return path;
}

/**
 * Whether Google is AUTHORITATIVE for the address (Google's own guidance on
 * the `email`, `email_verified` and `hd` claims): a verified `@gmail.com`
 * address, or a verified address on the Google Workspace domain the token
 * names in `hd`. For any other verified address Google only confirmed it at
 * account-creation time, so it is never treated as proof of the mailbox
 * today.
 */
export function isGoogleAuthoritative(claims: {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly hostedDomain?: string | null;
}): boolean {
  if (!claims.emailVerified) return false;
  const domain = claims.email.split('@')[1]?.toLowerCase() ?? '';
  if (domain === 'gmail.com') return true;
  const hd = claims.hostedDomain?.toLowerCase();
  return !!hd && domain === hd;
}
