/** W3 — which stored logo values are usable in email, and how they are sized. */
import {
  EMAIL_LOGO_MAX_SOURCE_BYTES,
  emailLogoDisplaySize,
  emailLogoVersion,
  parseEmailLogoSource,
} from './email-logo.util';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

describe('parseEmailLogoSource', () => {
  it('reads this academy’s own media asset by storage key (relative or absolute)', () => {
    expect(
      parseEmailLogoSource(`/api/v1/public/media/academies/${A}/${FILE}.png`, A),
    ).toEqual({
      kind: 'media',
      storageKey: `academies/${A}/${FILE}.png`,
    });
    expect(
      parseEmailLogoSource(
        `https://x.atlass.dpdns.org/api/v1/public/media/academies/${A}/${FILE}.webp`,
        A,
      ),
    ).toEqual({ kind: 'media', storageKey: `academies/${A}/${FILE}.webp` });
  });

  it('refuses another academy’s asset — no cross-tenant serving under this name', () => {
    expect(
      parseEmailLogoSource(`/api/v1/public/media/academies/${B}/${FILE}.png`, A),
    ).toBeNull();
  });

  it('decodes a legacy inline data URI (png/jpeg/gif/webp only)', () => {
    const parsed = parseEmailLogoSource('data:image/png;base64,iVBORw0KGgo=', A);
    expect(parsed?.kind).toBe('inline');
    expect(parseEmailLogoSource('data:image/svg+xml;base64,PHN2Zz4=', A)).toBeNull();
    expect(parseEmailLogoSource('data:text/html;base64,PHNjcmlwdD4=', A)).toBeNull();
  });

  it('refuses an oversized inline data URI before decoding it', () => {
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((EMAIL_LOGO_MAX_SOURCE_BYTES * 4) / 3) + 8)}`;
    expect(parseEmailLogoSource(huge, A)).toBeNull();
  });

  it('never fetches remote URLs: an arbitrary http(s) logo is unusable (text fallback)', () => {
    expect(parseEmailLogoSource('https://cdn.example.com/logo.png', A)).toBeNull();
    expect(parseEmailLogoSource('http://cdn.example.com/logo.png', A)).toBeNull();
  });

  it('refuses traversal, unknown extensions, junk and empty values', () => {
    expect(
      parseEmailLogoSource(`/api/v1/public/media/academies/${A}/../secret.png`, A),
    ).toBeNull();
    expect(
      parseEmailLogoSource(`/api/v1/public/media/academies/${A}/${FILE}.svg`, A),
    ).toBeNull();
    expect(parseEmailLogoSource('javascript:alert(1)', A)).toBeNull();
    expect(parseEmailLogoSource('', A)).toBeNull();
    expect(parseEmailLogoSource(null, A)).toBeNull();
  });
});

describe('emailLogoVersion', () => {
  it('is a stable 16-hex hash that changes with the value', () => {
    expect(emailLogoVersion('a')).toMatch(/^[0-9a-f]{16}$/);
    expect(emailLogoVersion('a')).toBe(emailLogoVersion('a'));
    expect(emailLogoVersion('a')).not.toBe(emailLogoVersion('b'));
  });
});

describe('emailLogoDisplaySize', () => {
  it('shows a logo 40px tall with proportional width', () => {
    expect(emailLogoDisplaySize(300, 100)).toEqual({ width: 120, height: 40 });
    expect(emailLogoDisplaySize(160, 160)).toEqual({ width: 40, height: 40 });
  });

  it('caps a wide wordmark at 200px and shrinks its height to keep the ratio', () => {
    expect(emailLogoDisplaySize(480, 40)).toEqual({ width: 200, height: 17 });
  });

  it('falls back to a 40×40 box for nonsense dimensions', () => {
    expect(emailLogoDisplaySize(0, 0)).toEqual({ width: 40, height: 40 });
  });
});
