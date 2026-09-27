/**
 * Google Identity — the OpenID Connect client (authorization-code flow).
 *
 * Talks to exactly three Google endpoints: the authorization endpoint (only
 * as a URL the browser is sent to), the token endpoint (server-to-server,
 * with the client secret and the PKCE verifier) and the public JWKS. Only
 * the ID token's verified claims leave this class; Google's access token is
 * never stored or returned, and no Google refresh token is requested.
 *
 * ID-token verification is done here with `node:crypto` rather than a
 * library: one algorithm (RS256, the only one Google's discovery document
 * lists), one key set, and every check spelled out below —
 *   signature (JWKS key by `kid`) · `iss` (either form Google uses) ·
 *   `aud` = our client id (and `azp` when several audiences) · `exp`/`iat`
 *   with a small skew · `sub` present · `nonce` = the flow's nonce.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { GoogleAuthConfig } from '../../config/configuration';
import { normalizeEmail } from '../utils/email.util';
import { flowSecretMatches } from './google-flow.util';

/** The verified identity claims Atlas uses. Nothing else is kept. */
export interface GoogleIdentityClaims {
  /** Google's stable, never-reassigned account id — THE identity key. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Google Workspace / Cloud Identity domain, when the account is managed. */
  readonly hostedDomain: string | null;
  readonly name: string | null;
}

/** `provider_error`: Google unreachable or refused; `invalid_token`: verification failed. */
export class GoogleOidcError extends Error {
  constructor(
    readonly kind: 'provider_error' | 'invalid_token',
    message: string,
  ) {
    super(message);
  }
}

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MIN_INTERVAL_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
}

@Injectable()
export class GoogleOidcClient {
  private readonly logger = new Logger(GoogleOidcClient.name);
  private keys = new Map<string, KeyObject>();
  private keysFetchedAt = 0;

  constructor(private readonly configService: ConfigService) {}

  private get config(): GoogleAuthConfig {
    return this.configService.getOrThrow<GoogleAuthConfig>('googleAuth');
  }

  /** All three credentials present — the only predicate callers ask. */
  isConfigured(): boolean {
    const { clientId, clientSecret, redirectUri } = this.config;
    return Boolean(clientId && clientSecret && redirectUri);
  }

  /** The URL the browser is sent to. `openid email profile` only. */
  authorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
  }): string {
    const { authorizationEndpoint, clientId, redirectUri } = this.config;
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId ?? '');
    url.searchParams.set('redirect_uri', redirectUri ?? '');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Always let the person choose which Google account — a shared browser
    // must not silently sign the previous person in.
    url.searchParams.set('prompt', 'select_account');
    url.searchParams.set('access_type', 'online');
    return url.toString();
  }

  /**
   * Exchanges the one-time code (with the PKCE verifier and the client
   * secret) and returns the VERIFIED claims of the ID token it yields.
   */
  async exchangeAndVerify(input: {
    readonly code: string;
    readonly codeVerifier: string;
    /** SHA-256 of the nonce sent with this flow's authorization request. */
    readonly nonceHash: string;
  }): Promise<GoogleIdentityClaims> {
    const { tokenEndpoint, clientId, clientSecret, redirectUri } = this.config;
    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: input.codeVerifier,
          client_id: clientId ?? '',
          client_secret: clientSecret ?? '',
          redirect_uri: redirectUri ?? '',
        }).toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GoogleOidcError(
        'provider_error',
        `token endpoint unreachable: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
    if (!response.ok) {
      // The body may echo request details; only the status is kept.
      throw new GoogleOidcError(
        'provider_error',
        `token endpoint answered ${response.status}`,
      );
    }
    const body = (await response.json().catch(() => null)) as {
      id_token?: unknown;
    } | null;
    if (!body || typeof body.id_token !== 'string') {
      throw new GoogleOidcError('provider_error', 'token response carried no id_token');
    }
    return this.verifyIdToken(body.id_token, input.nonceHash);
  }

  /** Every check an ID token must pass before any claim is believed. */
  async verifyIdToken(idToken: string, nonceHash: string): Promise<GoogleIdentityClaims> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw invalid('malformed token');
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = decodeJson(encodedHeader);
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw invalid('unsupported header');
    }
    const key = await this.keyFor(header.kid);
    if (!key) throw invalid('unknown signing key');

    const signatureValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      key,
      Buffer.from(encodedSignature, 'base64url'),
    );
    if (!signatureValid) throw invalid('bad signature');

    const payload = decodeJson(encodedPayload);
    if (!payload) throw invalid('malformed payload');
    const { acceptedIssuers, clientId } = this.config;

    if (typeof payload.iss !== 'string' || !acceptedIssuers.includes(payload.iss)) {
      throw invalid('wrong issuer');
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!clientId || !audiences.includes(clientId)) throw invalid('wrong audience');
    if (audiences.length > 1 && payload.azp !== clientId) throw invalid('wrong azp');

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < now) {
      throw invalid('expired');
    }
    if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_SECONDS > now) {
      throw invalid('issued in the future');
    }
    if (
      typeof payload.nonce !== 'string' ||
      !flowSecretMatches(payload.nonce, nonceHash)
    ) {
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

    return {
      subject: payload.sub,
      email: normalizeEmail(payload.email),
      // Google sends a boolean; the string form has been seen historically.
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      hostedDomain: typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null,
      name:
        typeof payload.name === 'string' && payload.name.trim().length > 0
          ? payload.name.trim().slice(0, 200)
          : null,
    };
  }

  /**
   * The signing key for `kid`, from a cached copy of the JWKS. An unknown
   * `kid` refetches (Google rotates keys), but at most once a minute, so a
   * stream of forged `kid`s cannot turn this into a request amplifier.
   */
  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = Date.now();
    const stale = now - this.keysFetchedAt > JWKS_TTL_MS;
    if (this.keys.has(kid) && !stale) return this.keys.get(kid);
    if (stale || now - this.keysFetchedAt > JWKS_REFETCH_MIN_INTERVAL_MS) {
      const refreshed = await this.refreshKeys();
      // Google unreachable AND the key is not already known: that is a
      // provider problem, not a bad token.
      if (!refreshed && !this.keys.has(kid)) {
        throw new GoogleOidcError('provider_error', 'signing keys unavailable');
      }
    }
    return this.keys.get(kid);
  }

  /** `false` when the JWKS could not be fetched; the cached keys are kept. */
  private async refreshKeys(): Promise<boolean> {
    this.keysFetchedAt = Date.now();
    let body: { keys?: Jwk[] } | null = null;
    try {
      const response = await fetch(this.config.jwksUri, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
      body = (await response.json()) as { keys?: Jwk[] };
    } catch (error) {
      // Keep whatever keys are already cached; the token check then fails
      // closed for a key we cannot resolve.
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not refresh the Google signing keys.',
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

function invalid(reason: string): GoogleOidcError {
  return new GoogleOidcError('invalid_token', reason);
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
