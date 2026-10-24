/**
 * Sign in with Apple (B2) — verifies the identity token the iOS app gets
 * from `ASAuthorizationAppleIDCredential`, with `node:crypto` only.
 *
 * Checks, in order: RS256 signature by the JWKS `kid` (cached; an unknown
 * `kid` refetches at most once a minute), `iss` = https://appleid.apple.com,
 * `aud` ∈ the configured bundle ids, `exp`/`iat` within 60 s, `nonce` =
 * SHA-256(raw nonce the app generated for this request), `sub` and `email`
 * present. Nothing is believed before all of them pass.
 */
import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { Logger } from '@nestjs/common';
import { normalizeEmail } from '../utils/email.util';

export const APPLE_ISSUER = 'https://appleid.apple.com';
const JWKS_URI = 'https://appleid.apple.com/auth/keys';
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const JWKS_REFETCH_MIN_INTERVAL_MS = 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const HTTP_TIMEOUT_MS = 5_000;

export interface AppleIdentityClaims {
  readonly subject: string;
  readonly email: string;
  /** Apple relays mail through `privaterelay.appleid.com` when the person hides their address. */
  readonly isPrivateEmail: boolean;
  /** Which configured bundle id the token was issued to. */
  readonly clientId: string;
}

export class AppleTokenError extends Error {
  constructor(
    readonly kind: 'invalid_token' | 'provider_error',
    reason: string,
  ) {
    super(reason);
  }
}

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly n?: string;
  readonly e?: string;
  readonly use?: string;
}

export class AppleIdTokenVerifier {
  private readonly logger = new Logger(AppleIdTokenVerifier.name);
  private keys = new Map<string, KeyObject>();
  private keysFetchedAt = 0;

  constructor(
    private readonly clientIds: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly jwksUri: string = JWKS_URI,
  ) {}

  async verify(identityToken: string, rawNonce: string): Promise<AppleIdentityClaims> {
    const parts = identityToken.split('.');
    if (parts.length !== 3) throw invalid('malformed token');
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJson(encodedHeader);
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw invalid('unsupported header');
    }
    const key = await this.keyFor(header.kid);
    if (!key) throw invalid('unknown signing key');
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      key,
      Buffer.from(encodedSignature, 'base64url'),
    );
    if (!ok) throw invalid('bad signature');

    const payload = decodeJson(encodedPayload);
    if (!payload) throw invalid('malformed payload');
    if (payload.iss !== APPLE_ISSUER) throw invalid('wrong issuer');
    const audience = typeof payload.aud === 'string' ? payload.aud : null;
    if (!audience || !this.clientIds.includes(audience)) throw invalid('wrong audience');
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < now) {
      throw invalid('expired');
    }
    if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_SECONDS > now) {
      throw invalid('issued in the future');
    }
    const expectedNonce = createHash('sha256').update(rawNonce, 'utf8').digest('hex');
    if (typeof payload.nonce !== 'string' || !equal(payload.nonce, expectedNonce)) {
      throw invalid('nonce mismatch');
    }
    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      payload.sub.length > 255
    ) {
      throw invalid('missing subject');
    }
    if (typeof payload.email !== 'string' || !payload.email.includes('@')) {
      throw invalid('missing email');
    }
    // Apple's addresses are verified by Apple (both real and relay).
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    if (!verified) throw invalid('email not verified');
    return {
      subject: payload.sub,
      email: normalizeEmail(payload.email),
      isPrivateEmail:
        payload.is_private_email === true || payload.is_private_email === 'true',
      clientId: audience,
    };
  }

  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = Date.now();
    const stale = now - this.keysFetchedAt > JWKS_TTL_MS;
    if (this.keys.has(kid) && !stale) return this.keys.get(kid);
    if (stale || now - this.keysFetchedAt > JWKS_REFETCH_MIN_INTERVAL_MS) {
      const refreshed = await this.refreshKeys();
      if (!refreshed && !this.keys.has(kid)) {
        throw new AppleTokenError('provider_error', 'signing keys unavailable');
      }
    }
    return this.keys.get(kid);
  }

  private async refreshKeys(): Promise<boolean> {
    this.keysFetchedAt = Date.now();
    let body: { keys?: Jwk[] } | null = null;
    try {
      const response = await this.fetchImpl(this.jwksUri, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
      body = (await response.json()) as { keys?: Jwk[] };
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not refresh the Apple signing keys.',
      );
      return false;
    }
    const next = new Map<string, KeyObject>();
    for (const jwk of body?.keys ?? []) {
      if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
      if (jwk.use && jwk.use !== 'sig') continue;
      try {
        next.set(
          jwk.kid,
          createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }),
        );
      } catch {
        // A malformed key is skipped, never trusted.
      }
    }
    this.keys = next;
    return true;
  }
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function invalid(reason: string): AppleTokenError {
  return new AppleTokenError('invalid_token', reason);
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
