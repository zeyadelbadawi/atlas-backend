/**
 * B3 — site announcements' pure rules: the live window, page matching,
 * what a page gets (two banners, ONE pop-up), dashboard audiences and
 * what activation needs.
 */
import type { SiteAnnouncement } from '@prisma/client';
import {
  activationProblem,
  audienceAllows,
  contentFor,
  isLive,
  matchesPage,
  normalizeMarketingPath,
  selectForMarketingPage,
} from './site-announcement-rules';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let n = 0;
function ann(overrides: Partial<SiteAnnouncement> = {}): SiteAnnouncement {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: `a${n}`,
    surface: 'marketing_banner',
    status: 'active',
    startsAt: null,
    endsAt: null,
    tone: 'info',
    titleEn: 'Title',
    bodyEn: 'Body',
    ctaLabelEn: null,
    titleAr: 'عنوان',
    bodyAr: 'نص',
    ctaLabelAr: null,
    ctaUrl: null,
    imageUrl: null,
    pages: [],
    dismissible: true,
    popupDelaySeconds: 0,
    popupFrequency: 'once',
    audience: 'all',
    priority: 0,
    version: 1,
    views: 0,
    clicks: 0,
    dismissals: 0,
    createdByUserId: 'po',
    updatedByUserId: 'po',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('isLive', () => {
  it('needs status active', () => {
    expect(isLive(ann({ status: 'draft' }), NOW)).toBe(false);
    expect(isLive(ann({ status: 'archived' }), NOW)).toBe(false);
    expect(isLive(ann(), NOW)).toBe(true);
  });

  it('respects the [startsAt, endsAt) window', () => {
    expect(isLive(ann({ startsAt: new Date(NOW.getTime() + HOUR) }), NOW)).toBe(false);
    expect(isLive(ann({ startsAt: NOW }), NOW)).toBe(true);
    expect(isLive(ann({ endsAt: NOW }), NOW)).toBe(false);
    expect(isLive(ann({ endsAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(true);
    expect(
      isLive(
        ann({
          startsAt: new Date(NOW.getTime() - HOUR),
          endsAt: new Date(NOW.getTime() + HOUR),
        }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe('pages', () => {
  it('normalises the visitor path', () => {
    expect(normalizeMarketingPath(undefined)).toBe('/');
    expect(normalizeMarketingPath('/ar/pricing/')).toBe('/pricing');
    expect(normalizeMarketingPath('/ar')).toBe('/');
    expect(normalizeMarketingPath('/en/blog/a-post?utm=x#top')).toBe('/blog/a-post');
    expect(normalizeMarketingPath('Pricing')).toBe('/pricing');
    expect(normalizeMarketingPath('/arabic-courses')).toBe('/arabic-courses');
  });

  it('[] is every page; a prefix matches itself and below; "/" is the home page only', () => {
    expect(matchesPage([], '/anything')).toBe(true);
    expect(matchesPage(['/blog'], '/blog')).toBe(true);
    expect(matchesPage(['/blog'], '/blog/a-post')).toBe(true);
    expect(matchesPage(['/blog'], '/blogger')).toBe(false);
    expect(matchesPage(['/'], '/')).toBe(true);
    expect(matchesPage(['/'], '/pricing')).toBe(false);
    expect(matchesPage(['/pricing', '/founding'], '/founding')).toBe(true);
  });
});

describe('selectForMarketingPage', () => {
  it('returns at most ONE pop-up — the highest priority', () => {
    const low = ann({ surface: 'marketing_popup', priority: 10 });
    const high = ann({ surface: 'marketing_popup', priority: 90 });
    const mid = ann({ surface: 'marketing_popup', priority: 50 });
    const { popup } = selectForMarketingPage([low, high, mid], 'en', '/', NOW);
    expect(popup?.id).toBe(high.id);
  });

  it('breaks priority ties by the most recent edit', () => {
    const older = ann({
      surface: 'marketing_popup',
      priority: 5,
      updatedAt: new Date(NOW.getTime() - HOUR),
    });
    const newer = ann({ surface: 'marketing_popup', priority: 5 });
    expect(selectForMarketingPage([older, newer], 'en', '/', NOW).popup?.id).toBe(
      newer.id,
    );
  });

  it('returns up to two banners, highest priority first', () => {
    const rows = [1, 80, 40, 60].map((priority) => ann({ priority }));
    const { banners } = selectForMarketingPage(rows, 'en', '/', NOW);
    expect(banners.map((row) => row.priority)).toEqual([80, 60]);
  });

  it('skips what is not live, not for this page, or not in this language', () => {
    const rows = [
      ann({ status: 'draft', priority: 100 }),
      ann({ endsAt: new Date(NOW.getTime() - 1), priority: 99 }),
      ann({ pages: ['/pricing'], priority: 98 }),
      ann({ bodyAr: null, priority: 97 }),
      ann({ surface: 'dashboard_banner', priority: 96 }),
      ann({ priority: 1, name: 'shown' }),
    ];
    const { banners, popup } = selectForMarketingPage(rows, 'ar', '/blog', NOW);
    expect(banners.map((row) => row.name)).toEqual(['shown']);
    expect(popup).toBeNull();
  });
});

describe('audienceAllows (dashboard banner)', () => {
  const nobody = { isPlatformOwner: false, ownsAnOrganization: false, academyStaff: [] };
  const owner = { ...nobody, ownsAnOrganization: true };
  const instructor = {
    ...nobody,
    academyStaff: [{ academyId: 'a', role: 'instructor', status: 'active' }],
  };
  const staffOnly = {
    ...nobody,
    academyStaff: [{ academyId: 'a', role: 'staff', status: 'active' }],
  };
  const po = { ...nobody, isPlatformOwner: true };

  it('all: everybody', () => {
    for (const who of [nobody, owner, instructor, staffOnly, po]) {
      expect(audienceAllows('all', who)).toBe(true);
    }
  });

  it('organization_owners: owners (and the Platform Owner) only', () => {
    expect(audienceAllows('organization_owners', owner)).toBe(true);
    expect(audienceAllows('organization_owners', po)).toBe(true);
    expect(audienceAllows('organization_owners', instructor)).toBe(false);
    expect(audienceAllows('organization_owners', nobody)).toBe(false);
  });

  it('academy_staff: owner/administrator/manager/instructor of an academy, or an organization owner', () => {
    expect(audienceAllows('academy_staff', instructor)).toBe(true);
    expect(
      audienceAllows('academy_staff', {
        ...nobody,
        academyStaff: [{ academyId: 'a', role: 'manager', status: 'active' }],
      }),
    ).toBe(true);
    expect(audienceAllows('academy_staff', owner)).toBe(true);
    expect(audienceAllows('academy_staff', staffOnly)).toBe(false);
    expect(audienceAllows('academy_staff', nobody)).toBe(false);
  });
});

describe('content and activation', () => {
  it('a language is present when its body is set', () => {
    expect(contentFor(ann({ bodyAr: null }), 'ar')).toBeNull();
    expect(contentFor(ann({ titleEn: null }), 'en')).toEqual({
      title: null,
      body: 'Body',
      ctaLabel: null,
    });
  });

  it('activation needs a language, a pop-up title, and a URL for a button label', () => {
    expect(activationProblem(ann({ bodyEn: null, bodyAr: null }))).toBe(
      'contentRequired',
    );
    expect(activationProblem(ann({ surface: 'marketing_popup', titleAr: null }))).toBe(
      'popupTitleRequired',
    );
    expect(activationProblem(ann({ ctaLabelEn: 'Start' }))).toBe('ctaUrlRequired');
    expect(
      activationProblem(ann({ ctaLabelEn: 'Start', ctaUrl: '/pricing' })),
    ).toBeNull();
    expect(activationProblem(ann({ bodyAr: null, titleAr: null }))).toBeNull();
  });
});
