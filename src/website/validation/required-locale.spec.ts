/**
 * B0-WEB-02 — which language a required bilingual field must fill follows
 * the site's default language: English on an English-default site (every
 * site before this, and the default), Arabic on an Arabic-default one.
 */
import {
  heroSectionSchema,
  localizedRequired,
  sectionInstanceArraySchema,
  withRequiredLocale,
} from './section-config.schemas';
import { websiteNavigationSchema } from './website-config.schemas';

const label = localizedRequired(20);

describe('localizedRequired — English-default (unchanged)', () => {
  it('requires English and lets Arabic be empty or absent', () => {
    expect(label.safeParse({ en: 'Home', ar: '' }).success).toBe(true);
    expect(label.safeParse({ en: 'Home' })).toEqual({
      success: true,
      data: { en: 'Home', ar: '' },
    });
    const missing = label.safeParse({ en: '', ar: 'الرئيسية' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]).toMatchObject({
      path: ['en'],
      message: 'validation:required',
    });
  });

  it('is the same outside and inside withRequiredLocale("en")', () => {
    for (const value of [{ en: '', ar: 'x' }, { en: 'x' }, 'legacy', { ar: 'x' }]) {
      expect(withRequiredLocale('en', () => label.safeParse(value))).toEqual(
        label.safeParse(value),
      );
    }
  });
});

describe('localizedRequired — Arabic-default', () => {
  const parse = (value: unknown) =>
    withRequiredLocale('ar', () => label.safeParse(value));

  it('requires Arabic and lets English be empty or absent', () => {
    expect(parse({ en: '', ar: 'الرئيسية' })).toEqual({
      success: true,
      data: { en: '', ar: 'الرئيسية' },
    });
    expect(parse({ ar: 'الرئيسية' })).toEqual({
      success: true,
      data: { en: '', ar: 'الرئيسية' },
    });
    const missing = parse({ en: 'Home', ar: '' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]).toMatchObject({
      path: ['ar'],
      message: 'validation:required',
    });
  });

  it('keeps the length limit on both sides', () => {
    expect(parse({ en: 'x'.repeat(21), ar: 'ع' }).success).toBe(false);
    expect(parse({ en: '', ar: 'ع'.repeat(21) }).success).toBe(false);
  });

  it('applies through nested section and navigation schemas', () => {
    const hero = { title: { en: '', ar: 'أهلاً' } };
    expect(heroSectionSchema.safeParse(hero).success).toBe(false);
    expect(
      withRequiredLocale('ar', () => heroSectionSchema.safeParse(hero)).success,
    ).toBe(true);
    const page = [
      {
        id: 's1',
        type: 'hero',
        enabled: true,
        visibility: { desktop: true, tablet: true, mobile: true },
        config: { title: { en: 'Welcome', ar: '' } },
      },
    ];
    expect(sectionInstanceArraySchema.safeParse(page).success).toBe(true);
    expect(
      withRequiredLocale('ar', () => sectionInstanceArraySchema.safeParse(page)).success,
    ).toBe(false);
    const nav = [{ id: 'n1', label: { en: '', ar: 'الدورات' }, pageId: 'p1', order: 0 }];
    expect(websiteNavigationSchema.safeParse(nav).success).toBe(false);
    expect(
      withRequiredLocale('ar', () => websiteNavigationSchema.safeParse(nav)).success,
    ).toBe(true);
  });

  it('restores English afterwards, even when the parse throws', () => {
    expect(() =>
      withRequiredLocale('ar', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(label.safeParse({ en: '', ar: 'x' }).success).toBe(false);
    expect(label.safeParse({ en: 'x', ar: '' }).success).toBe(true);
  });
});
