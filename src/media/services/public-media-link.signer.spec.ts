import type { ConfigService } from '@nestjs/config';
import { PublicMediaLinkSigner } from './public-media-link.signer';

const KEY =
  'academies/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf';

function signer(keyHex = 'ab'.repeat(32)): PublicMediaLinkSigner {
  return new PublicMediaLinkSigner({
    getOrThrow: () => ({ credentialEncryptionKeyHex: keyHex }),
  } as unknown as ConfigService);
}

function parts(url: string): { path: string; exp: string; sig: string } {
  const parsed = new URL(url, 'https://atlas.test');
  return {
    path: parsed.pathname,
    exp: parsed.searchParams.get('exp')!,
    sig: parsed.searchParams.get('sig')!,
  };
}

describe('PublicMediaLinkSigner (W1)', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);

  it('mints an app-relative link to exactly this object with a short expiry', () => {
    const link = signer().sign(KEY, 600, now);
    const { path, exp } = parts(link.url);
    expect(path).toBe(`/api/v1/public/media/${KEY}`);
    expect(Number(exp)).toBe(now / 1000 + 600);
    expect(link.expiresAt.getTime()).toBe(now + 600_000);
  });

  it('verifies its own link, and nothing else', () => {
    const s = signer();
    const { exp, sig } = parts(s.sign(KEY, 600, now).url);
    expect(s.verify(KEY, exp, sig, now)).toBe(true);
    // Another object, a moved expiry, a flipped character, another key.
    expect(s.verify(KEY.replace('.pdf', '.png'), exp, sig, now)).toBe(false);
    expect(s.verify(KEY, String(Number(exp) + 1), sig, now)).toBe(false);
    expect(
      s.verify(KEY, exp, `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, now),
    ).toBe(false);
    expect(signer('cd'.repeat(32)).verify(KEY, exp, sig, now)).toBe(false);
    expect(s.verify(KEY, undefined, sig, now)).toBe(false);
    expect(s.verify(KEY, exp, undefined, now)).toBe(false);
  });

  it('refuses an expired link and caps the lifetime it will mint or accept at an hour', () => {
    const s = signer();
    const { exp, sig } = parts(s.sign(KEY, 600, now).url);
    expect(s.verify(KEY, exp, sig, now + 601_000)).toBe(false);

    const long = s.sign(KEY, 7 * 24 * 3600, now);
    expect(long.expiresAt.getTime()).toBe(now + 3600_000);
  });
});
