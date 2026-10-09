/**
 * The decisions `DeletionPlanService` makes about what a deletion means.
 *
 * WHAT THIS CAN AND CANNOT PROVE. Everything here runs against fake
 * transactions, so it pins the *reasoning* — which role a subject is,
 * which treatment each group of records gets, what is refused outright —
 * and nothing at all about RLS. Whether each count runs in a context that
 * can actually see its rows is a property of SQL policies, and a mocked
 * `tx` would happily return numbers for a query real Postgres would
 * filter to zero. That is the exact failure this service is written to
 * avoid, so it is pinned in `test/` against real Postgres instead, and
 * deliberately not claimed here.
 *
 * The treatment assertions matter more than they look: these strings are
 * what a person reads immediately before doing something irreversible.
 * Calling a retained financial record "destroyed", or a destroyed academy
 * "retained", would make the confirmation a lie, and it would be a lie
 * nothing else in the system would catch.
 */
import { DeletionPlanService } from './deletion-plan.service';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';

interface Fixture {
  readonly isPlatformOwner?: boolean;
  readonly status?: string;
  readonly missing?: boolean;
  readonly organizations?: { id: string; name: string }[];
  readonly academies?: { id: string; name: string }[];
  readonly courses?: number;
  readonly mediaAssets?: number;
  readonly mediaBytes?: bigint;
  readonly learners?: number;
  readonly enrollments?: number;
  readonly certificates?: number;
  readonly sessions?: number;
  readonly memberRoles?: string[];
  readonly studentships?: number;
  readonly instructorships?: number;
}

function build(fixture: Fixture) {
  const f = {
    organizations: [],
    academies: [],
    courses: 0,
    mediaAssets: 0,
    mediaBytes: 0n,
    learners: 0,
    enrollments: 0,
    certificates: 0,
    sessions: 0,
    memberRoles: [],
    studentships: 0,
    instructorships: 0,
    ...fixture,
  } as Required<Omit<Fixture, 'missing' | 'isPlatformOwner' | 'status'>> & Fixture;

  const tx = {
    organization: { findMany: async () => f.organizations },
    academy: { findMany: async () => f.academies },
    course: { count: async () => f.courses },
    mediaAsset: {
      count: async () => f.mediaAssets,
      aggregate: async () => ({ _sum: { sizeBytes: f.mediaBytes } }),
    },
    academyStudent: {
      count: async () => (f.academies.length > 0 ? f.learners : f.studentships),
    },
    enrollment: { count: async () => f.enrollments },
    certificate: { count: async () => f.certificates },
    refreshToken: { count: async () => f.sessions },
    academyMember: {
      findMany: async () => f.memberRoles.map((role) => ({ role })),
    },
    courseInstructor: { count: async () => f.instructorships },
    user: {
      findUnique: async () =>
        fixture.missing
          ? null
          : {
              id: 'u1',
              isPlatformOwner: fixture.isPlatformOwner ?? false,
              status: fixture.status ?? 'active',
            },
    },
  };

  // The context runners are pass-throughs here. What they would really do
  // — set `app.current_user_id` / `app.current_organization_id` — is the
  // part these tests explicitly do not cover.
  const tenancy = {
    runInUserContext: async (_id: string, work: (t: unknown) => unknown) => work(tx),
    runInTenantContext: async (_id: string, work: (t: unknown) => unknown) => work(tx),
  } as unknown as TenancyContextService;

  return new DeletionPlanService(tenancy);
}

/** The treatment recorded for `key`, or undefined when the line is absent. */
function treatmentOf(
  lines: readonly { key: string; treatment: string }[],
  key: string,
): string | undefined {
  return lines.find((line) => line.key === key)?.treatment;
}

