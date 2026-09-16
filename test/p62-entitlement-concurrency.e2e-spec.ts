/**
 * P62 — concurrent entitlement consumption cannot exceed the limit
 * (P62-CONC-001..006).
 *
 * WHY THIS DOES NOT GO THROUGH THE PROVISIONING QUEUE. Academy creation is
 * reached through `ProvisioningOrchestratorService`, which runs on BullMQ.
 * A queue proves nothing about enforcement: whether two jobs overlap is
 * decided by worker concurrency and scheduling, so a green run might only
 * mean the jobs happened to run one after the other. These tests call the
 * one real creation path — `AcademiesService.create`, which the orchestrator
 * itself calls — concurrently and directly, so the overlap is guaranteed
 * rather than hoped for. Same service, same transaction, same RLS context,
 * same `EntitlementEnforcementService`; only the scheduler is removed.
 *
 * WHAT IS ACTUALLY BEING ASSERTED. Not "an error was returned" but the
 * mechanical outcome: after N concurrent attempts against a limit of L,
 * the database holds exactly min(N, L) academies. A check-then-insert race
 * shows up here as a row count, which no amount of error handling can fake.
 *
 * Remove the `FOR UPDATE` in `EntitlementEnforcementService.assertWithinLimit`
 * and `P62-CONC-001` fails with 2 academies against a limit of 1 — that is
 * the regression this file exists to hold shut.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { AcademiesService } from '../src/academy/services/academies.service';
import { EntitlementEnforcementService } from '../src/plans/services/entitlement-enforcement.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { seedAcademy, seedAcademyMember } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

const LIMITS = (overrides: Record<string, number | 'unlimited'> = {}) => ({
  academies: 100,
  students: 100,
  instructors: 100,
  staff: 100,
  courses: 100,
  generalStorage: 100,
  videoStorage: 100,
  recordedSessions: 10,
  ...overrides,
});

describe('P62 entitlement concurrency (e2e) — P62-CONC-001..006', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let academiesService: AcademiesService;
  let entitlement: EntitlementEnforcementService;
  let tenancy: TenancyContextService;

  const createdOrgIds: string[] = [];
  const createdPlanIds: string[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    // The very service the provisioning orchestrator calls.
    academiesService = app.get(AcademiesService);
    entitlement = app.get(EntitlementEnforcementService);
    tenancy = app.get(TenancyContextService);
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await admin.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    if (createdPlanIds.length > 0) {
      await admin.plan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { userId: signIn.body.user.id as string, token: signIn.body.accessToken as string };
  }

  async function seedTenant(label: string, limits: Record<string, number | 'unlimited'>) {
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    createdOrgIds.push(org.id);
    const plan = await seedPlan(admin, `${label}-plan`, { limits: LIMITS(limits) });
    createdPlanIds.push(plan.id);
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    return { owner, org };
  }

  /** Fires `count` genuinely concurrent academy creations. */
  async function createConcurrently(
    label: string,
    organizationId: string,
    userId: string,
    count: number,
  ) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const attempts = Array.from({ length: count }, (_, index) =>
      academiesService.create(userId, {
        organizationId,
        name: `${label} ${index}`,
        // Distinct slugs, so nothing is rejected as a slug conflict and
        // every rejection is genuinely the entitlement limit.
        slug: `${label}-${stamp}-${index}`,
      }),
    );
    return Promise.allSettled(attempts);
  }

  function reasons(results: PromiseSettledResult<unknown>[]): string[] {
    return results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => {
        const response = (r.reason as { getResponse?: () => unknown })?.getResponse?.();
        return (response as { code?: string })?.code ?? String(r.reason);
      });
  }

  it('P62-CONC-001 — limit 1, two concurrent creations: exactly one succeeds', async () => {
    const { owner, org } = await seedTenant('p62-one', { academies: 1 });

    const results = await createConcurrently('p62-one', org.id, owner.userId, 2);

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    expect(reasons(results)).toEqual(['ENTITLEMENT_LIMIT_REACHED']);

    // The mechanical proof: one row, not two.
    const academies = await admin.academy.count({ where: { organizationId: org.id } });
    expect(academies).toBe(1);
  }, 60_000);

  it('P62-CONC-002 — limit 1, five concurrent creations: still exactly one', async () => {
    // More contenders means more chances for two of them to interleave
    // between the count and the insert.
    const { owner, org } = await seedTenant('p62-five', { academies: 1 });

    const results = await createConcurrently('p62-five', org.id, owner.userId, 5);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(reasons(results)).toEqual(Array(4).fill('ENTITLEMENT_LIMIT_REACHED'));
    expect(await admin.academy.count({ where: { organizationId: org.id } })).toBe(1);
  }, 60_000);

  it('P62-CONC-003 — a HIGHER limit is filled exactly, never overshot', async () => {
    // Serialization must not be mistaken for "only one ever succeeds": a
    // limit of 3 under five contenders has to produce three.
    const { owner, org } = await seedTenant('p62-three', { academies: 3 });

    const results = await createConcurrently('p62-three', org.id, owner.userId, 5);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(3);
    expect(reasons(results)).toEqual(Array(2).fill('ENTITLEMENT_LIMIT_REACHED'));
    expect(await admin.academy.count({ where: { organizationId: org.id } })).toBe(3);
  }, 60_000);

  it('P62-CONC-004 — concurrency never blocks creations that are genuinely within limit', async () => {
    // The opposite failure: a lock that over-serializes and starts
    // refusing legitimate work.
    const { owner, org } = await seedTenant('p62-room', { academies: 5 });

    const results = await createConcurrently('p62-room', org.id, owner.userId, 3);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(3);
    expect(reasons(results)).toEqual([]);
    expect(await admin.academy.count({ where: { organizationId: org.id } })).toBe(3);
  }, 60_000);

  it('P62-CONC-005 — an unlimited academies grant is never serialized into a refusal', async () => {
    const { owner, org } = await seedTenant('p62-unlimited', { academies: 'unlimited' });

    const results = await createConcurrently('p62-unlimited', org.id, owner.userId, 4);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(4);
    expect(await admin.academy.count({ where: { organizationId: org.id } })).toBe(4);
  }, 60_000);

  it('P62-CONC-006 — the GRANT is what the concurrent check honours, not the catalog', async () => {
    // Ties the concurrency fix to P61: a customer granted 2 keeps 2 even
    // though the catalog now says 1, and concurrency still cannot overshoot
    // the granted number.
    const owner = await signUp('p62-grant-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p62-grant-org');
    createdOrgIds.push(org.id);
    const plan = await seedPlan(admin, 'p62-grant-plan', { limits: LIMITS({ academies: 1 }) });
    createdPlanIds.push(plan.id);
    await seedTenantSubscription(admin, org.id, plan.id, {
      status: 'active',
      grantedLimits: LIMITS({ academies: 2 }),
    });

    const results = await createConcurrently('p62-grant', org.id, owner.userId, 4);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
    expect(await admin.academy.count({ where: { organizationId: org.id } })).toBe(2);
  }, 60_000);

  // =========================================================================
  // STAFF ENTITLEMENT (P62-STAFF-001..008)
  //
  // WHY THESE GO THROUGH THE ENFORCEMENT SERVICE AND NOT AN ENDPOINT.
  // Atlas has no staff-creation path: the three real member paths produce
  // `owner`, `manager` and `instructor`, and the audit that found this
  // defect confirmed no API, UI or invitation flow creates a `staff` row.
  // The `staff` limit was therefore UNENFORCEABLE, not merely unenforced.
  //
  // `AcademiesService.createAcademyMember` now consults `MEMBER_ROLE_LIMIT`
  // for every member it creates, so the moment a staff path exists it is
  // gated. What these tests prove is the half that is real today: that the
  // `staff` limit resolves and enforces correctly against real
  // subscriptions, real usage and real RLS — exactly the call
  // `createAcademyMember` makes for `role: 'staff'`. Inventing a staff
  // endpoint purely to have something to call would be adding a feature,
  // which this work is explicitly not doing.
  // =========================================================================

  /** Exactly what `createAcademyMember` runs for a `staff` member. */
  async function assertStaffSeat(organizationId: string) {
    return tenancy.runInTenantContext(organizationId, (tx) =>
      entitlement.assertWithinLimit(tx, organizationId, 'staff', 1),
    );
  }

  /** A zero-delta staff call — consumes no new seat. */
  async function assertStaffZeroDelta(organizationId: string) {
    return tenancy.runInTenantContext(organizationId, (tx) =>
      entitlement.assertWithinLimit(tx, organizationId, 'staff', 0),
    );
  }

  async function seedStaff(academyId: string, count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const user = await admin.user.create({
        data: {
          name: `p62 staff ${i}`,
          email: uniqueTestEmail(`p62-staff-${i}`),
          passwordHash: 'not-a-real-hash-never-used-for-sign-in',
        },
      });
      await seedAcademyMember(admin, academyId, user.id, 'staff');
      ids.push(user.id);
    }
    return ids;
  }

  it('P62-STAFF-001 — below the staff limit, a new staff seat is allowed', async () => {
    const { org } = await seedTenant('p62-staff-below', { staff: 3 });
    const academy = await seedAcademy(admin, org.id, 'p62-staff-below-academy');
    await seedStaff(academy.id, 1);

    await expect(assertStaffSeat(org.id)).resolves.toBeUndefined();
  }, 60_000);

  it('P62-STAFF-002 — exactly AT the staff limit, another staff seat is refused', async () => {
    const { org } = await seedTenant('p62-staff-at', { staff: 2 });
    const academy = await seedAcademy(admin, org.id, 'p62-staff-at-academy');
    await seedStaff(academy.id, 2);

    await expect(assertStaffSeat(org.id)).rejects.toMatchObject({
      response: { code: 'ENTITLEMENT_LIMIT_REACHED', values: { limitKey: 'staff' } },
    });
  }, 60_000);

  it('P62-STAFF-003 — existing staff are never removed or altered by a refusal', async () => {
    const { org } = await seedTenant('p62-staff-intact', { staff: 1 });
    const academy = await seedAcademy(admin, org.id, 'p62-staff-intact-academy');
    const seeded = await seedStaff(academy.id, 1);

    await expect(assertStaffSeat(org.id)).rejects.toBeDefined();

    const still = await admin.academyMember.count({
      where: { academyId: academy.id, role: 'staff', status: 'active' },
    });
    expect(still).toBe(1);
    expect(seeded).toHaveLength(1);
  }, 60_000);

  it('P62-STAFF-004 — a staff limit at zero never blocks OTHER resources', async () => {
    // The defects must not be solved by leaning on each other: exhausting
    // staff says nothing about academies, instructors or courses.
    const { owner, org } = await seedTenant('p62-staff-isolated', {
      staff: 0,
      academies: 2,
    });

    await expect(assertStaffSeat(org.id)).rejects.toBeDefined();

    const results = await createConcurrently('p62-staff-iso', org.id, owner.userId, 2);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
  }, 60_000);

  it('P62-STAFF-005 — a ZERO-delta staff operation is never refused', async () => {
    // Tier 1 applies to `staff` exactly as it does to `students`: an
    // operation that occupies no new seat is not a capacity question, even
    // when usage already sits above the limit after a catalog reduction.
    const { org } = await seedTenant('p62-staff-zero', { staff: 1 });
    const academy = await seedAcademy(admin, org.id, 'p62-staff-zero-academy');
    await seedStaff(academy.id, 3); // deliberately ABOVE the limit

    await expect(assertStaffZeroDelta(org.id)).resolves.toBeUndefined();
    await expect(assertStaffSeat(org.id)).rejects.toBeDefined();
  }, 60_000);

  it('P62-STAFF-006 — one tenant\'s staff usage never counts against another', async () => {
    const a = await seedTenant('p62-staff-tenant-a', { staff: 1 });
    const b = await seedTenant('p62-staff-tenant-b', { staff: 1 });
    const academyA = await seedAcademy(admin, a.org.id, 'p62-staff-a-academy');
    await seedStaff(academyA.id, 1);

    // A is full; B has not used a single seat and must be unaffected.
    await expect(assertStaffSeat(a.org.id)).rejects.toBeDefined();
    await expect(assertStaffSeat(b.org.id)).resolves.toBeUndefined();
  }, 60_000);

  it('P62-STAFF-007 — the staff limit comes from the GRANT, not the catalog', async () => {
    // P61 semantics hold for `staff` like every other key: a customer
    // granted 2 keeps 2 after the catalog is cut to 0.
    const owner = await signUp('p62-staff-grant-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p62-staff-grant-org');
    createdOrgIds.push(org.id);
    const plan = await seedPlan(admin, 'p62-staff-grant-plan', { limits: LIMITS({ staff: 0 }) });
    createdPlanIds.push(plan.id);
    await seedTenantSubscription(admin, org.id, plan.id, {
      status: 'active',
      grantedLimits: LIMITS({ staff: 2 }),
    });
    const academy = await seedAcademy(admin, org.id, 'p62-staff-grant-academy');
    await seedStaff(academy.id, 1);

    // Catalog says 0, grant says 2, one used → a second seat is allowed.
    await expect(assertStaffSeat(org.id)).resolves.toBeUndefined();
  }, 60_000);

  it('P62-STAFF-008 — an inactive subscription refuses a staff seat regardless of the number', async () => {
    const owner = await signUp('p62-staff-inactive-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p62-staff-inactive-org');
    createdOrgIds.push(org.id);
    const plan = await seedPlan(admin, 'p62-staff-inactive-plan', { limits: LIMITS({ staff: 100 }) });
    createdPlanIds.push(plan.id);
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'expired' });

    await expect(assertStaffSeat(org.id)).rejects.toMatchObject({
      response: { code: 'ENTITLEMENT_SUBSCRIPTION_INACTIVE' },
    });
  }, 60_000);
});
