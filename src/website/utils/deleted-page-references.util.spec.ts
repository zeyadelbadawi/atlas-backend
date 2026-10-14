import { pruneDeletedPageReferences } from './deleted-page-references.util';

const GONE = 'page-gone';
const KEPT = 'page-kept';
const label = { en: 'x', ar: 'x' };

const chrome = () => ({
  navigation: [
    { id: 'n1', label, pageId: KEPT, order: 0 },
    { id: 'n2', label, pageId: GONE, order: 1 },
  ],
  header: { cta: { label, pageId: GONE }, authPages: { signIn: {} } },
  footer: {
    groups: [
      {
        id: 'g1',
        title: label,
        links: [
          { id: 'l1', label, pageId: GONE },
          { id: 'l2', label, url: 'https://example.com' },
        ],
      },
      { id: 'g2', title: label, links: [{ id: 'l3', label, pageId: KEPT }] },
    ],
    socialLinks: [
      { id: 's1', label, pageId: GONE },
      { id: 's2', label, platform: 'facebook', url: 'https://facebook.com/x' },
    ],
    copyrightText: label,
  },
});

describe('pruneDeletedPageReferences (B0-WEB-11)', () => {
  it('removes every menu entry, footer link and header CTA that targets the deleted page', () => {
    const pruned = pruneDeletedPageReferences(chrome(), GONE);
    expect(pruned.changed).toBe(true);
    expect(pruned.navigation).toEqual([{ id: 'n1', label, pageId: KEPT, order: 0 }]);
    expect(pruned.header).toEqual({ authPages: { signIn: {} } });
    expect(pruned.footer).toEqual({
      groups: [
        {
          id: 'g1',
          title: label,
          links: [{ id: 'l2', label, url: 'https://example.com' }],
        },
        { id: 'g2', title: label, links: [{ id: 'l3', label, pageId: KEPT }] },
      ],
      socialLinks: [
        { id: 's2', label, platform: 'facebook', url: 'https://facebook.com/x' },
      ],
      copyrightText: label,
    });
  });

  it('reports no change when nothing points at the page', () => {
    const input = chrome();
    const pruned = pruneDeletedPageReferences(input, 'unrelated');
    expect(pruned.changed).toBe(false);
    expect(pruned.navigation).toEqual(input.navigation);
    expect(pruned.header).toEqual(input.header);
    expect(pruned.footer).toEqual(input.footer);
  });

  it('passes unexpected shapes through untouched', () => {
    const pruned = pruneDeletedPageReferences(
      { navigation: null, header: 'x', footer: { groups: 'nope' } },
      GONE,
    );
    expect(pruned).toEqual({
      navigation: null,
      header: 'x',
      footer: { groups: 'nope' },
      changed: false,
    });
  });
});
