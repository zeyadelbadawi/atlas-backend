import { fillBlankEnglish } from './localized-text.util';

describe('fillBlankEnglish (B0-WEB-02, Arabic-default public responses)', () => {
  it('fills a blank English side from Arabic, at any depth', () => {
    expect(
      fillBlankEnglish({
        title: { en: '', ar: 'أهلاً' },
        items: [
          { label: { en: '  ', ar: 'الدورات' } },
          { label: { en: 'FAQ', ar: 'أسئلة' } },
        ],
        count: 3,
        image: null,
        slug: 'home',
      }),
    ).toEqual({
      title: { en: 'أهلاً', ar: 'أهلاً' },
      items: [
        { label: { en: 'الدورات', ar: 'الدورات' } },
        { label: { en: 'FAQ', ar: 'أسئلة' } },
      ],
      count: 3,
      image: null,
      slug: 'home',
    });
  });

  it('leaves everything else alone', () => {
    const untouched = [
      { en: 'Home', ar: '' },
      { en: '', ar: '' },
      { en: '', ar: 'x', extra: 'not a LocalizedText' },
      { en: 1, ar: 'x' },
      'plain',
    ];
    expect(fillBlankEnglish(untouched)).toEqual(untouched);
  });
});
