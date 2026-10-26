/**
 * B3 — SiteAnnouncementsService and its public controller: optimistic
 * concurrency, activation rules, plain text and URL rules, the event
 * counter (unknown ids ignored, failures swallowed, throttled), the
 * marketing payload, and dashboard audience filtering.
 */
import 'reflect-metadata';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { SiteAnnouncement } from '@prisma/client';
import {
  ANNOUNCEMENT_STALE_CODE,
  SiteAnnouncementsService,
  normalizeContent,
  toPublicAnnouncement,
} from './site-announcements.service';
import {
  ANNOUNCEMENT_EVENTS_THROTTLE,
  PublicSiteAnnouncementsController,
} from '../controllers/public-site-announcements.controller';

const PO = 'po-user';
const NOW = new Date('2026-10-26T12:00:00.000Z');

let n = 0;
function harness() {
  const rows = new Map<string, SiteAnnouncement>();
  const tx = {
    siteAnnouncement: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => ({
        ...rows.get(where.id)!,
      })),
      findMany: jest.fn(async () => [...rows.values()]),
      count: jest.fn(async () => rows.size),
      create: jest.fn(async ({ data }: { data: Partial<SiteAnnouncement> }) => {
        n += 1;
        const row = {
          id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          version: 1,
          views: 0,
          clicks: 0,
          dismissals: 0,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        } as SiteAnnouncement;
        rows.set(row.id, row);
        return { ...row };
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = { ...rows.get(where.id)! } as Record<string, unknown>;
          for (const [key, value] of Object.entries(data)) {
            row[key] =
              value && typeof value === 'object' && 'increment' in (value as object)
                ? (row[key] as number) + 1
                : value;
          }
          rows.set(where.id, row as unknown as SiteAnnouncement);
          return { ...(row as unknown as SiteAnnouncement) };
        },
      ),
      delete: jest.fn(async ({ where }: { where: { id: string } }) =>
        rows.delete(where.id),
      ),
    },
    user: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('record_site_announcement_event'))
        return [{ counted: 1 }];
      return rows.has(values[0] as string) ? [{ id: values[0] }] : [];
    }),
  };
  const tenancy = {
    runInUserContext: jest.fn(async (_u: string, work: (t: typeof tx) => unknown) =>
      work(tx),
    ),
    runWithoutContext: jest.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
  };
  const audit = { write: jest.fn() };
  const service = new SiteAnnouncementsService(tenancy as never, audit as never);
  return { service, rows, tx, tenancy, audit };
}

const banner = {
  name: 'Launch banner',
  surface: 'marketing_banner' as const,
  content: { en: { body: 'Atlas is live.' }, ar: { body: 'أطلس متاح الآن.' } },
};

