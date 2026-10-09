import { isFaviconReference, parseFavicon } from './favicon.util';

const ACADEMY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const OWN_PATH = `/api/v1/public/media/academies/${ACADEMY}/${FILE}.png`;

describe('favicon.util (W2 — no open redirect)', () => {
  it('serves inline PNG/ICO bytes', () => {
    const source = parseFavicon('data:image/png;base64,iVBORw0KGgo=', ACADEMY);
    expect(source).toMatchObject({ kind: 'inline', contentType: 'image/png' });
  });

  it('never serves an external URL, though it may still be stored', () => {
    for (const external of [
      'https://cdn.example.com/icon.png',
      'http://evil.example/x',
      `https://evil.example${OWN_PATH}?next=//evil.example`,
    ]) {
      expect(parseFavicon(external, ACADEMY)).toBeNull();
      expect(isFaviconReference(external)).toBe(true);
    }
  });

  it("serves the Academy's own uploaded image as a path-only redirect", () => {
    expect(parseFavicon(OWN_PATH, ACADEMY)).toEqual({ kind: 'media', path: OWN_PATH });
    expect(parseFavicon(`https://anything.example${OWN_PATH}`, ACADEMY)).toEqual({
      kind: 'media',
      path: OWN_PATH,
    });
  });

  it("refuses another Academy's media and anything but a PNG media path", () => {
    expect(parseFavicon(OWN_PATH, OTHER)).toBeNull();
    expect(parseFavicon(OWN_PATH.replace('.png', '.gif'), ACADEMY)).toBeNull();
    expect(parseFavicon('//evil.example/x.png', ACADEMY)).toBeNull();
    expect(isFaviconReference('//evil.example/x.png')).toBe(false);
    expect(isFaviconReference('javascript:alert(1)')).toBe(false);
    expect(isFaviconReference('data:image/svg+xml;base64,PHN2Zy8+')).toBe(false);
  });
});
