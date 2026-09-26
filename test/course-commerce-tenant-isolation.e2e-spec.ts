/**
 * Course Commerce — tenant isolation (Phase P13, master plan §18: "the
 * highest-priority suite in the entire backend, CI-blocking"). Mirrors
 * `learning-tenant-isolation.e2e-spec.ts`'s HTTP-level pattern: every
 * scenario here is a real request through the real guards/services/RLS
 * stack — no direct Prisma/session-variable manipulation (that direct-RLS
 * proof style is `rls-*.e2e-spec.ts`, out of this file's scope).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
  seedPaymentMethod,
} from './utils/db-admin';
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

async function makePlatformOwner(admin: PrismaClient, userId: string): Promise<void> {
  await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });
}

describe('Course Commerce — tenant isolation (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function setGlobalCommission(platformOwnerToken: string): Promise<void> {
    await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ defaultCommissionBasisPoints: 1000 })
      .expect(200);
  }

  async function arrangePaidCourseAndOrder(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label} ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 5000n,
      pricingCurrency: 'USD',
    });
    const student = await signUpAndSignIn(app, `${label}-student`);
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);

    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: `${label}-order` })
      .expect(201);

    return { owner, org, academy, course, student, order: orderRes.body };
  }

  it('a different student can never read, by direct id, another student’s CourseOrder', async () => {
    const { order } = await arrangePaidCourseAndOrder('isolation-order-read');
    const otherStudent = await signUpAndSignIn(app, 'isolation-order-read-other');

    await request(app.getHttpServer())
      .get(`/course-orders/${order.id}`)
      .set('Authorization', `Bearer ${otherStudent.accessToken}`)
      .expect(404);
  });

  it('a different student can never create a Payment against another student’s CourseOrder', async () => {
    const { order } = await arrangePaidCourseAndOrder('isolation-payment-create');
    const otherStudent = await signUpAndSignIn(app, 'isolation-payment-create-other');
    const method = await seedPaymentMethod(admin, 'isolation-payment-create-method');

    await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${otherStudent.accessToken}`)
      .send({ methodKey: method.key })
      .expect(404);
  });

  it('a different student can never request a refund on another student’s CourseOrder', async () => {
    const { order } = await arrangePaidCourseAndOrder('isolation-refund');
    const otherStudent = await signUpAndSignIn(app, 'isolation-refund-other');

    await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/refund`)
      .set('Authorization', `Bearer ${otherStudent.accessToken}`)
      .send({ idempotencyKey: 'isolation-refund-key' })
      .expect(404);
  });

  it('an unrelated Organization member can never read another Academy’s payouts', async () => {
    const { academy } = await arrangePaidCourseAndOrder('isolation-payout-read');
    const outsiderOwner = await signUpAndSignIn(app, 'isolation-payout-read-outsider');
    await seedOrganizationWithOwner(
      admin,
      outsiderOwner.userId,
      'isolation-payout-read-outsider-org',
    );

    // The outsider is not a member of the Academy's own Organization, so
    // `AcademyScopeGuard` rejects the read outright — matches every other
    // Academy-scoped route's identical guard (P5/P8/P9's own precedent).
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/payouts`)
      .set('Authorization', `Bearer ${outsiderOwner.accessToken}`)
      .expect(403);
  });

  it('the course-payment review list honours the reviewStatus filter', async () => {
    const reviewer = await signUpAndSignIn(app, 'review-filter-reviewer');
    await makePlatformOwner(admin, reviewer.userId);
    await setGlobalCommission(reviewer.accessToken);
    const { order, student } = await arrangePaidCourseAndOrder('review-filter');
    const method = await seedPaymentMethod(admin, 'review-filter-method');
    const payment = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ methodKey: method.key })
      .expect(201);
    await admin.payment.update({
      where: { id: payment.body.id },
      data: { reviewStatus: 'rejected' },
    });

    const ids = async (reviewStatus: string) => {
      const res = await request(app.getHttpServer())
        .get('/platform-course-order-payments')
        .query({ reviewStatus, pageSize: 100 })
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);
      return {
        ids: (res.body.items as { id: string; reviewStatus: string }[]).map((p) => p.id),
        statuses: new Set(
          (res.body.items as { reviewStatus: string }[]).map((p) => p.reviewStatus),
        ),
      };
    };
    const pending = await ids('pending');
    expect(pending.ids).not.toContain(payment.body.id);
    expect([...pending.statuses].every((s) => s === 'pending')).toBe(true);
    const rejected = await ids('rejected');
    expect(rejected.ids).toContain(payment.body.id);
    expect([...rejected.statuses].every((s) => s === 'rejected')).toBe(true);
  });

  /*
   * Remediation (finding B): academy revenue and payouts are Organization
   * Owner data. `AcademyScopeGuard` admits any organization member and any
   * active academy member, so before the service-level gate an instructor
   * of the academy — or the manager of a SIBLING academy in the same
   * organization — could read them.
   */
  describe('payouts and revenue summary — access matrix', () => {
    const paths = (academyId: string) => [
      `/academies/${academyId}/payouts`,
      `/academies/${academyId}/payouts/revenue-summary`,
    ];

    it('the Organization Owner can read both', async () => {
      const { owner, academy } = await arrangePaidCourseAndOrder('payout-matrix-owner');
      for (const path of paths(academy.id)) {
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(200);
      }
    });

    it('an instructor and a manager of the same academy are refused', async () => {
      const { org, academy } = await arrangePaidCourseAndOrder('payout-matrix-staff');
      const instructor = await signUpAndSignIn(app, 'payout-matrix-instructor');
      await seedMembership(admin, org.id, instructor.userId, 'instructor');
      await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
      const manager = await signUpAndSignIn(app, 'payout-matrix-manager');
      await seedMembership(admin, org.id, manager.userId, 'manager');
      await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

      for (const caller of [instructor, manager]) {
        for (const path of paths(academy.id)) {
          await request(app.getHttpServer())
            .get(path)
            .set('Authorization', `Bearer ${caller.accessToken}`)
            .expect(403);
        }
      }
    });

    it('an academy-level member with no organization membership is refused', async () => {
      const { academy } = await arrangePaidCourseAndOrder('payout-matrix-academy-only');
      const staff = await signUpAndSignIn(app, 'payout-matrix-academy-owner');
      await seedAcademyMember(admin, academy.id, staff.userId, 'owner');
      for (const path of paths(academy.id)) {
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${staff.accessToken}`)
          .expect(403);
      }
    });

    it('the manager of a sibling academy in the same organization is refused', async () => {
      const { org, academy } = await arrangePaidCourseAndOrder('payout-matrix-sibling');
      const sibling = await seedAcademy(admin, org.id, 'payout-matrix-sibling-b');
      const siblingManager = await signUpAndSignIn(app, 'payout-matrix-sibling-manager');
      await seedMembership(admin, org.id, siblingManager.userId, 'manager');
      await seedAcademyMember(admin, sibling.id, siblingManager.userId, 'manager');
      for (const path of paths(academy.id)) {
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${siblingManager.accessToken}`)
          .expect(403);
      }
    });
  });

  it('the flat Platform review surface only ever returns Course Commerce rows, never Atlas-subscription-billing rows, and vice versa', async () => {
    const { order, course, student } = await arrangePaidCourseAndOrder(
      'isolation-review-split',
    );
    // `atlas_payments` needs a global commission rate before a payment can
    // be taken; this test used to pass only when an earlier suite had
    // already set one.
    const reviewer = await signUpAndSignIn(app, 'isolation-review-split-reviewer');
    await makePlatformOwner(admin, reviewer.userId);
    await setGlobalCommission(reviewer.accessToken);
    const method = await seedPaymentMethod(admin, 'isolation-review-split-method');
    const paymentRes = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ methodKey: method.key })
      .expect(201);

    // The Atlas-subscription-billing review surface (`/payments`) must
    // never surface a course-order Payment.
    await request(app.getHttpServer())
      .get(`/payments/${paymentRes.body.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(404);

    // ...and the course-order review surface must correctly find it.
    await request(app.getHttpServer())
      .get(`/platform-course-order-payments/${paymentRes.body.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    void course;
  });

  it('a non-member cannot read another Organization’s commission configuration', async () => {
    const owner = await signUpAndSignIn(app, 'isolation-commission-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'isolation-commission-org',
    );
    const outsider = await signUpAndSignIn(app, 'isolation-commission-outsider');

    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);
  });
});
