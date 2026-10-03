import { BadRequestException } from '@nestjs/common';
import {
  normalizeBrandColor,
  parseRequestedBrand,
  readRequestedBrand,
  summarizeRequestedBrand,
} from './requested-brand';

function violationOf(run: () => unknown): { field: string; messageKey: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      violations: { field: string; messageKey: string }[];
    };
    return body.violations[0];
  }
  throw new Error('expected a 400');
}

const manualPalette = (primary: string) => ({
  seeds: { primary },
  status: 'confirmed',
  source: 'manual',
});

describe('requested brand (W2)', () => {
  it('normalizes hex colours to the stored HSL triplet and keeps triplets', () => {
    expect(normalizeBrandColor('#2563eb')).toBe('221 83% 53%');
    expect(normalizeBrandColor('#fff')).toBe('0 0% 100%');
    expect(normalizeBrandColor('221 83% 53%')).toBe('221 83% 53%');
    expect(normalizeBrandColor('red')).toBeNull();
    expect(normalizeBrandColor('#12345')).toBeNull();
    expect(normalizeBrandColor('400 10% 10%')).toBeNull();
  });

  it('nothing chosen is null (theme default colours)', () => {
    expect(parseRequestedBrand(undefined, 'u1')).toBeNull();
    expect(parseRequestedBrand({}, 'u1')).toBeNull();
    expect(parseRequestedBrand({ logoPending: false }, 'u1')).toBeNull();
  });

  it('accepts a hex palette, stores it normalized, and records a pending logo', () => {
    const brand = parseRequestedBrand(
      { palette: manualPalette('#2563eb'), logoPending: true },
      'u1',
    );
    expect(brand?.palette?.seeds.primary).toBe('221 83% 53%');
    expect(brand?.logo).toEqual({ status: 'awaiting_upload' });
    expect(summarizeRequestedBrand(brand)).toEqual({
      palette: true,
      logo: 'awaiting_upload',
    });
  });

  it('refuses a data: URI anywhere, naming the field', () => {
    expect(
      violationOf(() =>
        parseRequestedBrand({ logo: 'data:image/png;base64,AAAA' }, 'u1'),
      ),
    ).toEqual({
      field: 'brand.logo',
      messageKey: 'errors.provisioning.brandDataUriRejected',
    });
    expect(
      violationOf(() =>
        parseRequestedBrand(
          { palette: { ...manualPalette('#2563eb'), source: ' DATA:text/html,x' } },
          'u1',
        ),
      ).messageKey,
    ).toBe('errors.provisioning.brandDataUriRejected');
  });

  it('refuses unknown keys (the object is strict)', () => {
    expect(
      violationOf(() =>
        parseRequestedBrand({ logoUrl: 'https://example.com/a.png' }, 'u1'),
      ).messageKey,
    ).toBe('errors.provisioning.brandUnknownField');
  });

  it('refuses a colour that is neither hex nor a triplet', () => {
    expect(
      violationOf(() => parseRequestedBrand({ palette: manualPalette('blue') }, 'u1')),
    ).toEqual({
      field: 'brand.palette.seeds.primary',
      messageKey: 'validation:invalidColor',
    });
    expect(
      violationOf(() =>
        parseRequestedBrand({ palette: manualPalette('url(javascript:x)') }, 'u1'),
      ).messageKey,
    ).toBe('validation:invalidColor');
  });

  it('refuses an invalid palette enum through the shared palette authority', () => {
    expect(
      violationOf(() =>
        parseRequestedBrand(
          { palette: { ...manualPalette('#2563eb'), status: 'whatever' } },
          'u1',
        ),
      ).field,
    ).toBe('brand.palette.status');
  });

  it('reads stored values defensively and never surfaces a data: logo url', () => {
    expect(readRequestedBrand(null)).toBeNull();
    expect(readRequestedBrand('x')).toBeNull();
    expect(
      readRequestedBrand({
        logo: {
          status: 'attached',
          mediaAssetId: 'a',
          url: 'data:image/png;base64,AAAA',
        },
      }),
    ).toBeNull();
    expect(
      readRequestedBrand({
        logo: {
          status: 'attached',
          mediaAssetId: 'a',
          url: '/api/v1/public/media/x.png',
        },
      })?.logo,
    ).toEqual({
      status: 'attached',
      mediaAssetId: 'a',
      url: '/api/v1/public/media/x.png',
    });
  });
});
