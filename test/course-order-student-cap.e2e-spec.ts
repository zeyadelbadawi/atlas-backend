/**
 * CF-21 / B0-BIL-05 — the plan's `students` limit fences NEW paid
 * enrollments: a learner who is not yet counted cannot START a paid order
 * once the organization is at its limit. A learner already counted (enrolled
 * in another course of the organization) is unaffected, and an organization
 * below its limit sells as before.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';

jest.setTimeout(30000);

async function signUpAndSignIn(app: INestApplication, label: string) {
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
  return {
    userId: signIn.body.user.id as string,
    accessToken: signIn.body.accessToken as string,
  };
}

const unique = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('Course orders respect the plan student limit (e2e) — CF-21', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let enrolled: { userId: string; accessToken: string };
  let newcomer: { userId: string; accessToken: string };
  let paidCourseId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    const owner = await signUpAndSignIn(app, 'cap-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'cap-org');
    const plan = await seedPlan(admin, 'cap-plan', {
      limits: {
        academies: 1,
        students: 1,
        instructors: 1,
        staff: 1,
        courses: 5,
        generalStorage: 1,
        videoStorage: 1,
      },
    });
    await seedTenantSubscription(admin, org.id, plan.id, {
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });
    const academy = await seedAcademy(admin, org.id, unique('cap-academy'));
    const freeCourse = await seedCourse(admin, academy.id, unique('cap-free'), {
      status: 'published',
      visibility: 'public',
    });
    const paidCourse = await seedCourse(admin, academy.id, unique('cap-paid'), {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(4900),
      pricingCurrency: 'EGP',
    });
    paidCourseId = paidCourse.id;

    // Payment collection configured, so order creation reaches the limit check.
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);

    // The organization's one seat is taken by `enrolled`.
    enrolled = await signUpAndSignIn(app, 'cap-enrolled');
    await seedEnrollment(admin, enrolled.userId, freeCourse.id, academy.id);
    newcomer = await signUpAndSignIn(app, 'cap-newcomer');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const order = (who: { accessToken: string }) =>
    request(app.getHttpServer())
      .post(`/courses/${paidCourseId}/course-orders`)
      .set('Authorization', `Bearer ${who.accessToken}`)
      .send({ idempotencyKey: unique('cap-order') });

  it('refuses a new learner once the organization is at its student limit', async () => {
    const res = await order(newcomer).expect(409);
    expect(res.body.error.messageKey).toBe('errors.courseOrder.notAcceptingEnrollments');
  });

  it('still lets an already-counted learner buy another course', async () => {
    await order(enrolled).expect(201);
  });
});
