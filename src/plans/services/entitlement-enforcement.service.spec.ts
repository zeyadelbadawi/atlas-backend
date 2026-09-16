/**
 * The zero-delta rule, and the arithmetic around it.
 *
 * WHAT THIS PROTECTS. `EnrollmentsService` passes `additionalAmount = 0`
 * when the student is already counted, so a second or third course
 * enrollment costs no extra seat. That intent lived only in the arithmetic
 * `used + additional > limit`, and the arithmetic lost it the moment `used`
 * exceeded `limit`: `+ 0` stopped mattering and the already-counted student
 * was refused exactly like a brand-new one.
 *
 * `used > limit` is not reachable by consuming — consumption is refused at
 * the boundary. It is reached when the CEILING MOVES DOWN: a Platform Owner
 * reduces the catalog limit under a customer who is already above the new
 * number. Refusing zero-cost work in that state removes something the
 * customer already has, rather than declining to sell them more.
 *
 * These are unit tests on purpose: the five cases are a property of the
 * arithmetic, and asserting them here pins the boundary exactly, at every
 * combination, without depending on which fixtures a database happens to
 * hold. The real end-to-end proof against PostgreSQL lives in
 * `p61-granted-entitlements.e2e-spec.ts`.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EntitlementEnforcementService } from './entitlement-enforcement.service';
import { EntitlementService } from './entitlement.service';
import type { Prisma } from '@prisma/client';
import type { PlanResourceLimits } from '../dto/entitlement.types';

const FULL_LIMITS = (students: number | 'unlimited'): PlanResourceLimits => ({
  academies: 100,
  students,
  instructors: 100,
  staff: 100,
  courses: 100,
  generalStorage: 100,
  videoStorage: 100,
  recordedSessions: 100,
});

/**
 * Builds the service with only the collaborators these paths actually
 * touch. `used` is what the live count returns; `limit` is what the
 * subscription resolves to.
 */
function buildService(options: {
  readonly used: number;
  readonly limit: number | 'unlimited';
  readonly status?: string;
  readonly grantedLimits?: PlanResourceLimits | null;
}) {
  const subscription = {
    organizationId: 'org-1',
    status: options.status ?? 'active',
    trialEndsAt: null,
    grantedLimits: options.grantedLimits ?? null,
    plan: {
      key: 'growth',
      limits: FULL_LIMITS(options.limit),
      features: {},
    },
  };

  const computeLiveCounts = jest.fn().mockResolvedValue({
    academies: 0,
    instructors: 0,
    staff: 0,
    courses: 0,
    students: options.used,
    generalStorageGb: 0,
    videoStorageGb: 0,
  });

  const service = new EntitlementEnforcementService(
    { findByOrganizationId: jest.fn().mockResolvedValue(subscription) } as never,
    { findManyForOrganization: jest.fn().mockResolvedValue([]) } as never,
    new EntitlementService(),
    { computeLiveCounts } as never,
  );

  return { service, computeLiveCounts };
}

/**
 * `$queryRaw` is the `FOR UPDATE` serialization point the positive-delta
 * path takes before counting. A no-op here: these tests assert the
 * arithmetic, and the lock's real behaviour is only observable against a
 * real database (`P61-GRANT-018` does that with four concurrent requests).
 */
const tx = { $queryRaw: jest.fn().mockResolvedValue([]) } as unknown as Prisma.TransactionClient;

describe('EntitlementEnforcementService.assertWithinLimit — the zero-delta rule', () => {
  it('1. used === limit and additionalAmount === 0 → allowed', async () => {
    const { service } = buildService({ used: 5, limit: 5 });
    await expect(
      service.assertWithinLimit(tx, 'org-1', 'students', 0),
    ).resolves.toBeUndefined();
  });

  it('2. used > limit and additionalAmount === 0 → allowed', async () => {
    // The case the catalog reduction creates, and the one that used to
    // throw: 30 students against a limit cut to 20, enrolling an
    // already-counted student into another course.
    const { service } = buildService({ used: 30, limit: 20 });
    await expect(
      service.assertWithinLimit(tx, 'org-1', 'students', 0),
    ).resolves.toBeUndefined();
  });

  it('3. used === limit and additionalAmount > 0 → blocked', async () => {
    const { service } = buildService({ used: 5, limit: 5 });
    await expect(service.assertWithinLimit(tx, 'org-1', 'students', 1)).rejects.toThrow(
      ConflictException,
    );
  });

  it('4. used > limit and additionalAmount > 0 → blocked', async () => {
    const { service } = buildService({ used: 30, limit: 20 });
    await expect(service.assertWithinLimit(tx, 'org-1', 'students', 1)).rejects.toThrow(
      ConflictException,
    );
  });

  it('5. normal under-limit consumption still works', async () => {
    const { service } = buildService({ used: 10, limit: 20 });
    await expect(
      service.assertWithinLimit(tx, 'org-1', 'students', 1),
    ).resolves.toBeUndefined();
    // And right up to the boundary.
    const atBoundary = buildService({ used: 19, limit: 20 });
    await expect(
      atBoundary.service.assertWithinLimit(tx, 'org-1', 'students', 1),
    ).resolves.toBeUndefined();
  });

  it('carries the real numbers in the rejection, so the UI can explain it', async () => {
    const { service } = buildService({ used: 30, limit: 20 });
    await expect(
      service.assertWithinLimit(tx, 'org-1', 'students', 1),
    ).rejects.toMatchObject({
      response: {
        code: 'ENTITLEMENT_LIMIT_REACHED',
        values: { limitKey: 'students', limit: 20, used: 31 },
      },
    });
  });

  it('still refuses a zero-delta call when the SUBSCRIPTION is inactive', async () => {
    // Zero-delta exempts a write from the CAPACITY check, never from the
    // "is there an active entitlement at all" check. An expired tenant may
    // not write regardless of how little it consumes.
    for (const status of ['expired', 'cancelled', 'no_plan', 'trial_expired']) {
      const { service } = buildService({ used: 1, limit: 100, status });
      await expect(service.assertWithinLimit(tx, 'org-1', 'students', 0)).rejects.toThrow(
        ForbiddenException,
      );
    }
  });

  it('does not spend a live count query when nothing is consumed', async () => {
    // The early return is also why a zero-delta call is cheap: the count
    // could not change the answer.
    const { service, computeLiveCounts } = buildService({ used: 30, limit: 20 });
    await service.assertWithinLimit(tx, 'org-1', 'students', 0);
    expect(computeLiveCounts).not.toHaveBeenCalled();
  });

  it('treats unlimited as unlimited for both zero and positive deltas', async () => {
    const { service } = buildService({ used: 9999, limit: 'unlimited' });
    await expect(
      service.assertWithinLimit(tx, 'org-1', 'students', 0),
    ).resolves.toBeUndefined();
    await expect(
      service.assertWithinLimit(tx, 'org-1', 'students', 500),
    ).resolves.toBeUndefined();
  });
});
