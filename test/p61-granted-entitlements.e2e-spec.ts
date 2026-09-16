/**
 * P61 — purchased entitlement survives a catalog edit (P61-GRANT-001..018).
 *
 * THE SCENARIO THIS EXISTS FOR, stated once:
 *
 *   A customer buys a plan allowing 50 students and enrols 30 of them.
 *   The Platform Owner later edits that catalog plan down to 20.
 *
 * Before P61, `tenant_subscriptions` recorded WHICH plan but never WHAT IT
 * GRANTED, so entitlement joined live to `plans` and that edit silently
 * rewrote a completed purchase — the customer had 20 the instant the
 * catalog said 20. Their existing 30 students then could not even start
 * another course, because the zero-delta safeguard in
 * `EntitlementEnforcementService` was defeated by its own arithmetic once
 * `used > limit`.
 *
 * Both halves are asserted here against real PostgreSQL, through the real
 * HTTP enrollment endpoint and the real `PATCH /platform-plans/:key`, so
 * the proof covers RLS, the guards and the transaction boundary rather
 * than a mocked client.
 *
 * WHY THE 30 STUDENTS ARE SEEDED DIRECTLY. Thirty registrations plus thirty
 * enrolments over HTTP would dominate the suite's runtime and prove nothing
 * extra — the seeded rows are the same rows those requests would write, and
 * `computeLiveCounts` counts them identically. Every DECISION under test
 * (student 31, student 51, the zero-delta enrolment, the catalog edit) goes
 * through the real endpoint.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedCourse,
  seedOrganizationWithOwner,
  seedPaymentMethod,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

/** A real PNG magic-byte buffer — passes `detectFileKind` without a decodable image. */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,' +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString(
    'base64',
  );

/** A complete limit set — every `PlanLimitKey`, as the DTO requires. */
const LIMITS = (students: number | 'unlimited') => ({
  academies: 100,
  students,
  instructors: 100,
  staff: 100,
  courses: 100,
  generalStorage: 100,
  videoStorage: 100,
  recordedSessions: 10,
});

