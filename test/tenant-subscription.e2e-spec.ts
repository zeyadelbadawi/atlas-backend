/**
 * Tenant Subscription/Usage/Add-ons — functional/contract e2e suite (P4,
 * master plan §21), plus the `tenant-usage-recompute` worker's real
 * recomputation logic exercised through `TenantUsageRecomputeService`
 * directly (real Postgres, real RLS — not mocked; the queue-transport
 * half is covered separately in `tenant-usage-recompute-worker.e2e-spec.ts`).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAddOn,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantAddOn,
  seedTenantSubscription,
} from './utils/db-admin';
import { TenantUsageRecomputeService } from '../src/plans/services/tenant-usage-recompute.service';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Tenant Subscription/Usage/Add-ons (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let recomputeService: TenantUsageRecomputeService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    recomputeService = app.get(TenantUsageRecomputeService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it('requires authentication and organization membership on every route', async () => {
    const outsider = await signUpAndSignIn(app, 'tenant-outsider');
    const owner = await signUpAndSignIn(app, 'tenant-owner-guarded');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'tenant-guarded-org',
    );

    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/subscription`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/subscription`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);
  });

  it('GET .../subscription returns 404 when no subscription row exists (honest empty state)', async () => {
    const owner = await signUpAndSignIn(app, 'sub-none-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'sub-none-org');

    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/subscription`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('GET .../subscription returns real data with the full embedded Plan', async () => {
    const owner = await signUpAndSignIn(app, 'sub-real-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'sub-real-org');
    const plan = await seedPlan(admin, 'sub-real-plan');
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'trialing' });

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/subscription`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      organizationId: org.id,
      status: 'trialing',
      planId: plan.id,
      plan: { id: plan.id, key: plan.key },
      cancelAtPeriodEnd: false,
    });
  });

  it('GET .../add-ons returns an empty list when none are active, and real data when they are', async () => {
    const owner = await signUpAndSignIn(app, 'addons-real-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'addons-real-org');

    const empty = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/add-ons`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(empty.body).toEqual([]);

    const addOn = await seedAddOn(
      admin,
      'addons-real-addon',
      { type: 'feature', featureKey: 'backup' },
      [],
    );
    await seedTenantAddOn(admin, org.id, addOn.id);

    const withData = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/add-ons`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(withData.body).toHaveLength(1);
    expect(withData.body[0]).toMatchObject({
      organizationId: org.id,
      addOnId: addOn.id,
      addOn: { key: addOn.key },
    });
  });

  it('GET .../usage returns 404 before the worker has ever recomputed this organization', async () => {
    const owner = await signUpAndSignIn(app, 'usage-none-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'usage-none-org');
    const plan = await seedPlan(admin, 'usage-none-plan');
    await seedTenantSubscription(admin, org.id, plan.id);

    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/usage`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('GET .../usage returns 404 when usage exists but no subscription does (cannot compute a limit)', async () => {
    const owner = await signUpAndSignIn(app, 'usage-nosub-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'usage-nosub-org');

    await recomputeService.recomputeOne(org.id);

    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/usage`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('recomputeOne computes real academies/instructors/staff counts and the usage endpoint combines them with effective entitlements', async () => {
    const owner = await signUpAndSignIn(app, 'usage-real-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'usage-real-org');
    const plan = await seedPlan(admin, 'usage-real-plan', {
      limits: {
        academies: 2,
        students: 10,
        instructors: 3,
        staff: 3,
        courses: 5,
        generalStorage: 1,
        videoStorage: 1,
      },
    });
    await seedTenantSubscription(admin, org.id, plan.id);

    const academy = await seedAcademy(admin, org.id, 'usage-real-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const instructor = await signUpAndSignIn(app, 'usage-real-instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    const staffMember = await signUpAndSignIn(app, 'usage-real-staff');
    await seedAcademyMember(admin, academy.id, staffMember.userId, 'staff');

    // Add-on: +1 academies.
    const addOn = await seedAddOn(
      admin,
      'usage-real-addon',
      { type: 'limit', limitKey: 'academies', amount: 1 },
      [plan.key],
    );
    await seedTenantAddOn(admin, org.id, addOn.id);

    await recomputeService.recomputeOne(org.id);

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/usage`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(response.body).toEqual({
      organizationId: org.id,
      academies: { used: 1, limit: 3 }, // base 2 + add-on 1
      students: { used: 0, limit: 10 },
      instructors: { used: 1, limit: 3 },
      staff: { used: 1, limit: 3 },
      courses: { used: 0, limit: 5 },
      generalStorage: { used: 0, limit: 1 },
      videoStorage: { used: 0, limit: 1 },
      updatedAt: expect.any(String),
    });
  });

  it('recomputation is idempotent: running it twice with no data change yields identical usage', async () => {
    const owner = await signUpAndSignIn(app, 'idempotent-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'idempotent-org');
    const plan = await seedPlan(admin, 'idempotent-plan');
    await seedTenantSubscription(admin, org.id, plan.id);
    const academy = await seedAcademy(admin, org.id, 'idempotent-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    await recomputeService.recomputeOne(org.id);
    const first = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });

    await recomputeService.recomputeOne(org.id);
    const second = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });

    expect(second.academies).toBe(first.academies);
    expect(second.instructors).toBe(first.instructors);
    expect(second.staff).toBe(first.staff);
  });

  it('recomputation reflects changed source data: archiving an academy drops it from the count', async () => {
    const owner = await signUpAndSignIn(app, 'changed-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'changed-org');
    const plan = await seedPlan(admin, 'changed-plan');
    await seedTenantSubscription(admin, org.id, plan.id);
    const academy = await seedAcademy(admin, org.id, 'changed-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    await recomputeService.recomputeOne(org.id);
    const before = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(before.academies).toBe(1);

    await admin.academy.update({
      where: { id: academy.id },
      data: { status: 'archived' },
    });
    await recomputeService.recomputeOne(org.id);
    const after = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(after.academies).toBe(0);
  });

  it("recomputation for one organization never touches another organization's usage row", async () => {
    const ownerA = await signUpAndSignIn(app, 'isolation-usage-ownerA');
    const ownerB = await signUpAndSignIn(app, 'isolation-usage-ownerB');
    const orgA = await seedOrganizationWithOwner(
      admin,
      ownerA.userId,
      'isolation-usage-orgA',
    );
    const orgB = await seedOrganizationWithOwner(
      admin,
      ownerB.userId,
      'isolation-usage-orgB',
    );
    const planA = await seedPlan(admin, 'isolation-usage-planA');
    const planB = await seedPlan(admin, 'isolation-usage-planB');
    await seedTenantSubscription(admin, orgA.id, planA.id);
    await seedTenantSubscription(admin, orgB.id, planB.id);

    const academyA1 = await seedAcademy(admin, orgA.id, 'isolation-usage-a1');
    await seedAcademyMember(admin, academyA1.id, ownerA.userId, 'owner');
    const academyB1 = await seedAcademy(admin, orgB.id, 'isolation-usage-b1');
    await seedAcademyMember(admin, academyB1.id, ownerB.userId, 'owner');
    const academyB2 = await seedAcademy(admin, orgB.id, 'isolation-usage-b2');
    await seedAcademyMember(admin, academyB2.id, ownerB.userId, 'owner');

    await recomputeService.recomputeOne(orgA.id);
    await recomputeService.recomputeOne(orgB.id);

    const usageA = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: orgA.id },
    });
    const usageB = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: orgB.id },
    });
    expect(usageA.academies).toBe(1);
    expect(usageB.academies).toBe(2);
  });

  it('concurrent recomputation of different organizations never cross-contaminates', async () => {
    const ownerA = await signUpAndSignIn(app, 'concurrent-ownerA');
    const ownerB = await signUpAndSignIn(app, 'concurrent-ownerB');
    const orgA = await seedOrganizationWithOwner(admin, ownerA.userId, 'concurrent-orgA');
    const orgB = await seedOrganizationWithOwner(admin, ownerB.userId, 'concurrent-orgB');
    const planA = await seedPlan(admin, 'concurrent-planA');
    const planB = await seedPlan(admin, 'concurrent-planB');
    await seedTenantSubscription(admin, orgA.id, planA.id);
    await seedTenantSubscription(admin, orgB.id, planB.id);

    const academyA = await seedAcademy(admin, orgA.id, 'concurrent-a');
    await seedAcademyMember(admin, academyA.id, ownerA.userId, 'owner');

    await Promise.all([
      recomputeService.recomputeOne(orgA.id),
      recomputeService.recomputeOne(orgB.id),
      recomputeService.recomputeOne(orgA.id),
      recomputeService.recomputeOne(orgB.id),
    ]);

    const usageA = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: orgA.id },
    });
    const usageB = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: orgB.id },
    });
    expect(usageA.academies).toBe(1);
    expect(usageB.academies).toBe(0);
  });

  it('instructors/staff are counted once per distinct user even if they hold that role in multiple academies', async () => {
    const owner = await signUpAndSignIn(app, 'distinct-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'distinct-org');
    const plan = await seedPlan(admin, 'distinct-plan');
    await seedTenantSubscription(admin, org.id, plan.id);

    const academy1 = await seedAcademy(admin, org.id, 'distinct-a1');
    const academy2 = await seedAcademy(admin, org.id, 'distinct-a2');
    const instructor = await signUpAndSignIn(app, 'distinct-instructor');
    await seedAcademyMember(admin, academy1.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy2.id, instructor.userId, 'instructor');

    await recomputeService.recomputeOne(org.id);
    const usage = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(usage.instructors).toBe(1);
  });

  it('owner/administrator/manager roles are not counted toward instructors or staff (documented interpretation)', async () => {
    const owner = await signUpAndSignIn(app, 'roles-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'roles-org');
    const plan = await seedPlan(admin, 'roles-plan');
    await seedTenantSubscription(admin, org.id, plan.id);

    const academy = await seedAcademy(admin, org.id, 'roles-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const admin1 = await signUpAndSignIn(app, 'roles-admin');
    await seedAcademyMember(admin, academy.id, admin1.userId, 'administrator');
    const manager = await signUpAndSignIn(app, 'roles-manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    await recomputeService.recomputeOne(org.id);
    const usage = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(usage.instructors).toBe(0);
    expect(usage.staff).toBe(0);
  });

  it('students/courses/storage metrics are honestly 0 — no source table exists yet', async () => {
    const owner = await signUpAndSignIn(app, 'honest-zero-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'honest-zero-org');
    const plan = await seedPlan(admin, 'honest-zero-plan');
    await seedTenantSubscription(admin, org.id, plan.id);

    await recomputeService.recomputeOne(org.id);
    const usage = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(usage.students).toBe(0);
    expect(usage.courses).toBe(0);
    expect(usage.generalStorageGb).toBe(0);
    expect(usage.videoStorageGb).toBe(0);
  });

  it('inactive/pending academy_members do not count toward usage', async () => {
    const owner = await signUpAndSignIn(app, 'inactive-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'inactive-org');
    const plan = await seedPlan(admin, 'inactive-plan');
    await seedTenantSubscription(admin, org.id, plan.id);
    const academy = await seedAcademy(admin, org.id, 'inactive-academy');
    const instructor = await signUpAndSignIn(app, 'inactive-instructor');
    await admin.academyMember.create({
      data: {
        academyId: academy.id,
        userId: instructor.userId,
        role: 'instructor',
        status: 'pending',
      },
    });

    await recomputeService.recomputeOne(org.id);
    const usage = await admin.tenantUsage.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(usage.instructors).toBe(0);
  });
});
