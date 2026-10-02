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
  } = options;
  const tx = { marker: 'tx' };

  const tenancyContextService = {
    runInTenantContext: jest.fn(
      async (_organizationId: string, work: (client: unknown) => unknown) => work(tx),
    ),
  };
  const publicHostnameResolutionRepository = {
    resolveAcademyOrganization: jest.fn(async () => ORGANIZATION_ID),
  };
  const websiteConfigurationRepository = {
    findPublishedByAcademyId: jest.fn(async () =>
      published ? { id: 'config-1', status: 'published', configVersion: 1 } : null,
    ),
  };
  const cacheService = {
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
    {} as never, // academiesRepository
    subscriptionAccessService as never,
    {} as never, // platformDomainService
    {} as never, // metrics
    {} as never, // courseCategoriesRepository
    websiteFaqEntriesRepository as never,
    websiteTestimonialEntriesRepository as never,
    libraryRevisionService as never,
  );

  return {
    service,
    tx,
    websiteConfigurationRepository,
    contactSubmissionsRepository,
    academyStudentsRepository,
    academyMembersRepository,
    cacheService,
    websitePagesRepository,
    websiteFaqEntriesRepository,
    websiteTestimonialEntriesRepository,
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