describe('P61 granted entitlements (e2e) — P61-GRANT-001..018', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let platformOwnerToken: string;

  const createdPlanIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    platformOwnerToken = (await seedPlatformOwner('p61-po')).token;
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await admin.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    // Users are deliberately NOT deleted: they own `audit_log_entries`
    // rows, which this codebase treats as append-only (no retention policy,
    // by explicit product decision). Test emails are unique per run, so
    // leaving them costs nothing and deleting them would mean destroying
    // audit history to tidy a fixture. Matches `p57`/`p60`, which delete
    // only the organizations and plans they created.
    if (createdPlanIds.length > 0) {
      await admin.plan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // ---------------- fixtures ----------------

  async function signUp(label: string, academyId?: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, ...(academyId ? { academyId } : {}) })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedPlatformOwner(label: string) {
    const account = await signUp(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  /**
   * An organization on a plan, with an explicit choice about whether its
   * subscription recorded a grant — the single variable this suite turns.
   */
  async function seedTenant(
    label: string,
    options: {
      readonly catalogStudents: number | 'unlimited';
      readonly grantedStudents?: number | 'unlimited';
      readonly status?: 'active' | 'trialing';
    },
  ) {
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    createdOrgIds.push(org.id);

    const plan = await seedPlan(admin, `${label}-plan`, {
      limits: LIMITS(options.catalogStudents),
    });
    createdPlanIds.push(plan.id);

    await seedTenantSubscription(admin, org.id, plan.id, {
      status: options.status ?? 'active',
      ...(options.grantedStudents !== undefined
        ? { grantedLimits: LIMITS(options.grantedStudents) }
        : {}),
    });

    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    return { owner, org, plan, academy };
  }

  async function seedCourseIn(academyId: string, label: string) {
    return seedCourse(admin, academyId, `${label}-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
  }

  /**
   * `count` real students, each enrolled in `course` — the same rows the
   * HTTP path writes, so `computeLiveCounts` sees them identically.
   */
  async function seedEnrolledStudents(
    academyId: string,
    courseId: string,
    count: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const user = await admin.user.create({
        data: {
          name: `p61 seeded student ${i}`,
          email: uniqueTestEmail(`p61-seeded-${i}`),
          passwordHash: 'not-a-real-hash-never-used-for-sign-in',
        },
      });
      ids.push(user.id);
      await seedAcademyStudent(admin, academyId, user.id);
      await admin.enrollment.create({
        data: { studentId: user.id, courseId, academyId, status: 'enrolled' },
      });
    }
    return ids;
  }

  /** The Platform Owner edits the catalog through the real endpoint. */
  async function reduceCatalogStudents(planKey: string, to: number) {
    const plan = await admin.plan.findUniqueOrThrow({ where: { key: planKey } });
    return request(app.getHttpServer())
      .patch(`/platform-plans/${planKey}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: plan.version, limits: LIMITS(to) })
      .expect(200);
  }

  function enrollAs(token: string, courseId: string) {
    return request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .send({ courseId });
  }

  // =========================================================================
  // THE SCENARIO: 50 purchased, 30 used, catalog cut to 20
  // =========================================================================

  describe('50 granted, 30 used, catalog reduced to 20', () => {
    it('P61-GRANT-001..006 — the purchase survives the edit, end to end', async () => {
      const { plan, academy } = await seedTenant('p61-main', {
        catalogStudents: 50,
        grantedStudents: 50,
      });
      const courseOne = await seedCourseIn(academy.id, 'p61-main-one');
      const courseTwo = await seedCourseIn(academy.id, 'p61-main-two');

      const seeded = await seedEnrolledStudents(academy.id, courseOne.id, 30);
      expect(seeded).toHaveLength(30);

      // The Platform Owner reduces the CATALOG to 20.
      await reduceCatalogStudents(plan.key, 20);

      // A. the grant is untouched by the catalog edit
      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: seeded.length ? (await admin.enrollment.findFirstOrThrow({ where: { studentId: seeded[0] }, include: { course: { include: { academy: true } } } })).course.academy.organizationId : '' },
      });
      expect((subscription.grantedLimits as { students: number }).students).toBe(50);

      // B. the catalog really did change — this is not a no-op test
      const catalog = await admin.plan.findUniqueOrThrow({ where: { key: plan.key } });
      expect((catalog.limits as { students: number }).students).toBe(20);

      // C. the existing 30 are preserved, every one of them
      const stillEnrolled = await admin.enrollment.count({
        where: { studentId: { in: seeded }, status: 'enrolled' },
      });
      expect(stillEnrolled).toBe(30);

      // D. an existing student moving to another course is ALLOWED —
      //    zero-delta, and within the granted 50 besides.
      const movingStudent = await signUp('p61-main-mover', academy.id);
      await enrollAs(movingStudent.token, courseOne.id).expect(201);
      await enrollAs(movingStudent.token, courseTwo.id).expect(201);

      // E. student #32 is ALLOWED — 32 <= the granted 50, even though the
      //    catalog now says 20.
      const newStudent = await signUp('p61-main-new', academy.id);
      await enrollAs(newStudent.token, courseOne.id).expect(201);

      const usedNow = await admin.enrollment.findMany({
        where: { course: { academyId: academy.id }, status: { not: 'unavailable' } },
        select: { studentId: true },
        distinct: ['studentId'],
      });
      expect(usedNow.length).toBeGreaterThan(20);
      expect(usedNow.length).toBeLessThanOrEqual(50);
    }, 120_000);

    it('P61-GRANT-007 — student #51 is blocked: the GRANT is still a real ceiling', async () => {
      // Grandfathering protects what was bought; it does not make the plan
      // unlimited. Granted 2, used 2 → the third is refused.
      const { academy } = await seedTenant('p61-ceiling', {
        catalogStudents: 100,
        grantedStudents: 2,
      });
      const course = await seedCourseIn(academy.id, 'p61-ceiling-course');
      await seedEnrolledStudents(academy.id, course.id, 2);

      const third = await signUp('p61-ceiling-third', academy.id);
      const rejected = await enrollAs(third.token, course.id).expect(409);
      expect(rejected.body.error.messageKey).toBe('errors.entitlement.limitReached');
    }, 60_000);
  });

  // =========================================================================
  // A NEW customer after the catalog edit gets the NEW number
  // =========================================================================

  it('P61-GRANT-008 — a subscription granted AFTER the reduction gets the reduced limit', async () => {
    // The mirror image of the scenario above, and the reason grandfathering
    // is safe: it protects existing purchases without freezing the catalog.
    const { academy } = await seedTenant('p61-newcustomer', {
      catalogStudents: 20,
      grantedStudents: 20,
    });
    const course = await seedCourseIn(academy.id, 'p61-new-course');
    await seedEnrolledStudents(academy.id, course.id, 20);

    const twentyFirst = await signUp('p61-new-21', academy.id);
    const rejected = await enrollAs(twentyFirst.token, course.id).expect(409);
    expect(rejected.body.error.messageKey).toBe('errors.entitlement.limitReached');
  }, 90_000);

  // =========================================================================
  // Zero-delta (Tier 1) against the real database
  // =========================================================================

  it('P61-GRANT-009 — an already-counted student may take another course even when usage EXCEEDS the limit', async () => {
    // The exact regression: no grant recorded, catalog cut below current
    // usage, and an existing student enrolling in a second course. This
    // returned 409 before Tier 1.
    const { plan, academy } = await seedTenant('p61-zero', { catalogStudents: 1 });
    const courseOne = await seedCourseIn(academy.id, 'p61-zero-one');
    const courseTwo = await seedCourseIn(academy.id, 'p61-zero-two');

    const student = await signUp('p61-zero-student', academy.id);
    await enrollAs(student.token, courseOne.id).expect(201);

    // Catalog drops to 0 while one student is already enrolled: used(1) > limit(0).
    await reduceCatalogStudents(plan.key, 0);

    await enrollAs(student.token, courseTwo.id).expect(201);
  }, 60_000);

  it('P61-GRANT-010 — a genuinely NEW student is still refused in that same state', async () => {
    // Tier 1 exempts zero-cost work, never real consumption.
    const { plan, academy } = await seedTenant('p61-zero-new', { catalogStudents: 1 });
    const course = await seedCourseIn(academy.id, 'p61-zero-new-course');

    const first = await signUp('p61-zero-new-first', academy.id);
    await enrollAs(first.token, course.id).expect(201);

    await reduceCatalogStudents(plan.key, 0);

    const second = await signUp('p61-zero-new-second', academy.id);
    await enrollAs(second.token, course.id).expect(409);
  }, 60_000);

  // =========================================================================
  // Fallback, capture, and the other limit keys
  // =========================================================================

  it('P61-GRANT-011 — a subscription with NO recorded grant follows the live catalog', async () => {
    // Every row that predates P61 is this row. Its behaviour must be
    // byte-for-byte what it was before the column existed.
    const { org, plan, academy } = await seedTenant('p61-fallback', {
      catalogStudents: 1,
    });
    const subscription = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(subscription.grantedLimits).toBeNull();

    const course = await seedCourseIn(academy.id, 'p61-fallback-course');
    const first = await signUp('p61-fallback-first', academy.id);
    await enrollAs(first.token, course.id).expect(201);

    // Catalog is the ceiling, because nothing else was recorded.
    const second = await signUp('p61-fallback-second', academy.id);
    await enrollAs(second.token, course.id).expect(409);

    // Raising the catalog raises it, for the same reason.
    await reduceCatalogStudents(plan.key, 5);
    await enrollAs(second.token, course.id).expect(201);
  }, 90_000);

  it('P61-GRANT-012 — a recorded grant covers EVERY limit key, not just students', async () => {
    const { org } = await seedTenant('p61-allkeys', {
      catalogStudents: 50,
      grantedStudents: 50,
    });
    const subscription = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    const granted = subscription.grantedLimits as Record<string, unknown>;
    for (const key of [
      'academies',
      'students',
      'instructors',
      'staff',
      'courses',
      'generalStorage',
      'videoStorage',
      'recordedSessions',
    ]) {
      expect(granted[key]).toBeDefined();
    }
  });

  it('P61-GRANT-013 — the courses limit is granted too, and survives a catalog cut', async () => {
    // Proves the grant is not a students-only special case: a different
    // key, a different enforcement call site (`CoursesService.create`).
    const { owner, org, plan, academy } = await seedTenant('p61-courses', {
      catalogStudents: 50,
      grantedStudents: 50,
    });
    await admin.academyMember.create({
      data: { academyId: academy.id, userId: owner.userId, role: 'owner', status: 'active' },
    });

    // Cut the catalog's COURSES limit to 0 while the grant says 100.
    const current = await admin.plan.findUniqueOrThrow({ where: { key: plan.key } });
    await request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({
        expectedVersion: current.version,
        limits: { ...LIMITS(50), courses: 0 },
      })
      .expect(200);

    // The grant still allows it.
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        title: 'P61 granted course',
        slug: `p61-granted-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);

    expect(org.id).toBeDefined();
  }, 60_000);

  // =========================================================================
  // Impact preview honesty
  // =========================================================================

  it('P61-GRANT-014 — the impact preview does not claim to affect protected subscribers', async () => {
    const { plan } = await seedTenant('p61-preview-granted', {
      catalogStudents: 50,
      grantedStudents: 50,
    });

    const preview = await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/limits/preview`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ limits: LIMITS(1) })
      .expect(200);

    // One subscriber, holding a grant → unreachable by this edit.
    expect(preview.body.protectedSubscriptions).toBe(1);
    expect(preview.body.catalogFollowingSubscriptions).toBe(0);
    expect(preview.body.affected).toEqual([]);
  }, 60_000);

  it('P61-GRANT-015 — the preview DOES still report subscribers who follow the catalog', async () => {
    const { org, plan, academy } = await seedTenant('p61-preview-catalog', {
      catalogStudents: 50,
    });
    const course = await seedCourseIn(academy.id, 'p61-preview-course');
    await seedEnrolledStudents(academy.id, course.id, 3);
    // The preview reads the cached `tenant_usage` snapshot, so materialise it.
    await admin.tenantUsage.upsert({
      where: { organizationId: org.id },
      create: {
        organizationId: org.id,
        academies: 1,
        students: 3,
        instructors: 0,
        staff: 0,
        courses: 1,
        generalStorageGb: 0,
        videoStorageGb: 0,
      },
      update: { students: 3 },
    });

    const preview = await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/limits/preview`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ limits: LIMITS(1) })
      .expect(200);

    expect(preview.body.protectedSubscriptions).toBe(0);
    expect(preview.body.catalogFollowingSubscriptions).toBe(1);
    expect(
      preview.body.affected.some(
        (row: { organizationId: string; limitKey: string }) =>
          row.organizationId === org.id && row.limitKey === 'students',
      ),
    ).toBe(true);
  }, 60_000);

  // =========================================================================
  // Archive, and repeated/concurrent operations
  // =========================================================================

  it('P61-GRANT-016 — archiving a plan leaves an existing grant working and untouched', async () => {
    const { org, plan, academy } = await seedTenant('p61-archive', {
      catalogStudents: 50,
      grantedStudents: 50,
    });
    const course = await seedCourseIn(academy.id, 'p61-archive-course');

    const current = await admin.plan.findUniqueOrThrow({ where: { key: plan.key } });
    await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/archive`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: current.version })
      .expect(201);

    const archived = await admin.plan.findUniqueOrThrow({ where: { key: plan.key } });
    expect(archived.status).toBe('archived');

    // The subscription row is not touched by an archive, and still works.
    const subscription = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect((subscription.grantedLimits as { students: number }).students).toBe(50);
    expect(subscription.status).toBe('active');

    const student = await signUp('p61-archive-student', academy.id);
    await enrollAs(student.token, course.id).expect(201);
  }, 60_000);

  it('P61-GRANT-017 — repeated enrollment of the same student is idempotent and never double-charges a seat', async () => {
    const { academy } = await seedTenant('p61-repeat', {
      catalogStudents: 100,
      grantedStudents: 1,
    });
    const course = await seedCourseIn(academy.id, 'p61-repeat-course');
    const student = await signUp('p61-repeat-student', academy.id);

    await enrollAs(student.token, course.id).expect(201);
    // Re-clicking Enrol returns the existing row; the single granted seat
    // is not consumed twice.
    await enrollAs(student.token, course.id).expect(201);

    const rows = await admin.enrollment.count({
      where: { studentId: student.userId, courseId: course.id },
    });
    expect(rows).toBe(1);
  }, 60_000);

  it('P61-GRANT-018 — concurrent enrollments cannot exceed the granted ceiling', async () => {
    // The check and the insert share one transaction, so the database —
    // not the application — decides the race.
    const { academy } = await seedTenant('p61-concurrent', {
      catalogStudents: 100,
      grantedStudents: 2,
    });
    const course = await seedCourseIn(academy.id, 'p61-concurrent-course');

    const students = await Promise.all([
      signUp('p61-conc-a', academy.id),
      signUp('p61-conc-b', academy.id),
      signUp('p61-conc-c', academy.id),
      signUp('p61-conc-d', academy.id),
    ]);

    const results = await Promise.all(
      students.map((s) => enrollAs(s.token, course.id).then((r) => r.status)),
    );

    const distinct = await admin.enrollment.findMany({
      where: { courseId: course.id, status: { not: 'unavailable' } },
      select: { studentId: true },
      distinct: ['studentId'],
    });
    // Never more than the granted 2, whatever order the four raced in.
    expect(distinct.length).toBeLessThanOrEqual(2);
    expect(results.filter((s) => s === 201).length).toBeLessThanOrEqual(2);
  }, 90_000);

  // =========================================================================
  // Upgrade, downgrade and trial — the three paths that GRANT an entitlement
  // =========================================================================

  /**
   * Drives a real plan purchase all the way to activation: checkout →
   * payment → proof → Platform Owner approval. That is the only server-side
   * trigger that turns a Payment into a subscription change, so it is the
   * only honest way to assert what a purchase grants.
   */
  async function purchasePlan(
    label: string,
    org: { id: string },
    ownerToken: string,
    planKey: string,
  ) {
    const method = await seedPaymentMethod(admin, `${label}-method`);

    const checkout = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        target: { type: 'plan_subscription', planKey },
        billingCycle: 'monthly',
        idempotencyKey: `${label}-${Date.now()}`,
      })
      .expect(201);

    const payment = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ checkoutId: checkout.body.id, methodKey: method.key })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payments/${payment.body.id}/proof`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fileData: TINY_PNG_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/payments/${payment.body.id}/approve`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ notes: 'p61' })
      .expect(201);
  }

  /** A priced plan, so a real Checkout can be created against it. */
  async function seedPricedPlanWithLimits(
    label: string,
    students: number,
  ) {
    const plan = await admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        limits: LIMITS(students),
        features: {},
        pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
      },
    });
    createdPlanIds.push(plan.id);
    return plan;
  }

  it('P61-GRANT-019 — an UPGRADE re-grants from the newly purchased plan, atomically', async () => {
    const owner = await signUp('p61-upgrade-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p61-upgrade-org');
    createdOrgIds.push(org.id);

    const small = await seedPricedPlanWithLimits('p61-upgrade-small', 10);
    const large = await seedPricedPlanWithLimits('p61-upgrade-large', 200);
    await seedTenantSubscription(admin, org.id, small.id, {
      status: 'active',
      grantedLimits: LIMITS(10),
    });

    await purchasePlan('p61-upgrade', org, owner.token, large.key);

    const after = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    // planId and grantedLimits moved together — an upgrade is a new
    // entitlement decision, and the row never names one plan while holding
    // another's grant.
    expect(after.planId).toBe(large.id);
    expect((after.grantedLimits as { students: number }).students).toBe(200);
    expect(after.status).toBe('active');
  }, 90_000);

  it('P61-GRANT-020 — a DOWNGRADE re-grants the LOWER limits, and destroys nothing', async () => {
    // A deliberate downgrade is the customer's own decision, so there is no
    // grandfathering here: they get what they just bought. What must not
    // happen is any existing resource being removed to fit.
    const owner = await signUp('p61-downgrade-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p61-downgrade-org');
    createdOrgIds.push(org.id);

    const large = await seedPricedPlanWithLimits('p61-downgrade-large', 200);
    const small = await seedPricedPlanWithLimits('p61-downgrade-small', 2);
    await seedTenantSubscription(admin, org.id, large.id, {
      status: 'active',
      grantedLimits: LIMITS(200),
    });

    const academy = await seedAcademy(admin, org.id, 'p61-downgrade-academy');
    const course = await seedCourseIn(academy.id, 'p61-downgrade-course');
    const seeded = await seedEnrolledStudents(academy.id, course.id, 5);

    await purchasePlan('p61-downgrade', org, owner.token, small.key);

    const after = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(after.planId).toBe(small.id);
    expect((after.grantedLimits as { students: number }).students).toBe(2);

    // The five students the customer already had are all still there.
    const stillEnrolled = await admin.enrollment.count({
      where: { studentId: { in: seeded }, status: 'enrolled' },
    });
    expect(stillEnrolled).toBe(5);

    // And a zero-delta move still works even though 5 > the new 2 — Tier 1.
    const existing = await signUp('p61-downgrade-existing', academy.id);
    const second = await seedCourseIn(academy.id, 'p61-downgrade-second');
    await enrollAs(existing.token, course.id).expect(409); // genuinely new: refused
    await admin.enrollment.create({
      data: { studentId: existing.userId, courseId: course.id, academyId: academy.id, status: 'enrolled' },
    });
    await enrollAs(existing.token, second.id).expect(201); // already counted: allowed
  }, 120_000);

  it('P61-GRANT-021 — a TRIAL captures its grant, and a later catalog edit does not shrink it', async () => {
    const owner = await signUp('p61-trial-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p61-trial-org');
    createdOrgIds.push(org.id);

    const plan = await seedPricedPlanWithLimits('p61-trial-plan', 25);
    // Only a trial-eligible plan may be trialed — the catalog decides that,
    // not the caller.
    await admin.plan.update({
      where: { id: plan.id },
      data: { trialEligible: true, trialDurationDays: 3 },
    });
    // The state a brand-new organization is in: a row, no plan, no trial.
    await admin.tenantSubscription.create({
      data: { organizationId: org.id, planId: plan.id, status: 'no_plan' },
    });
    await admin.trialPolicy.updateMany({ data: { enabled: true } });

    const started = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/subscription/trial`)
      .set('Authorization', `Bearer ${owner.token}`)
      // `confirm` is part of the contract: starting a trial is an explicit,
      // once-per-account decision, not something a stray POST can spend.
      .send({ confirm: true, planId: plan.id })
      .expect(200);
    expect(started.body.started).toBe(true);

    const afterStart = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(afterStart.status).toBe('trialing');
    expect((afterStart.grantedLimits as { students: number }).students).toBe(25);

    // Editing the catalog mid-trial must not move the goalposts under a
    // customer who is actively evaluating the product.
    await reduceCatalogStudents(plan.key, 1);

    const afterEdit = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect((afterEdit.grantedLimits as { students: number }).students).toBe(25);

    const academy = await seedAcademy(admin, org.id, 'p61-trial-academy');
    const course = await seedCourseIn(academy.id, 'p61-trial-course');
    const student = await signUp('p61-trial-student', academy.id);
    // Catalog says 1; the trial was granted 25, so this is allowed.
    await enrollAs(student.token, course.id).expect(201);
  }, 90_000);
});
