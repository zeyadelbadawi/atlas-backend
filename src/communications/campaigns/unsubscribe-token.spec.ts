import {
  UNSUBSCRIBE_TOKEN_TTL_SECONDS,
  signUnsubscribeToken,
  unsubscribeKey,
  verifyUnsubscribeToken,
} from './unsubscribe-token';

describe('unsubscribe token', () => {
  const key = unsubscribeKey('test-jwt-secret');

  it('round-trips the user and category', () => {
    const token = signUnsubscribeToken(key, 'user-1', 'engagement');
    expect(verifyUnsubscribeToken(key, token)).toMatchObject({
      userId: 'user-1',
      category: 'engagement',
    });
  });

  it('rejects a token signed with another key', () => {
    const token = signUnsubscribeToken(unsubscribeKey('other'), 'user-1', 'engagement');
    expect(verifyUnsubscribeToken(key, token)).toBeNull();
  });

  it('rejects a tampered payload (switching the user)', () => {
    const token = signUnsubscribeToken(key, 'user-1', 'engagement');
    const [, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ v: 1, u: 'user-2', c: 'engagement', e: 9_999_999_999 }),
    ).toString('base64url');
    expect(verifyUnsubscribeToken(key, `${forged}.${mac}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const issued = Date.now() - (UNSUBSCRIBE_TOKEN_TTL_SECONDS + 10) * 1000;
    const token = signUnsubscribeToken(key, 'user-1', 'operational', issued);
    expect(verifyUnsubscribeToken(key, token)).toBeNull();
  });

  it.each(['', 'a', 'a.b.c', 'not base64!.x', 'x'.repeat(700)])(
    'rejects malformed input %#',
    (token) => {
      expect(verifyUnsubscribeToken(key, token)).toBeNull();
    },
  );

  it('derives a key distinct from the raw secret', () => {
    expect(unsubscribeKey('s').equals(Buffer.from('s'))).toBe(false);
  });
});