describe('DeletionPlanService', () => {
  describe('accounts it refuses to plan for', () => {
    it('refuses a platform owner, and says why', async () => {
      const plan = await build({ isPlatformOwner: true }).buildForUser('u1');
      expect(plan.deletable).toBe(false);
      expect(plan.subjectRole).toBe('platform_owner');
      expect(plan.refusalKey).toBe('errors.auth.platformOwnerCannotSelfDelete');
      // No consequences are described, because none would follow.
      expect(plan.lines).toHaveLength(0);
    });

    it('reports an already-deleted account as deleted rather than as an error', async () => {
      const plan = await build({ status: 'deleted' }).buildForUser('u1');
      expect(plan.alreadyDeleted).toBe(true);
      expect(plan.deletable).toBe(false);
      expect(plan.refusalKey).toBeUndefined();
    });

    it('reports a missing account as not found', async () => {
      const plan = await build({ missing: true }).buildForUser('u1');
      expect(plan.deletable).toBe(false);
      expect(plan.refusalKey).toBe('errors.notFound');
    });
  });

  describe('what each group of records is promised', () => {
    it('tears down the tenant but keeps the organization and the money', async () => {
      const plan = await build({
        organizations: [{ id: 'o1', name: 'Northwind' }],
        academies: [{ id: 'a1', name: 'Northwind Academy' }],
        courses: 12,
        mediaAssets: 40,
        mediaBytes: 5_000n,
        learners: 130,
      }).buildForUser('u1');

      expect(plan.subjectRole).toBe('client_owner');
      expect(treatmentOf(plan.lines, 'academies')).toBe('destroy');
      expect(treatmentOf(plan.lines, 'courses')).toBe('destroy');
      expect(treatmentOf(plan.lines, 'mediaAssets')).toBe('destroy');
      // The row survives: it anchors billing and other people's records.
      expect(treatmentOf(plan.lines, 'organizations')).toBe('retain');
      // Learners keep their accounts; only their access to this tenant ends.
      expect(treatmentOf(plan.lines, 'affectedLearners')).toBe('revoke');
      expect(treatmentOf(plan.lines, 'financialRecords')).toBe('retain');
      expect(treatmentOf(plan.lines, 'auditRecords')).toBe('retain');
      // Anti-piracy evidence survives deletion (docs/FORENSIC_WATERMARK.md).
      expect(treatmentOf(plan.lines, 'forensicWatermarks')).toBe('retain');
    });

    it('tombstones a learner history instead of destroying it', async () => {
      const plan = await build({
        studentships: 2,
        enrollments: 7,
        certificates: 3,
      }).buildForUser('u1');

      expect(plan.subjectRole).toBe('student');
      // A paid-for course must not become a dead link.
      expect(treatmentOf(plan.lines, 'enrollments')).toBe('tombstone');
      // The issuance fact is the academy's; the holder's name is not.
      expect(treatmentOf(plan.lines, 'certificates')).toBe('deidentify');
    });

    it('always promises to de-identify the person and destroy their credentials', async () => {
      const plan = await build({}).buildForUser('u1');
      expect(treatmentOf(plan.lines, 'identity')).toBe('deidentify');
      expect(treatmentOf(plan.lines, 'credentials')).toBe('destroy');
    });
  });

  describe('the role the confirmation is framed around', () => {
    it('calls an owner who also studies a Client Owner, because that is the larger deletion', async () => {
      const plan = await build({
        organizations: [{ id: 'o1', name: 'Northwind' }],
        academies: [{ id: 'a1', name: 'A' }],
        studentships: 4,
        instructorships: 2,
      }).buildForUser('u1');
      expect(plan.subjectRole).toBe('client_owner');
    });

    it('distinguishes a manager from an instructor from a plain member', async () => {
      await expect(
        build({ memberRoles: ['manager'] }).buildForUser('u1'),
      ).resolves.toMatchObject({ subjectRole: 'manager' });
      await expect(
        build({ instructorships: 1 }).buildForUser('u1'),
      ).resolves.toMatchObject({ subjectRole: 'instructor' });
      await expect(build({}).buildForUser('u1')).resolves.toMatchObject({
        subjectRole: 'member',
      });
    });
  });

  describe('honesty of the summary itself', () => {
    it('omits groups that are empty, so nothing claims a consequence it does not have', async () => {
      const plan = await build({}).buildForUser('u1');
      expect(treatmentOf(plan.lines, 'academies')).toBeUndefined();
      expect(treatmentOf(plan.lines, 'enrollments')).toBeUndefined();
      // …but the two that are always true are still stated.
      expect(treatmentOf(plan.lines, 'identity')).toBe('deidentify');
    });

    it('never claims a consequence the account does not have', async () => {
      // Found in production, 26 Sep 2026: an account with no certificates
      // was shown "0 certificates keep their records without the holder's
      // name". The filter kept every `deidentify` line regardless of count,
      // to protect the always-true identity line — and caught `certificates`
      // with it. A dialog whose whole job is accuracy must not list a
      // consequence that will not happen.
      const plan = await build({ certificates: 0, enrollments: 0 }).buildForUser('u1');
      expect(treatmentOf(plan.lines, 'certificates')).toBeUndefined();
      expect(treatmentOf(plan.lines, 'enrollments')).toBeUndefined();
      // …while the always-true lines, which carry a real count of 1, stay.
      expect(treatmentOf(plan.lines, 'identity')).toBe('deidentify');
      expect(treatmentOf(plan.lines, 'financialRecords')).toBe('retain');
    });

    it('names only a handful of academies however many there are', async () => {
      const many = Array.from({ length: 9 }, (_, i) => ({
        id: `a${i}`,
        name: `Academy ${i}`,
      }));
      const plan = await build({
        organizations: [{ id: 'o1', name: 'Northwind' }],
        academies: many,
      }).buildForUser('u1');

      const academies = plan.lines.find((line) => line.key === 'academies');
      // The count stays truthful even though the names are capped.
      expect(academies?.count).toBe(9);
      expect(academies?.examples).toHaveLength(5);
    });
  });
});
