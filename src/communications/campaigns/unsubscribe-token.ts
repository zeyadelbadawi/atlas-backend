/**
 * W3-compose — the stateless one-click unsubscribe token.
 *
 * `base64url(payload).base64url(HMAC-SHA256(key, payload))`, where the
 * payload is `{ v: 2, u: <user id>, c: <category>, e: <expiry, epoch s> }`.
 * No database row: a mail client may POST the List-Unsubscribe URL at any
 * time, and the link must work without the recipient signing in.
 *
 * THE KEY (v2, ATO review key separation). `UNSUBSCRIBE_TOKEN_KEY` when an
 * operator provisions one, otherwise an HKDF-SHA256 derivation of the
 * required `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` under its own label — the
 * same "derive, don't add a required secret" pattern as the TOTP and OTP
 * ciphers. It no longer depends on `JWT_ACCESS_SECRET`: rotating the
 * session-signing secret (the first move in a session-compromise incident)
 * must not also break every unsubscribe link in every inbox.
 *
 * v1 (the old `sha256("atlas:unsubscribe:v1:" + JWT secret)` key) is still
 * ACCEPTED, never issued, so links already sent keep working until they
 * expire on their own — at most `UNSUBSCRIBE_TOKEN_TTL_SECONDS` after this
 * release, after which the v1 branch can be deleted.
 *
 * WHAT IT GRANTS. Exactly one thing: turning OFF email for one category of
 * one user. It cannot turn anything on, read anything, or touch any other
 * setting, so a leaked link can at worst silence a newsletter.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type {
  CommunicationsConfig,
  IdentityConfig,
  PaymentConfigurationConfig,
} from '../../config/configuration';
import type { UnsubscribeCategory } from './campaign.types';

export const UNSUBSCRIBE_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface UnsubscribePayload {
  readonly userId: string;
  readonly category: UnsubscribeCategory;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

const CATEGORIES: ReadonlySet<string> = new Set(['engagement', 'operational']);

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** The v1 key — verification only, for links sent before v2. */
export function unsubscribeKey(jwtSecret: string): Buffer {
  return createHash('sha256').update(`atlas:unsubscribe:v1:${jwtSecret}`).digest();
}

const V2_HKDF_SALT = 'atlas.unsubscribe.hkdf.salt.v2';
const V2_HKDF_INFO = 'atlas.unsubscribe.token.v2';

/** The keys a token is signed with (`current`) and still accepted under. */
export interface UnsubscribeKeyring {
  /** v2 — signs every new link. */
  readonly current: Buffer;
  /** v1 — accepted until the last link it signed expires. */
  readonly legacy: Buffer | null;
}

export function unsubscribeKeyring(source: {
  /** `UNSUBSCRIBE_TOKEN_KEY` (64 hex), when provisioned. */
  readonly dedicatedKeyHex?: string | null;
  /** The required `PAYMENT_CREDENTIALS_ENCRYPTION_KEY`. */
  readonly paymentCredentialsKeyHex: string;
  /** `JWT_ACCESS_SECRET`, only to keep verifying v1 links. */
  readonly jwtSecret?: string | null;
}): UnsubscribeKeyring {
  const current = source.dedicatedKeyHex
    ? Buffer.from(source.dedicatedKeyHex, 'hex')
    : Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.from(source.paymentCredentialsKeyHex, 'hex'),
          V2_HKDF_SALT,
          V2_HKDF_INFO,
          32,
        ),
      );
  return { current, legacy: source.jwtSecret ? unsubscribeKey(source.jwtSecret) : null };
}

/** The keyring from application config; `null` when no key can be formed. */
export function unsubscribeKeyringFromConfig(
  configService: ConfigService,
): UnsubscribeKeyring | null {
  const paymentKey =
    configService.get<PaymentConfigurationConfig>(
      'paymentConfiguration',
    )?.credentialEncryptionKeyHex;
  const dedicated =
    configService.get<CommunicationsConfig>('communications')?.unsubscribeTokenKeyHex;
  if (!dedicated && !paymentKey) return null;
  return unsubscribeKeyring({
    dedicatedKeyHex: dedicated ?? null,
    paymentCredentialsKeyHex: paymentKey ?? '',
    jwtSecret: configService.get<IdentityConfig>('identity')?.jwtAccessSecret ?? null,
  });
}

export function signUnsubscribeToken(
  keyring: UnsubscribeKeyring,
  userId: string,
  category: UnsubscribeCategory,
  now = Date.now(),
): string {
  const key = keyring.current;
  const payload = base64url(
    JSON.stringify({
      v: 2,
      u: userId,
      c: category,
      e: Math.floor(now / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
    }),
  );
  const mac = base64url(createHmac('sha256', key).update(payload).digest());
  return `${payload}.${mac}`;
}

export function verifyUnsubscribeToken(
  keyring: UnsubscribeKeyring,
  token: string,
  now = Date.now(),
): UnsubscribePayload | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) return null;
  // The version is read BEFORE the MAC check only to pick the key; the MAC
  // is then verified under that key and the version re-checked below, so a
  // payload claiming v1 can never be accepted under the v2 key or vice versa.
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const record = decoded as { v?: unknown; u?: unknown; c?: unknown; e?: unknown };
  const key = record.v === 2 ? keyring.current : record.v === 1 ? keyring.legacy : null;
  if (!key) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (
    (record.v !== 1 && record.v !== 2) ||
    typeof record.u !== 'string' ||
    record.u.length === 0 ||
    record.u.length > 64 ||
    typeof record.c !== 'string' ||
    !CATEGORIES.has(record.c) ||
    typeof record.e !== 'number'
  ) {
    return null;
  }
  if (record.e * 1000 < now) return null;
  return {
    userId: record.u,
    category: record.c as UnsubscribeCategory,
    expiresAt: record.e,
  };
}
