/**
 * F-8 / F-11 — the public Contact form's acceptance rules and the public
 * student count's population. Every repository is a fake: what is pinned
 * here is the service's own decision-making (published-site gate, honeypot
 * discard, which count method is asked), not RLS or SQL.
 */
import { PublicWebsiteService } from './public-website.service';
import type { SubmitContactMessageDto } from '../dto/submit-contact-message.dto';

const ACADEMY_ID = 'academy-1';
const ORGANIZATION_ID = 'org-1';

interface BuildOptions {
  published?: boolean;
  servingEligible?: boolean;
  pages?: unknown[];
  faqEntries?: unknown[];
  testimonialEntries?: unknown[];
  cachedPages?: unknown;
  libraryRevision?: number;
  /** What `resolve_public_hostname` answers (`resolveHostname`). */
  resolution?: Record<string, unknown> | null;
  baseDomain?: string;
}

function build(options: BuildOptions = {}) {
  const {
    published = true,
    servingEligible = true,
    pages = [],
    faqEntries = [],
    testimonialEntries = [],
    cachedPages,
    libraryRevision = 0,
    resolution = null,
    baseDomain,
  } = options;
  const tx = { marker: 'tx' };

  const tenancyContextService = {
    runInTenantContext: jest.fn(
      async (_organizationId: string, work: (client: unknown) => unknown) => work(tx),
    ),
  };
  const publicHostnameResolutionRepository = {
    resolveAcademyOrganization: jest.fn(async () => ORGANIZATION_ID),
    resolve: jest.fn(async () => resolution),
    resolvePresentation: jest.fn(async () => null),
  };
  const academiesRepository = { findById: jest.fn(async () => ({ faviconUrl: null })) };
  const platformDomainService = {
    getEffectiveBaseDomain: jest.fn(async () => ({ baseDomain })),
  };
  const websiteConfigurationRepository = {
    findPublishedByAcademyId: jest.fn(async () =>
      published ? { id: 'config-1', status: 'published', configVersion: 1 } : null,
    ),
  };
  const cacheService = {
    getHostnameResolution: jest.fn(async () => undefined),
    setHostnameResolution: jest.fn(async () => undefined),
    getServingEligibility: jest.fn(async () => undefined),
    setServingEligibility: jest.fn(async () => undefined),
    getPages: jest.fn(async () => cachedPages),
    setPages: jest.fn(async () => undefined),
  };
  const websitePagesRepository = { findAllPublished: jest.fn(async () => pages) };
  const websiteFaqEntriesRepository = {
    findPublishedVisibleByIds: jest.fn(async () => faqEntries),
  };
  const websiteTestimonialEntriesRepository = {
    findPublishedVisibleByIds: jest.fn(async () => testimonialEntries),
  };
  const libraryRevisionService = { get: jest.fn(async () => libraryRevision) };
  const contactSubmissionsRepository = {
    create: jest.fn(async (_tx: unknown, data: Record<string, string>) => ({
      id: 'submission-1',
      ...data,
      status: 'new',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })),
  };
  const academyStudentsRepository = {
    countActiveForAcademy: jest.fn(async () => 7),
  };
  const academyMembersRepository = { countByRoleAndStatus: jest.fn(async () => 2) };
  const coursesRepository = { countPublished: jest.fn(async () => 3) };
  const subscriptionAccessService = {
    isServingEligible: jest.fn(async () => servingEligible),
  };
  let outboxSeq = 0;
  const communicationService = {
    emit: jest.fn(async () => ({ created: true, outboxId: `outbox-${++outboxSeq}` })),
    enqueueAfterCommit: jest.fn(async () => undefined),
  };
  const staffRecipients = {
    moderators: jest.fn(async () => ['manager-1', 'owner-1']),
    organizationOwners: jest.fn(async () => ['owner-1']),
  };

  const service = new PublicWebsiteService(
    tenancyContextService as never,
    publicHostnameResolutionRepository as never,
    websiteConfigurationRepository as never,
    websitePagesRepository as never,
    cacheService as never,
    academyStudentsRepository as never,
    academyMembersRepository as never,
    contactSubmissionsRepository as never,
    coursesRepository as never,
    {} as never, // courseReviewsRepository
    {} as never, // courseSectionsRepository
    academiesRepository as never,
    subscriptionAccessService as never,
    platformDomainService as never,
    {} as never, // metrics
    {} as never, // courseCategoriesRepository
    websiteFaqEntriesRepository as never,
    websiteTestimonialEntriesRepository as never,
    libraryRevisionService as never,
    communicationService as never,
    staffRecipients as never,
  );

  return {
    service,
    tx,
    publicHostnameResolutionRepository,
    websiteConfigurationRepository,
    contactSubmissionsRepository,
    academyStudentsRepository,
    academyMembersRepository,
    cacheService,
    websitePagesRepository,
    websiteFaqEntriesRepository,
    websiteTestimonialEntriesRepository,
    communicationService,
    staffRecipients,
  };
}

