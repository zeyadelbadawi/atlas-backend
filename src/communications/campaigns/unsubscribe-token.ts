/**
 * W3-compose — the stateless one-click unsubscribe token.
 *
 * `base64url(payload).base64url(HMAC-SHA256(key, payload))`, where the
 * payload is `{ v: 1, u: <user id>, c: <category>, e: <expiry, epoch s> }`.
 * No database row: a mail client may POST the List-Unsubscribe URL at any
 * time, and the link must work without the recipient signing in.
 *
 * THE KEY. Derived from `JWT_ACCESS_SECRET` with a fixed, versioned label
 * (`sha256("atlas:unsubscribe:v1:" + secret)`), so this token can never be
 * confused with, or replayed as, a session token: the MAC key differs and
 * the format differs. Rotating the JWT secret invalidates outstanding
 * unsubscribe links, which is acceptable — the preference page is always
 * one sign-in away.
 *
 * WHAT IT GRANTS. Exactly one thing: turning OFF email for one category of
 * one user. It cannot turn anything on, read anything, or touch any other
 * setting, so a leaked link can at worst silence a newsletter.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

export function unsubscribeKey(jwtSecret: string): Buffer {
  return createHash('sha256').update(`atlas:unsubscribe:v1:${jwtSecret}`).digest();
}

export function signUnsubscribeToken(
  key: Buffer,
  userId: string,
  category: UnsubscribeCategory,
  now = Date.now(),
): string {
  const payload = base64url(
    JSON.stringify({
      v: 1,
      u: userId,
      c: category,
      e: Math.floor(now / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
    }),
  );
  const mac = base64url(createHmac('sha256', key).update(payload).digest());
  return `${payload}.${mac}`;
}

export function verifyUnsubscribeToken(
  key: Buffer,
  token: string,
  now = Date.now(),
): UnsubscribePayload | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const record = decoded as { v?: unknown; u?: unknown; c?: unknown; e?: unknown };
  if (
    record.v !== 1 ||
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
