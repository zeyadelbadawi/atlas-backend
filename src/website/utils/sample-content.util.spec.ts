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
