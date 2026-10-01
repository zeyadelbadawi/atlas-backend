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

function build(options: { published?: boolean; servingEligible?: boolean } = {}) {
  const { published = true, servingEligible = true } = options;
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
  };
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
    {} as never, // websitePagesRepository
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
  );

  return {
    service,
    tx,
    websiteConfigurationRepository,
    contactSubmissionsRepository,
    academyStudentsRepository,
    academyMembersRepository,
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
