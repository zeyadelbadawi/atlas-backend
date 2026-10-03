/**
 * P3 — a library write must reach the public site on the next read, not
 * after the pages cache's TTL. The pages cache keys on the Academy's
 * library revision; these pin that every committed write bumps it, that a
 * refused write does not, and that the revision degrades to 0 (TTL-bound
 * staleness) rather than failing a public read when Redis is down.
 */
import { WebsiteContentService } from './website-content.service';
import { WebsiteLibraryRevisionService } from './website-library-revision.service';

const ACADEMY_ID = 'academy-1';
const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const at = new Date('2026-01-01T00:00:00.000Z');

function build(role: string | null = 'owner') {
  const tx = {};
  const tenancyContextService = {
    runInTenantAndUserContext: jest.fn(
      async (_o: string, _u: string, work: (client: unknown) => unknown) => work(tx),
    ),
  };
  const faqRow = {
    id: 'f1',
    academyId: ACADEMY_ID,
    question: { en: 'Q', ar: 'س' },
    answer: { en: 'A', ar: 'ج' },
    order: 0,
    visible: true,
    status: 'draft',
    createdAt: at,
    updatedAt: at,
  };
  const testimonialRow = {
    id: 't1',
    academyId: ACADEMY_ID,
    quote: { en: 'Q', ar: 'س' },
    authorName: 'Lina',
    authorRole: null,
    avatar: null,
    order: 0,
    visible: true,
    status: 'draft',
    createdAt: at,
    updatedAt: at,
  };
  const repo = <T>(row: T) => ({
    findById: jest.fn(async () => row),
    nextOrder: jest.fn(async () => 1),
    create: jest.fn(async () => row),
    update: jest.fn(async () => row),
  });
  const faqRepo = repo(faqRow);
  const testimonialRepo = repo(testimonialRow);
  const academyMembersRepository = {
    findForUserInAcademy: jest.fn(async () => (role ? { role } : null)),
  };
  const libraryRevisionService = { bump: jest.fn(async () => undefined) };
  const auditLogWriterService = { record: jest.fn(async () => undefined) };
  const service = new WebsiteContentService(
    tenancyContextService as never,
    faqRepo as never,
    testimonialRepo as never,
    academyMembersRepository as never,
    libraryRevisionService as never,
    auditLogWriterService as never,
  );
  return { service, libraryRevisionService };
}

const faq = { question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } };
const testimonial = { quote: { en: 'Q', ar: 'س' }, authorName: 'Lina' };

describe('WebsiteContentService — library revision', () => {
  const writes: [string, (s: WebsiteContentService) => Promise<unknown>][] = [
    [
      'createFaqEntry',
      (s) => s.createFaqEntry(ACADEMY_ID, ORG_ID, USER_ID, faq as never),
    ],
    [
      'updateFaqEntry',
      (s) =>
        s.updateFaqEntry(ACADEMY_ID, ORG_ID, USER_ID, 'f1', { visible: false } as never),
    ],
    ['publishFaqEntry', (s) => s.publishFaqEntry(ACADEMY_ID, ORG_ID, USER_ID, 'f1')],
    ['archiveFaqEntry', (s) => s.archiveFaqEntry(ACADEMY_ID, ORG_ID, USER_ID, 'f1')],
    [
      'createTestimonialEntry',
      (s) => s.createTestimonialEntry(ACADEMY_ID, ORG_ID, USER_ID, testimonial as never),
    ],
    [
      'updateTestimonialEntry',
      (s) =>
        s.updateTestimonialEntry(ACADEMY_ID, ORG_ID, USER_ID, 't1', {
          visible: false,
        } as never),
    ],
    [
      'publishTestimonialEntry',
      (s) => s.publishTestimonialEntry(ACADEMY_ID, ORG_ID, USER_ID, 't1'),
    ],
    [
      'archiveTestimonialEntry',
      (s) => s.archiveTestimonialEntry(ACADEMY_ID, ORG_ID, USER_ID, 't1'),
    ],
  ];

  it.each(writes)(
    '%s bumps the Academy’s revision once, after the write',
    async (_name, write) => {
      const { service, libraryRevisionService } = build();
      await write(service);
      expect(libraryRevisionService.bump).toHaveBeenCalledTimes(1);
      expect(libraryRevisionService.bump).toHaveBeenCalledWith(ACADEMY_ID);
    },
  );

  it.each(writes)('%s refused (Instructor) does not bump', async (_name, write) => {
    const { service, libraryRevisionService } = build('instructor');
    await expect(write(service)).rejects.toThrow();
    expect(libraryRevisionService.bump).not.toHaveBeenCalled();
  });
});

describe('WebsiteLibraryRevisionService', () => {
  const service = (client: object) =>
    new WebsiteLibraryRevisionService({ getClient: () => client } as never);

  it('reads 0 before any write and the counter afterwards', async () => {
    await expect(service({ get: async () => null }).get(ACADEMY_ID)).resolves.toBe(0);
    await expect(service({ get: async () => '3' }).get(ACADEMY_ID)).resolves.toBe(3);
  });

  it('increments the per-Academy key', async () => {
    const incr = jest.fn(async () => 1);
    await service({ incr }).bump(ACADEMY_ID);
    expect(incr).toHaveBeenCalledWith(`public:library-rev:v1:${ACADEMY_ID}`);
  });

  it('degrades to 0 / no-op when Redis fails, never throwing into a request', async () => {
    const broken = {
      get: async () => {
        throw new Error('down');
      },
      incr: async () => {
        throw new Error('down');
      },
    };
    await expect(service(broken).get(ACADEMY_ID)).resolves.toBe(0);
    await expect(service(broken).bump(ACADEMY_ID)).resolves.toBeUndefined();
  });
});
