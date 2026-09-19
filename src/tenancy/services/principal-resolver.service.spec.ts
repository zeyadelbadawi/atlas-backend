/**
 * P64 Phase 1 — the derived principal kind (AD-4). No stored flag: the
 * answer is computed from the three membership facts, and a person may be
 * staff in one place and a learner in another.
 */
import { PrincipalResolverService } from './principal-resolver.service';

interface Facts {
  isPlatformOwner?: boolean;
  memberships?: unknown[];
  staff?: { academyId: string; role: string; status: string }[];
  academies?: Record<string, unknown>[];
}

function build(facts: Facts) {
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ isPlatformOwner: !!facts.isPlatformOwner }),
    },
    $queryRaw: jest.fn().mockResolvedValue(
      (facts.academies ?? []).map((row) => ({
        academy_id: row.academy_id ?? 'academy-1',
        academy_name: row.academy_name ?? 'Academy One',
        academy_slug: row.academy_slug ?? 'academy-one',
        academy_status: 'active',
        membership_status: row.membership_status ?? 'active',
        blocked_at: row.blocked_at ?? null,
        joined_at: new Date(),
        custom_hostname: row.custom_hostname ?? null,
        custom_domain_live: row.custom_domain_live ?? false,
        subdomain: row.subdomain ?? 'academy-one',
        subdomain_full_host: row.subdomain_full_host ?? 'academy-one.atlas.test',
      })),
    ),
  };
  /*
    `resolve` does all four reads inside ONE transaction (see the service's
    own comment on why), so the transaction client the work receives must
    carry `user.findUnique` and `$queryRaw` — not just the repositories.
    The fake hands back the same object the service would get from Prisma.
  */
  const tenancyContextService = {
    runInUserContext: jest.fn((_userId: string, work: (tx: unknown) => unknown) =>
      work(prisma),
    ),
  };
  const membershipsRepository = {
    findAllForUser: jest.fn().mockResolvedValue(facts.memberships ?? []),
  };
  const academyStudentsRepository = { findForUserInAcademy: jest.fn() };
  const academyStaffRepository = {
    findAllForUser: jest.fn().mockResolvedValue(facts.staff ?? []),
  };
  const configService = { get: jest.fn().mockReturnValue({ baseDomain: 'atlas.test' }) };

  const service = new PrincipalResolverService(
    prisma as never,
    tenancyContextService as never,
    membershipsRepository as never,
    academyStudentsRepository as never,
    academyStaffRepository as never,
    configService as never,
  );
  return { service, prisma };
}

describe('PrincipalResolverService (P64 Phase 1)', () => {
  it('a platform owner outranks every other fact', async () => {
    const { service } = build({
      isPlatformOwner: true,
      academies: [{}],
      memberships: [{ role: 'owner' }],
    });
    const principal = await service.resolve('user-1');
    expect(principal.kind).toBe('platform_owner');
    expect(principal.isPlatformOwner).toBe(true);
  });

  it('an organization membership makes a person staff even with student rows', async () => {
    const { service } = build({ memberships: [{ role: 'manager' }], academies: [{}] });
    const principal = await service.resolve('user-1');
    expect(principal.kind).toBe('staff');
    expect(principal.academies).toHaveLength(1);
  });

  it('an ACTIVE academy staff row alone is enough to be staff', async () => {
    const { service } = build({
      staff: [{ academyId: 'a1', role: 'instructor', status: 'active' }],
    });
    expect((await service.resolve('user-1')).kind).toBe('staff');
  });

  it('an inactive academy staff row is not a staff fact', async () => {
    const { service } = build({
      staff: [{ academyId: 'a1', role: 'instructor', status: 'inactive' }],
      academies: [{}],
    });
    const principal = await service.resolve('user-1');
    expect(principal.kind).toBe('learner');
    expect(principal.academyStaff).toHaveLength(0);
  });

  it('student rows and nothing else make a learner', async () => {
    const { service } = build({ academies: [{}] });
    expect((await service.resolve('user-1')).kind).toBe('learner');
  });

  it('no fact at all is `unaffiliated`, never a learner', async () => {
    const { service } = build({});
    expect((await service.resolve('user-1')).kind).toBe('unaffiliated');
  });

  it('resolves the academy public host: a live custom domain wins over the subdomain', async () => {
    const { service } = build({
      academies: [
        {
          academy_id: 'a1',
          custom_hostname: 'learn.example.com',
          custom_domain_live: true,
          subdomain_full_host: 'a1.atlas.test',
        },
      ],
    });
    const principal = await service.resolve('user-1');
    expect(principal.academies[0].host).toBe('learn.example.com');
  });

  it('falls back to the Atlas subdomain when the custom domain is not live', async () => {
    const { service } = build({
      academies: [
        {
          academy_id: 'a1',
          custom_hostname: 'learn.example.com',
          custom_domain_live: false,
          subdomain_full_host: 'a1.atlas.test',
        },
      ],
    });
    expect((await service.resolve('user-1')).academies[0].host).toBe('a1.atlas.test');
  });

  it('reports a blocked membership so the caller can explain the refusal', async () => {
    const { service } = build({ academies: [{ blocked_at: new Date() }] });
    expect((await service.resolve('user-1')).academies[0].blocked).toBe(true);
  });
});