const message: SubmitContactMessageDto = {
  name: 'Visitor',
  email: 'visitor@example.com',
  message: 'Hello there',
};

describe('PublicWebsiteService.submitContactMessage', () => {
  it('stores and returns the submission when the website is published', async () => {
    const { service, tx, websiteConfigurationRepository, contactSubmissionsRepository } =
      build();

    const response = await service.submitContactMessage(ACADEMY_ID, message);

    expect(websiteConfigurationRepository.findPublishedByAcademyId).toHaveBeenCalledWith(
      tx,
      ACADEMY_ID,
    );
    expect(contactSubmissionsRepository.create).toHaveBeenCalledWith(tx, {
      academyId: ACADEMY_ID,
      name: 'Visitor',
      email: 'visitor@example.com',
      message: 'Hello there',
    });
    expect(response).toEqual({
      id: 'submission-1',
      academyId: ACADEMY_ID,
      name: 'Visitor',
      email: 'visitor@example.com',
      message: 'Hello there',
      status: 'new',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('notifies each website manager once, in the insert transaction, without the visitor details (B0-WEB-05)', async () => {
    const { service, tx, communicationService, staffRecipients } = build();

    await service.submitContactMessage(ACADEMY_ID, message);

    expect(staffRecipients.moderators).toHaveBeenCalledWith(tx, ACADEMY_ID);
    expect(staffRecipients.organizationOwners).toHaveBeenCalledWith(tx, ACADEMY_ID);
    expect(communicationService.emit).toHaveBeenCalledTimes(2);
    for (const recipientUserId of ['manager-1', 'owner-1']) {
      expect(communicationService.emit).toHaveBeenCalledWith(tx, {
        key: 'academy.contact_submission.received',
        recipientUserId,
        organizationId: ORGANIZATION_ID,
        academyId: ACADEMY_ID,
        entity: { type: 'contact_submission', id: 'submission-1' },
        values: { academyId: ACADEMY_ID },
      });
    }
    expect(communicationService.enqueueAfterCommit.mock.calls).toEqual([
      ['outbox-1'],
      ['outbox-2'],
    ]);
  });

  it('notifies nobody for a honeypot hit or an unpublished website', async () => {
    const honeypot = build();
    await honeypot.service.submitContactMessage(ACADEMY_ID, {
      ...message,
      company: 'Spam Corp',
    });
    expect(honeypot.communicationService.emit).not.toHaveBeenCalled();

    const unpublished = build({ published: false });
    await unpublished.service.submitContactMessage(ACADEMY_ID, message);
    expect(unpublished.communicationService.emit).not.toHaveBeenCalled();
  });

  it('returns null (→ 404) and stores nothing when the website is not published', async () => {
    const { service, contactSubmissionsRepository } = build({ published: false });

    await expect(service.submitContactMessage(ACADEMY_ID, message)).resolves.toBeNull();
    expect(contactSubmissionsRepository.create).not.toHaveBeenCalled();
  });

  it('returns null and stores nothing when the Academy may not be served', async () => {
    const { service, websiteConfigurationRepository, contactSubmissionsRepository } =
      build({
        servingEligible: false,
      });

    await expect(service.submitContactMessage(ACADEMY_ID, message)).resolves.toBeNull();
    expect(
      websiteConfigurationRepository.findPublishedByAcademyId,
    ).not.toHaveBeenCalled();
    expect(contactSubmissionsRepository.create).not.toHaveBeenCalled();
  });

  it('silently discards a filled honeypot but answers with a success-shaped response', async () => {
    const { service, contactSubmissionsRepository } = build();

    const response = await service.submitContactMessage(ACADEMY_ID, {
      ...message,
      company: 'Spam Corp',
    });

    expect(contactSubmissionsRepository.create).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      academyId: ACADEMY_ID,
      name: 'Visitor',
      email: 'visitor@example.com',
      message: 'Hello there',
      status: 'new',
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response!.createdAt))).toBe(false);
  });

  it('still 404s an unpublished website even when the honeypot is filled', async () => {
    const { service, contactSubmissionsRepository } = build({ published: false });

    await expect(
      service.submitContactMessage(ACADEMY_ID, { ...message, company: 'Spam Corp' }),
    ).resolves.toBeNull();
    expect(contactSubmissionsRepository.create).not.toHaveBeenCalled();
  });

  it.each(['', '   '])(
    'treats an empty honeypot (%p) as a real submission',
    async (company) => {
      const { service, contactSubmissionsRepository } = build();

      const response = await service.submitContactMessage(ACADEMY_ID, {
        ...message,
        company,
      });

      expect(contactSubmissionsRepository.create).toHaveBeenCalledTimes(1);
      expect(response?.id).toBe('submission-1');
    },
  );
});

describe('PublicWebsiteService.getPublicStatistics', () => {
  it('counts only active students, mirroring the active-instructor count', async () => {
    const { service, tx, academyStudentsRepository, academyMembersRepository } = build();

    await expect(service.getPublicStatistics(ACADEMY_ID)).resolves.toEqual({
      courses: 3,
      students: 7,
      instructors: 2,
    });
    expect(academyStudentsRepository.countActiveForAcademy).toHaveBeenCalledWith(
      tx,
      ACADEMY_ID,
    );
    expect(academyMembersRepository.countByRoleAndStatus).toHaveBeenCalledWith(
      tx,
      ACADEMY_ID,
      'instructor',
    );
  });
});

describe('PublicWebsiteService.getPublishedPages — content library', () => {
  const at = new Date('2026-01-01T00:00:00.000Z');
  const page = (sections: unknown[]) => ({
    id: 'page-1',
    academyId: ACADEMY_ID,
    title: { en: 'Home' },
    slug: 'home',
    type: 'home',
    sections,
    seoTitle: null,
    seoDescription: null,
    visible: true,
    order: 0,
    createdAt: at,
    updatedAt: at,
  });
  const faqRow = (id: string) => ({
    id,
    academyId: ACADEMY_ID,
    question: { en: `Q ${id}` },
    answer: { en: `A ${id}` },
    order: 3,
    visible: true,
    status: 'published',
    createdAt: at,
    updatedAt: at,
  });

  it('expands referenced FAQ entries in the Owner’s order, public fields only, dropping unresolved ids', async () => {
    const { service, tx, websiteFaqEntriesRepository } = build({
      pages: [
        page([
          {
            id: 's1',
            type: 'faq',
            config: { items: [], libraryEntryIds: ['f2', 'gone', 'f1', 'f2'] },
          },
          { id: 's2', type: 'hero', config: { title: { en: 'Hi' } } },
        ]),
      ],
      // The repository is the published/visible/Academy gate: 'gone' is
      // what it does not return (a draft, hidden, archived or foreign id).
      faqEntries: [faqRow('f1'), faqRow('f2')],
    });

    const [result] = (await service.getPublishedPages(ACADEMY_ID))!;

    expect(websiteFaqEntriesRepository.findPublishedVisibleByIds).toHaveBeenCalledWith(
      tx,
      ACADEMY_ID,
      ['f2', 'gone', 'f1'],
    );
    const [faq, hero] = result.sections as { config: Record<string, unknown> }[];
    expect(faq.config.libraryEntries).toEqual([
      { id: 'f2', question: { en: 'Q f2' }, answer: { en: 'A f2' } },
      { id: 'f1', question: { en: 'Q f1' }, answer: { en: 'A f1' } },
    ]);
    expect(faq.config.libraryEntryIds).toEqual(['f2', 'gone', 'f1', 'f2']);
    expect(hero.config).not.toHaveProperty('libraryEntries');
  });

  it('projects testimonials to quote/author/role/avatar and omits absent optional fields', async () => {
    const { service } = build({
      pages: [
        page([
          {
            id: 's1',
            type: 'testimonials',
            config: { items: [], libraryEntryIds: ['t1', 't2'] },
          },
        ]),
      ],
      testimonialEntries: [
        {
          id: 't1',
          academyId: ACADEMY_ID,
          quote: { en: 'Great' },
          authorName: 'Lina',
          authorRole: { en: 'Student' },
          avatar: 'https://cdn.example/a.png',
          order: 0,
          visible: true,
          status: 'published',
          createdAt: at,
          updatedAt: at,
        },
        {
          id: 't2',
          academyId: ACADEMY_ID,
          quote: { en: 'Good' },
          authorName: 'Omar',
          authorRole: null,
          avatar: null,
          order: 1,
          visible: true,
          status: 'published',
          createdAt: at,
          updatedAt: at,
        },
      ],
    });

    const [result] = (await service.getPublishedPages(ACADEMY_ID))!;
    const [section] = result.sections as { config: Record<string, unknown> }[];
    expect(section.config.libraryEntries).toEqual([
      {
        id: 't1',
        quote: { en: 'Great' },
        authorName: 'Lina',
        authorRole: { en: 'Student' },
        avatar: 'https://cdn.example/a.png',
      },
      { id: 't2', quote: { en: 'Good' }, authorName: 'Omar' },
    ]);
  });

  it('never sends a sample result or schedule row to visitors (CMS phase 3d)', async () => {
    const { service, cacheService } = build({
      pages: [
        page([
          {
            id: 'results-1',
            type: 'results',
            config: {
              title: { en: 'Our top students', ar: '' },
              items: [
                {
                  id: 'sample-1',
                  studentName: 'Sample',
                  result: { en: '99%', ar: '' },
                  sample: true,
                },
                {
                  id: 'real-1',
                  studentName: 'Mariam',
                  result: { en: '98%', ar: '' },
                  top: true,
                },
              ],
            },
          },
          {
            id: 'schedule-1',
            type: 'schedule',
            config: {
              title: { en: 'Timetable', ar: '' },
              items: [
                {
                  id: 'row-1',
                  day: 'sat',
                  start: '16:00',
                  end: '17:00',
                  title: { en: 'Math', ar: '' },
                  sample: true,
                },
              ],
            },
          },
        ]),
      ],
    });

    const [result] = (await service.getPublishedPages(ACADEMY_ID))!;
    const [results, schedule] = result.sections as {
      config: { items: { id: string }[] };
    }[];
    expect(results.config.items.map((item) => item.id)).toEqual(['real-1']);
    expect(schedule.config.items).toEqual([]);
    // What is cached is the stripped payload, not the stored one.
    expect(JSON.stringify(cacheService.setPages.mock.calls[0])).not.toContain('sample');
  });

  it('never sends a sample video review to visitors (CMS phase 3d, batch D)', async () => {
    const { service, cacheService } = build({
      pages: [
        page([
          {
            id: 'reviews-1',
            type: 'videoTestimonials',
            config: {
              title: { en: 'Hear it from our students', ar: '' },
              items: [
                {
                  id: 'starter-1',
                  videoId: '',
                  name: 'Starter parent',
                  role: { en: 'Parent', ar: '' },
                  sample: true,
                },
                {
                  id: 'real-1',
                  videoId: 'dQw4w9WgXcQ',
                  name: 'Mona',
                  role: { en: 'Parent', ar: '' },
                },
              ],
            },
          },
        ]),
      ],
    });

    const [result] = (await service.getPublishedPages(ACADEMY_ID))!;
    const [reviews] = result.sections as { config: { items: { id: string }[] } }[];
    expect(reviews.config.items.map((item) => item.id)).toEqual(['real-1']);
    expect(JSON.stringify(cacheService.setPages.mock.calls[0])).not.toContain(
      'Starter parent',
    );
  });

  it('caches under the Academy’s library revision, and a hit skips the database', async () => {
    const { service, cacheService, websitePagesRepository } = build({
      pages: [page([])],
      libraryRevision: 4,
    });
    await service.getPublishedPages(ACADEMY_ID);
    expect(cacheService.getPages).toHaveBeenCalledWith(ACADEMY_ID, 1, 4);
    expect(cacheService.setPages).toHaveBeenCalledWith(
      ACADEMY_ID,
      1,
      4,
      expect.any(Array),
    );

    const hit = build({ cachedPages: ['cached'], libraryRevision: 4 });
    await expect(hit.service.getPublishedPages(ACADEMY_ID)).resolves.toEqual(['cached']);
    expect(hit.websitePagesRepository.findAllPublished).not.toHaveBeenCalled();
    expect(websitePagesRepository.findAllPublished).toHaveBeenCalledTimes(1);
  });

  it('does not query the library when no section references it', async () => {
    const { service, websiteFaqEntriesRepository } = build({
      pages: [page([{ id: 's1', type: 'faq', config: { items: [] } }])],
    });
    const [result] = (await service.getPublishedPages(ACADEMY_ID))!;
    expect(websiteFaqEntriesRepository.findPublishedVisibleByIds).toHaveBeenCalledWith(
      expect.anything(),
      ACADEMY_ID,
      [],
    );
    expect((result.sections[0] as { config: object }).config).not.toHaveProperty(
      'libraryEntries',
    );
  });
});

describe('PublicWebsiteService.resolveHostname — an old address after a slug change', () => {
  const BASE = 'atlas.example';
  const academyRow = {
    academyId: ACADEMY_ID,
    organizationId: ORGANIZATION_ID,
    academyName: 'Nour Academy',
    academySlug: 'nour-new',
    academyLogoUrl: null,
    customHostname: null,
    subdomain: 'nour-new',
    subdomainFullHost: `nour-new.${BASE}`,
  };

  it('answers an old label with the academy and a redirect to its canonical host', async () => {
    const { service, publicHostnameResolutionRepository, cacheService } = build({
      baseDomain: BASE,
      resolution: { ...academyRow, matchedAlias: true },
    });

    const response = await service.resolveHostname(`nour-old.${BASE}`);

    expect(publicHostnameResolutionRepository.resolve).toHaveBeenCalledWith(
      `nour-old.${BASE}`,
      'nour-old',
    );
    expect(response).toMatchObject({
      academyId: ACADEMY_ID,
      academySlug: 'nour-new',
      canonicalHost: `nour-new.${BASE}`,
      redirectHost: `nour-new.${BASE}`,
    });
    // Cached under the old host only, with the redirect in it.
    expect(cacheService.setHostnameResolution).toHaveBeenCalledWith(
      `nour-old.${BASE}`,
      expect.objectContaining({ redirectHost: `nour-new.${BASE}` }),
    );
  });

  it('redirects an old label to the connected custom domain when that is canonical', async () => {
    const { service } = build({
      baseDomain: BASE,
      resolution: {
        ...academyRow,
        customHostname: 'learn.nour.example',
        matchedAlias: true,
      },
    });

    const response = await service.resolveHostname(`nour-old.${BASE}`);

    expect(response?.redirectHost).toBe('learn.nour.example');
  });

  it('never redirects the live address', async () => {
    const { service } = build({
      baseDomain: BASE,
      resolution: { ...academyRow, matchedAlias: false },
    });

    const response = await service.resolveHostname(`nour-new.${BASE}`);

    expect(response).not.toHaveProperty('redirectHost');
    expect(response?.canonicalHost).toBe(`nour-new.${BASE}`);
  });

  it('serves an old label without a redirect when no canonical host is known', async () => {
    // No base domain and no stored full host (local development): there is
    // nowhere to send the visitor, so the academy is served as before.
    const { service } = build({
      resolution: { ...academyRow, subdomainFullHost: null, matchedAlias: true },
    });

    const response = await service.resolveHostname('nour-old');

    expect(response?.academyId).toBe(ACADEMY_ID);
    expect(response).not.toHaveProperty('redirectHost');
  });
});
