import {
  ATTRIBUTION_VALUE_MAX,
  looksLikePersonalData,
  sanitizeAttribution,
} from './attribution';

describe('sanitizeAttribution (B0-ANL-04)', () => {
  it('keeps clean UTM values, the referrer host and the template', () => {
    expect(
      sanitizeAttribution({
        utmSource: 'facebook',
        utmMedium: 'paid_social',
        utmCampaign: 'launch-20261015',
        utmTerm: 'lms egypt',
        utmContent: 'video-a',
        referrerDomain: 'www.Example.com',
        landingTemplate: 'Pricing',
      }),
    ).toEqual({
      utmSource: 'facebook',
      utmMedium: 'paid_social',
      utmCampaign: 'launch-20261015',
      utmTerm: 'lms egypt',
      utmContent: 'video-a',
      referrerDomain: 'www.example.com',
      landingTemplate: 'pricing',
    });
  });

  it('stores nothing for an untagged visit, even with a landing template', () => {
    expect(sanitizeAttribution(undefined)).toBeNull();
    expect(sanitizeAttribution({})).toBeNull();
    expect(sanitizeAttribution({ landingTemplate: 'home' })).toBeNull();
    expect(sanitizeAttribution({ utmSource: '   ' })).toBeNull();
  });

  it('drops email- and phone-like values, plain or percent-encoded', () => {
    expect(
      sanitizeAttribution({
        utmSource: 'newsletter',
        utmCampaign: 'person@example.test',
        utmContent: 'person%40example.test',
        utmTerm: '+20 100 000 0000',
        utmMedium: '01000000000',
      }),
    ).toEqual({ utmSource: 'newsletter' });
  });

  it('keeps only the host of a full referrer URL and drops non-hosts', () => {
    expect(
      sanitizeAttribution({ referrerDomain: 'https://news.example.org/a?b=c' }),
    ).toEqual({ referrerDomain: 'news.example.org' });
    expect(sanitizeAttribution({ referrerDomain: 'not a host' })).toBeNull();
    expect(sanitizeAttribution({ referrerDomain: 'localhost' })).toBeNull();
  });

  it('caps values, strips control characters and rejects odd templates', () => {
    const stored = sanitizeAttribution({
      utmSource: `a\u0000b${'x'.repeat(300)}`,
      landingTemplate: '../etc/passwd',
    });
    expect(stored?.utmSource).toHaveLength(ATTRIBUTION_VALUE_MAX);
    expect(stored?.utmSource?.startsWith('abx')).toBe(true);
    expect(stored?.landingTemplate).toBeUndefined();
  });

  it('never stores half of an emoji the length cap cut through', () => {
    const stored = sanitizeAttribution({
      utmSource: `${'x'.repeat(ATTRIBUTION_VALUE_MAX - 1)}😀`,
      utmCampaign: 'launch\uD83D',
    });
    expect(stored?.utmSource).toBe('x'.repeat(ATTRIBUTION_VALUE_MAX - 1));
    expect(stored?.utmCampaign).toBe('launch');
    expect(JSON.stringify(stored)).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('recognises personal data without flagging dates or short codes', () => {
    expect(looksLikePersonalData('someone@mail.test')).toBe(true);
    expect(looksLikePersonalData('(010) 0000-0000')).toBe(true);
    expect(looksLikePersonalData('2026-10-15')).toBe(false);
    expect(looksLikePersonalData('cohort-12')).toBe(false);
  });
});
