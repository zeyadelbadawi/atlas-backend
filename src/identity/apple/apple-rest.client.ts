/**
 * Apple's REST endpoints for Sign in with Apple (B2): exchanging the app's
 * one-time authorization code for a refresh token, and revoking it when the
 * account is deleted (Apple requires the revoke).
 *
 * Both need a client secret: an ES256 JWT signed with the team's Sign in
 * with Apple key (`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`).
 * Without that key the app still signs people in — only the exchange and
 * the revoke are skipped (and logged).
 */
import { createPrivateKey, sign } from 'node:crypto';
import { Logger } from '@nestjs/common';

export interface AppleSigningKey {
  readonly teamId: string;
  readonly keyId: string;
  /** The `.p8` PEM; `\n` escapes are accepted. */
  readonly privateKey: string;
}

const AUDIENCE = 'https://appleid.apple.com';
const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const TIMEOUT_MS = 10_000;

const b64url = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64url');

export class AppleRestClient {
  private readonly logger = new Logger(AppleRestClient.name);

  constructor(
    private readonly key: AppleSigningKey | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.key !== null;
  }

  /** ES256 client secret for `clientId` (the bundle id), valid 5 minutes. */
  clientSecret(clientId: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
    if (!this.key) throw new Error('Apple signing key not configured');
    const header = b64url(
      JSON.stringify({ alg: 'ES256', kid: this.key.keyId, typ: 'JWT' }),
    );
    const claims = b64url(
      JSON.stringify({
        iss: this.key.teamId,
        iat: nowSeconds,
        exp: nowSeconds + 300,
        aud: AUDIENCE,
        sub: clientId,
      }),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: createPrivateKey(this.key.privateKey.replace(/\\n/g, '\n')),
      dsaEncoding: 'ieee-p1363',
    });
    return `${header}.${claims}.${b64url(signature)}`;
  }

  /** The refresh token for a fresh authorization code, or null (never throws). */
  async exchangeCode(clientId: string, code: string): Promise<string | null> {
    if (!this.key) return null;
    try {
      const response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: this.clientSecret(clientId),
          code,
          grant_type: 'authorization_code',
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'Apple code exchange refused');
        return null;
      }
      const body = (await response.json()) as { refresh_token?: string };
      return typeof body.refresh_token === 'string' ? body.refresh_token : null;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Apple code exchange failed',
      );
      return null;
    }
  }

  /** Revokes a refresh token. `true` when Apple accepted it (never throws). */
  async revoke(clientId: string, refreshToken: string): Promise<boolean> {
    if (!this.key) return false;
    try {
      const response = await this.fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: this.clientSecret(clientId),
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response.ok;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Apple token revoke failed',
      );
      return false;
    }
  }
}
