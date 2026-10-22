import { collectSampleContent, stripSampleContent } from './sample-content.util';

const testimonials = (items: unknown[]) => ({
  id: 'ts',
  type: 'testimonials',
  enabled: true,
  config: { title: { en: 'Said', ar: '' }, items },
});
const real = { id: 'r', quote: { en: 'Real', ar: '' }, authorName: 'R' };
const sample = {
  id: 's',
  quote: { en: 'Sample', ar: '' },
  authorName: 'S',
  sample: true,
};

describe('sample social proof (plan §D.4)', () => {
  it('strips only sample testimonials, keeping real ones and every other section untouched', () => {
    const hero = { id: 'h', type: 'hero', config: { title: { en: 'Hi', ar: '' } } };
    const section = testimonials([real, sample, { ...real, id: 'r2', sample: false }]);
    const sections: unknown[] = [hero, section];
    const stripped = stripSampleContent(sections);
    expect(stripped[0]).toBe(hero);
    expect(
      (stripped[1] as { config: { items: { id: string }[] } }).config.items.map(
        (i) => i.id,
      ),
    ).toEqual(['r', 'r2']);
    // The input is not mutated.
    expect(section.config.items).toHaveLength(3);
  });

  it('leaves a testimonials section with only samples empty (the renderer hides it)', () => {
    const [section] = stripSampleContent([testimonials([sample])]);
    expect((section as { config: { items: unknown[] } }).config.items).toEqual([]);
  });

  it('lists every page/section still holding samples, in order', () => {
    const pages = [
      { id: 'p1', title: 'Home', sections: [testimonials([sample, sample, real])] },
      { id: 'p2', title: 'About', sections: [testimonials([real])] },
    ];
    expect(collectSampleContent(pages)).toEqual([
      {
        pageId: 'p1',
        pageTitle: 'Home',
        sectionId: 'ts',
        sectionType: 'testimonials',
        sampleItems: 2,
      },
    ]);
  });

  it('strips sample results and schedule rows too (CMS phase 3d), keeping real ones', () => {
    const results = {
      id: 'rs',
      type: 'results',
      config: {
        title: { en: 'Top students', ar: '' },
        items: [
          { id: 'real', studentName: 'Real', result: { en: '97%', ar: '' } },
          { id: 'fake', studentName: 'S', result: { en: '99%', ar: '' }, sample: true },
        ],
      },
    };
    const schedule = {
      id: 'sc',
      type: 'schedule',
      config: {
        title: { en: 'Timetable', ar: '' },
        items: [
          { id: 'row-sample', day: 'sat', start: '16:00', end: '17:00', sample: true },
          { id: 'row-real', day: 'sun', start: '16:00', end: '17:00' },
        ],
      },
    };
    const [strippedResults, strippedSchedule] = stripSampleContent([
      results,
      schedule,
    ]) as {
      config: { items: { id: string }[] };
    }[];
    expect(strippedResults.config.items.map((i) => i.id)).toEqual(['real']);
    expect(strippedSchedule.config.items.map((i) => i.id)).toEqual(['row-real']);
    expect(
      collectSampleContent([{ id: 'p', title: 'Home', sections: [results, schedule] }]),
    ).toEqual([
      {
        pageId: 'p',
        pageTitle: 'Home',
        sectionId: 'rs',
        sectionType: 'results',
        sampleItems: 1,
      },
      {
        pageId: 'p',
        pageTitle: 'Home',
        sectionId: 'sc',
        sectionType: 'schedule',
        sampleItems: 1,
      },
    ]);
  });

  it('leaves a `sample` key on any other section type alone', () => {
    const logos = {
      id: 'lg',
      type: 'logos',
      config: { items: [{ id: 'l', sample: true }] },
    };
    expect(stripSampleContent([logos])[0]).toBe(logos);
  });

  it('ignores malformed data instead of failing', () => {
    expect(
      stripSampleContent([
        null,
        { type: 'testimonials' },
        { type: 'testimonials', config: { items: 'x' } },
      ]),
    ).toHaveLength(3);
    expect(collectSampleContent([{ id: 'p', title: 'P', sections: [null] }])).toEqual([]);
  });
});
