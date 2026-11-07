import { academyShowsStudentCount } from './statistics-visibility.util';

const stats = (metrics: (string | undefined)[], enabled = true) => ({
  id: 's1',
  type: 'statistics',
  enabled,
  config: { items: metrics.map((metric, i) => ({ id: `i${i}`, metric })) },
});

describe('academyShowsStudentCount (learner count is public only where shown)', () => {
  it('is false with no pages, no statistics section, or no students item', () => {
    expect(academyShowsStudentCount([])).toBe(false);
    expect(
      academyShowsStudentCount([
        { sections: [{ type: 'hero', enabled: true, config: {} }] },
      ]),
    ).toBe(false);
    expect(
      academyShowsStudentCount([
        {
          sections: [stats(['courses', 'instructors', undefined])],
          publishedSections: null,
        },
      ]),
    ).toBe(false);
  });

  it('is true when an enabled statistics section shows students, in the draft or the published page', () => {
    expect(academyShowsStudentCount([{ sections: [stats(['students'])] }])).toBe(true);
    expect(
      academyShowsStudentCount([
        { sections: [], publishedSections: [stats(['courses', 'students'])] },
      ]),
    ).toBe(true);
  });

  it('ignores a disabled section and malformed JSON', () => {
    expect(academyShowsStudentCount([{ sections: [stats(['students'], false)] }])).toBe(
      false,
    );
    expect(
      academyShowsStudentCount([
        { sections: 'oops', publishedSections: [null, 3, { type: 'statistics' }] },
      ]),
    ).toBe(false);
  });
});
