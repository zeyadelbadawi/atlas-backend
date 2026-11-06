import sharp from 'sharp';
import { BrandImagesService } from './brand-images.service';
import {
  brandImageVersion,
  cardFontSize,
  displayName,
  escapeMarkup,
  hslTripletToRgb,
  monogramLetter,
  parseMonogramSize,
  textColorOn,
} from '../utils/brand-images.util';

describe('brand-images.util', () => {
  it('versions by name and colour exactly as the frontend does (FNV-1a over UTF-16)', () => {
    // Pinned values: `brandImageVersion` in the frontend's
    // academy-brand-images.utils.ts must produce the same.
    expect(brandImageVersion('Alpha Academy', '350 60% 45%')).toBe(
      brandImageVersion('Alpha Academy', '350 60% 45%'),
    );
    expect(brandImageVersion('Alpha Academy', '350 60% 45%')).toMatch(/^[0-9a-f]{8}$/);
    expect(brandImageVersion('Alpha Academy', undefined)).not.toBe(
      brandImageVersion('Alpha Academy', '350 60% 45%'),
    );
    expect(brandImageVersion('أكاديمية النور', '221 83% 53%')).toBe('8fb18879');
    expect(brandImageVersion('Alpha Academy', '350 60% 45%')).toBe('5df5a69e');
  });

  it('reads the stored HSL triplet, and falls back to the default blue', () => {
    expect(hslTripletToRgb('0 0% 100%')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hslTripletToRgb('120 100% 25%')).toEqual({ r: 0, g: 128, b: 0 });
    expect(hslTripletToRgb('not a colour')).toEqual({ r: 37, g: 99, b: 235 });
  });

  it('picks the more readable text colour', () => {
    expect(textColorOn({ r: 37, g: 99, b: 235 })).toBe('#ffffff');
    expect(textColorOn({ r: 250, g: 230, b: 120 })).toBe('#111827');
  });

  it('escapes markup and bounds the drawn name', () => {
    expect(escapeMarkup(`<b>&"'`)).toBe('&lt;b&gt;&amp;&quot;&apos;');
    expect(displayName('  A\u0000cademy \n name ')).toBe('Academy name');
    expect([...displayName('x'.repeat(200))]).toHaveLength(90);
    expect(cardFontSize('Short')).toBeGreaterThan(
      cardFontSize('A considerably longer academy name here'),
    );
  });

  it('draws the first letter, Arabic included', () => {
    expect(monogramLetter('horizon')).toBe('H');
    expect(monogramLetter('  42 Academy')).toBe('4');
    expect(monogramLetter('أكاديمية النور')).toBe('أ');
    expect(monogramLetter('!!!')).toBe('A');
  });

  it('accepts only the monogram sizes it draws', () => {
    expect(parseMonogramSize(undefined)).toBe(180);
    expect(parseMonogramSize('96')).toBe(96);
    expect(parseMonogramSize('97')).toBeNull();
    expect(parseMonogramSize('100000')).toBeNull();
  });
});

describe('BrandImagesService (real rendering)', () => {
  const service = new BrandImagesService();

  it('draws a 1200×630 PNG share card with the name set in the bundled fonts', async () => {
    const card = await service.renderCard('a1', {
      name: 'Horizon أكاديمية',
      primaryColor: '221 83% 53%',
    });
    const meta = await sharp(card.png).metadata();
    expect(meta.format).toBe('png');
    expect([meta.width, meta.height]).toEqual([1200, 630]);
    expect(card.version).toBe(brandImageVersion('Horizon أكاديمية', '221 83% 53%'));
    // The name was drawn: the card is not one flat colour.
    const stats = await sharp(card.png).stats();
    expect(stats.channels[0].max - stats.channels[0].min).toBeGreaterThan(100);
  }, 30_000);

  it('draws square monograms at the asked size, and caches each render', async () => {
    const first = await service.renderMonogram('a1', { name: 'Horizon' }, 180);
    const meta = await sharp(first.png).metadata();
    expect([meta.width, meta.height]).toEqual([180, 180]);
    const again = await service.renderMonogram('a1', { name: 'Horizon' }, 180);
    expect(again.png).toBe(first.png);
    const small = await service.renderMonogram('a1', { name: 'Horizon' }, 96);
    expect((await sharp(small.png).metadata()).width).toBe(96);
  }, 30_000);
});