describe('SiteAnnouncementsService', () => {
  it('creates a draft and resets fields that mean nothing on the surface', async () => {
    const h = harness();
    const created = await h.service.create(
      PO,
      {
        ...banner,
        imageUrl: '/x.webp',
        popupDelaySeconds: 30,
        audience: 'academy_staff',
      } as never,
      NOW,
    );
    expect(created).toMatchObject({
      status: 'draft',
      live: false,
      imageUrl: null,
      popupDelaySeconds: 0,
      audience: 'all',
      stats: { views: 0, clicks: 0, dismissals: 0 },
    });
  });

  it('refuses a stale version with 409 SITE_ANNOUNCEMENT_STALE', async () => {
    const h = harness();
    const created = await h.service.create(PO, banner as never, NOW);
    await h.service.update(PO, created.id, { version: 1, priority: 10 } as never, NOW);
    await expect(
      h.service.update(PO, created.id, { version: 1, priority: 20 } as never, NOW),
    ).rejects.toMatchObject({
      response: {
        messageKey: 'errors.siteAnnouncements.stale',
        code: ANNOUNCEMENT_STALE_CODE,
      },
    });
    await expect(h.service.activate(PO, created.id, 1, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('activation needs content (422), and a pop-up needs a title in each language', async () => {
    const h = harness();
    const empty = await h.service.create(
      PO,
      { name: 'Empty', surface: 'marketing_banner' } as never,
      NOW,
    );
    await expect(h.service.activate(PO, empty.id, 1, NOW)).rejects.toMatchObject({
      response: { messageKey: 'errors.siteAnnouncements.contentRequired' },
    });
    const popup = await h.service.create(
      PO,
      {
        name: 'Popup',
        surface: 'marketing_popup',
        content: { en: { title: 'Hi', body: 'Body' }, ar: { body: 'نص' } },
      } as never,
      NOW,
    );
    await expect(h.service.activate(PO, popup.id, 1, NOW)).rejects.toMatchObject({
      response: { messageKey: 'errors.siteAnnouncements.popupTitleRequired' },
    });
  });

  it('an active announcement cannot be edited into an invalid state', async () => {
    const h = harness();
    const created = await h.service.create(PO, banner as never, NOW);
    const active = await h.service.activate(PO, created.id, 1, NOW);
    expect(active).toMatchObject({ status: 'active', live: true, version: 2 });
    await expect(
      h.service.update(
        PO,
        created.id,
        { version: 2, content: { en: null, ar: null } } as never,
        NOW,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('a button label needs a URL on every save', async () => {
    const h = harness();
    await expect(
      h.service.create(
        PO,
        { ...banner, content: { en: { body: 'b', ctaLabel: 'Start' } } } as never,
        NOW,
      ),
    ).rejects.toMatchObject({
      response: { messageKey: 'errors.siteAnnouncements.ctaUrlRequired' },
    });
  });

  it('refuses an end before the start', async () => {
    const h = harness();
    await expect(
      h.service.create(
        PO,
        {
          ...banner,
          startsAt: '2026-11-02T00:00:00Z',
          endsAt: '2026-11-01T00:00:00Z',
        } as never,
        NOW,
      ),
    ).rejects.toMatchObject({
      response: { messageKey: 'errors.siteAnnouncements.invalidWindow' },
    });
  });

  it('deletes only drafts and archived announcements', async () => {
    const h = harness();
    const created = await h.service.create(PO, banner as never, NOW);
    await h.service.activate(PO, created.id, 1, NOW);
    await expect(h.service.remove(PO, created.id)).rejects.toMatchObject({
      response: { messageKey: 'errors.siteAnnouncements.deleteNotAllowed' },
    });
    await h.service.archive(PO, created.id, 2, NOW);
    await h.service.remove(PO, created.id);
    expect(h.rows.size).toBe(0);
  });

  it('marketing: one pop-up (highest priority), up to two banners, without internal fields', async () => {
    const h = harness();
    for (const [surface, priority] of [
      ['marketing_popup', 10],
      ['marketing_popup', 70],
      ['marketing_banner', 5],
      ['marketing_banner', 6],
      ['marketing_banner', 7],
    ] as const) {
      const created = await h.service.create(
        PO,
        {
          name: `${surface}-${priority}`,
          surface,
          priority,
          content: { en: { title: 'T', body: 'B' } },
        } as never,
        NOW,
      );
      await h.service.activate(PO, created.id, 1, NOW);
    }
    const page = await h.service.marketing('en', '/pricing', NOW);
    expect(page.banners).toHaveLength(2);
    expect(page.popup).not.toBeNull();
    const popupRow = [...h.rows.values()].find((row) => row.id === page.popup!.id)!;
    expect(popupRow.priority).toBe(70);
    for (const key of [
      'name',
      'views',
      'clicks',
      'dismissals',
      'status',
      'version',
      'audience',
      'pages',
    ]) {
      expect(page.popup).not.toHaveProperty(key);
    }
    expect(h.tenancy.runWithoutContext).toHaveBeenCalled();
  });

  it('dashboard: filtered by audience', async () => {
    const h = harness();
    for (const audience of ['all', 'organization_owners', 'academy_staff'] as const) {
      const created = await h.service.create(
        PO,
        {
          name: audience,
          surface: 'dashboard_banner',
          audience,
          content: { en: { body: audience } },
        } as never,
        NOW,
      );
      await h.service.activate(PO, created.id, 1, NOW);
    }
    const instructor = {
      userId: 'u1',
      isPlatformOwner: false,
      ownsAnOrganization: false,
      academyStaff: [{ academyId: 'a', role: 'instructor', status: 'active' }],
    };
    const bodies = (await h.service.dashboard(instructor, 'en', NOW)).banners
      .map((b) => b.body)
      .sort();
    expect(bodies).toEqual(['academy_staff', 'all']);
    const plain = {
      userId: 'u2',
      isPlatformOwner: false,
      ownsAnOrganization: false,
      academyStaff: [],
    };
    expect(
      (await h.service.dashboard(plain, 'en', NOW)).banners.map((b) => b.body),
    ).toEqual(['all']);
    expect(h.tenancy.runInUserContext).toHaveBeenLastCalledWith(
      'u2',
      expect.any(Function),
    );
  });

  it('recordEvent counts through the definer function and never throws', async () => {
    const h = harness();
    await expect(
      h.service.recordEvent('00000000-0000-4000-8000-000000000001', 'view'),
    ).resolves.toBe(true);
    h.tenancy.runWithoutContext.mockRejectedValueOnce(new Error('db down'));
    await expect(
      h.service.recordEvent('00000000-0000-4000-8000-000000000001', 'click'),
    ).resolves.toBe(false);
  });

  it('normalizeContent refuses markup and a title without a body', () => {
    expect(() => normalizeContent({ body: '<script>alert(1)</script>' })).toThrow();
    expect(() => normalizeContent({ title: 'x', body: '' })).toThrow(
      UnprocessableEntityException,
    );
    expect(normalizeContent({ body: '  2 < 3 and 5 > 4  ' })).toEqual({
      title: null,
      body: '2 < 3 and 5 > 4',
      ctaLabel: null,
    });
  });

  it('toPublicAnnouncement skips a missing language and hides a banner image', () => {
    const row = {
      id: 'x',
      surface: 'marketing_banner',
      tone: 'promo',
      titleEn: null,
      bodyEn: 'B',
      ctaLabelEn: null,
      titleAr: null,
      bodyAr: null,
      ctaLabelAr: null,
      ctaUrl: null,
      imageUrl: '/i.webp',
      dismissible: true,
      popupDelaySeconds: 0,
      popupFrequency: 'once',
      updatedAt: NOW,
    } as unknown as SiteAnnouncement;
    expect(toPublicAnnouncement(row, 'ar')).toBeNull();
    expect(toPublicAnnouncement(row, 'en')?.imageUrl).toBeNull();
  });
});

describe('PublicSiteAnnouncementsController events', () => {
  it('ignores malformed ids silently (no counting attempt)', async () => {
    const service = { recordEvent: jest.fn() };
    const controller = new PublicSiteAnnouncementsController(service as never);
    await expect(
      controller.event('not-a-uuid', { type: 'view' }),
    ).resolves.toBeUndefined();
    await expect(
      controller.event("1' OR 1=1", { type: 'click' }),
    ).resolves.toBeUndefined();
    expect(service.recordEvent).not.toHaveBeenCalled();
    await controller.event('00000000-0000-4000-8000-00000000000A', { type: 'dismiss' });
    expect(service.recordEvent).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-00000000000a',
      'dismiss',
    );
  });

  it('is throttled per client address at 60 a minute', () => {
    const handler = PublicSiteAnnouncementsController.prototype.event;
    const keys = Reflect.getMetadataKeys(handler) as string[];
    const limitKey = keys.find(
      (key) => String(key).includes('LIMIT') && String(key).endsWith('default'),
    );
    const ttlKey = keys.find(
      (key) => String(key).includes('TTL') && String(key).endsWith('default'),
    );
    expect(limitKey && Reflect.getMetadata(limitKey, handler)).toBe(60);
    expect(ttlKey && Reflect.getMetadata(ttlKey, handler)).toBe(60_000);
    expect(ANNOUNCEMENT_EVENTS_THROTTLE.getTracker).toBeDefined();
  });
});
