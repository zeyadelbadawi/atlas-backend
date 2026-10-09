import { createHmac } from 'node:crypto';
import {
  UNSUBSCRIBE_TOKEN_TTL_SECONDS,
  signUnsubscribeToken,
  unsubscribeKey,
  unsubscribeKeyring,
  verifyUnsubscribeToken,
} from './unsubscribe-token';

const PAYMENT_KEY = 'ab'.repeat(32);

describe('unsubscribe token', () => {
  const keys = unsubscribeKeyring({
    paymentCredentialsKeyHex: PAYMENT_KEY,
    jwtSecret: 'test-jwt-secret',
  });

  /** A v1 token exactly as links sent before v2 were signed. */
  function legacyToken(jwtSecret: string, userId: string, expiresAt: number): string {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, u: userId, c: 'engagement', e: expiresAt }),
    ).toString('base64url');
    const mac = createHmac('sha256', unsubscribeKey(jwtSecret))
      .update(payload)
      .digest('base64url');
    return `${payload}.${mac}`;
  }

  it('round-trips the user and category', () => {
    const token = signUnsubscribeToken(keys, 'user-1', 'engagement');
    expect(verifyUnsubscribeToken(keys, token)).toMatchObject({
      userId: 'user-1',
      category: 'engagement',
    });
  });

  it('issues v2 tokens', () => {
    const [payload] = signUnsubscribeToken(keys, 'user-1', 'engagement').split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).v).toBe(2);
  });

  it('rejects a token signed with another key', () => {
    const other = unsubscribeKeyring({ paymentCredentialsKeyHex: 'cd'.repeat(32) });
    const token = signUnsubscribeToken(other, 'user-1', 'engagement');
    expect(verifyUnsubscribeToken(keys, token)).toBeNull();
  });

  it('does not depend on the JWT secret: rotating it keeps v2 links valid', () => {
    const token = signUnsubscribeToken(keys, 'user-1', 'engagement');
    const rotated = unsubscribeKeyring({
      paymentCredentialsKeyHex: PAYMENT_KEY,
      jwtSecret: 'a-brand-new-jwt-secret',
    });
    expect(verifyUnsubscribeToken(rotated, token)).not.toBeNull();
  });

  it('prefers a dedicated key over the derived one', () => {
    const dedicated = unsubscribeKeyring({
      dedicatedKeyHex: 'ef'.repeat(32),
      paymentCredentialsKeyHex: PAYMENT_KEY,
    });
    expect(dedicated.current.equals(Buffer.from('ef'.repeat(32), 'hex'))).toBe(true);
    const token = signUnsubscribeToken(dedicated, 'user-1', 'engagement');
    expect(verifyUnsubscribeToken(keys, token)).toBeNull();
  });

  it('still accepts a v1 link sent before v2 (until it expires)', () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = legacyToken('test-jwt-secret', 'user-1', expires);
    expect(verifyUnsubscribeToken(keys, token)).toMatchObject({ userId: 'user-1' });
    // …but not without the legacy key, nor with a different JWT secret.
    const noLegacy = unsubscribeKeyring({ paymentCredentialsKeyHex: PAYMENT_KEY });
    expect(verifyUnsubscribeToken(noLegacy, token)).toBeNull();
    expect(
      verifyUnsubscribeToken(keys, legacyToken('other', 'user-1', expires)),
    ).toBeNull();
  });

  it('never accepts a payload whose version does not match its key', () => {
    // A v2-claiming payload MACed under the v1 key, and vice versa.
    const e = Math.floor(Date.now() / 1000) + 3600;
    const v2Payload = Buffer.from(
      JSON.stringify({ v: 2, u: 'user-1', c: 'engagement', e }),
    ).toString('base64url');
    const underV1 = createHmac('sha256', keys.legacy!)
      .update(v2Payload)
      .digest('base64url');
    expect(verifyUnsubscribeToken(keys, `${v2Payload}.${underV1}`)).toBeNull();
    const v1Payload = Buffer.from(
      JSON.stringify({ v: 1, u: 'user-1', c: 'engagement', e }),
    ).toString('base64url');
    const underV2 = createHmac('sha256', keys.current)
      .update(v1Payload)
      .digest('base64url');
    expect(verifyUnsubscribeToken(keys, `${v1Payload}.${underV2}`)).toBeNull();
  });

  it('rejects a tampered payload (switching the user)', () => {
    const token = signUnsubscribeToken(keys, 'user-1', 'engagement');
    const [, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ v: 2, u: 'user-2', c: 'engagement', e: 9_999_999_999 }),
    ).toString('base64url');
    expect(verifyUnsubscribeToken(keys, `${forged}.${mac}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const issued = Date.now() - (UNSUBSCRIBE_TOKEN_TTL_SECONDS + 10) * 1000;
    const token = signUnsubscribeToken(keys, 'user-1', 'operational', issued);
    expect(verifyUnsubscribeToken(keys, token)).toBeNull();
  });

  it.each(['', 'a', 'a.b.c', 'not base64!.x', 'x'.repeat(700)])(
    'rejects malformed input %#',
    (token) => {
      expect(verifyUnsubscribeToken(keys, token)).toBeNull();
    },
  );

  it('derives keys distinct from the raw secrets', () => {
    expect(unsubscribeKey('s').equals(Buffer.from('s'))).toBe(false);
    expect(keys.current.equals(Buffer.from(PAYMENT_KEY, 'hex'))).toBe(false);
  });
});
