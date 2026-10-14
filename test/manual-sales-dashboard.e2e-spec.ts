/**
 * B0-COM-02 — an academy that sells with manual payments (the only mode
 * customers can switch on at launch) sees its sales on the dashboard.
 * These never reach the revenue ledger, so they are summed from approved
 * academy-manual payments whose order is still paid, per 7/30/90-day
 * window, for the organization owner only (B0-SEC-03).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseOrder,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { ORGANIZATION_MANAGER_PERMISSIONS } from '../src/tenancy/constants/organization-permissions.constants';

jest.setTimeout(30000);

const DAY = 24 * 60 * 60 * 1000;

describe('Dashboard manual-payment sales (e2e) — B0-COM-02', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let owner: { userId: string; accessToken: string };
  let manager: { userId: string; accessToken: string };
  let orgId: string;
  let academyId: string;

  async function account(label: string) {
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

  async function sale(options: {
    studentId: string;
    courseId: string;
    amount: bigint;
    paidDaysAgo: number;
    orderStatus?: 'paid' | 'refunded' | 'pending_payment';
    paymentStatus?: 'succeeded' | 'failed';
    provider?: string;
  }) {
    const order = await seedCourseOrder(
      admin,
      options.studentId,
      options.courseId,
      academyId,
      orgId,
    );
    await admin.courseOrder.update({
      where: { id: order.id },
      data: {
        status: options.orderStatus ?? 'paid',
        paidAt: new Date(Date.now() - options.paidDaysAgo * DAY),
      },
    });
    await admin.payment.create({
      data: {
        payerUserId: options.studentId,
        payeeAcademyId: academyId,
        courseOrderId: order.id,
        methodKey: 'academy_bank_transfer',
        methodType: 'manual_bank_transfer',
        provider: options.provider ?? 'academy_manual',
        amountMinorUnits: options.amount,
        currency: 'EGP',
        status: options.paymentStatus ?? 'succeeded',
      },
    });
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    owner = await account('com02-owner');
    manager = await account('com02-manager');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'com02-org');
    orgId = org.id;
    await seedActiveSubscriptionForOrg(admin, orgId, 'com02');
    const academy = await seedAcademy(admin, orgId, 'com02-academy');
    academyId = academy.id;
    await seedAcademyMember(admin, academyId, owner.userId, 'owner');
    await admin.organizationMembership.create({
      data: {
        organizationId: orgId,
        userId: manager.userId,
        role: 'manager',
        permissions: [...ORGANIZATION_MANAGER_PERMISSIONS],
      },
    });
    await seedAcademyMember(admin, academyId, manager.userId, 'manager');

    const course = await seedCourse(admin, academyId, 'com02 course', {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
    });
    const buyers = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((x) => account(`com02-buyer-${x}`)),
    );
    // Counted: approved 3 days ago, approved 40 days ago.
    await sale({
      studentId: buyers[0].userId,
      courseId: course.id,
      amount: 119000n,
      paidDaysAgo: 3,
    });
    await sale({
      studentId: buyers[1].userId,
      courseId: course.id,
      amount: 50000n,
      paidDaysAgo: 40,
    });
    // Not counted: refunded order, rejected payment, a non-manual payment.
    await sale({
      studentId: buyers[2].userId,
      courseId: course.id,
      amount: 7000n,
      paidDaysAgo: 2,
      orderStatus: 'refunded',
    });
    await sale({
      studentId: buyers[3].userId,
      courseId: course.id,
      amount: 9000n,
      paidDaysAgo: 1,
      orderStatus: 'pending_payment',
      paymentStatus: 'failed',
    });
    await sale({
      studentId: buyers[4].userId,
      courseId: course.id,
      amount: 11000n,
      paidDaysAgo: 1,
      provider: 'atlas_manual',
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  const expected = {
    periods: [
      { days: 7, totals: [{ currency: 'EGP', amountMinorUnits: 119000, count: 1 }] },
      { days: 30, totals: [{ currency: 'EGP', amountMinorUnits: 119000, count: 1 }] },
      { days: 90, totals: [{ currency: 'EGP', amountMinorUnits: 169000, count: 2 }] },
    ],
  };

  it('shows the owner approved manual sales per window on the academy dashboard', async () => {
    const res = await get(`/academies/${academyId}/dashboard`, owner.accessToken).expect(
      200,
    );
    // Ledger revenue stays "not tracked" (no Atlas Payments) — this is a separate figure.
    expect(res.body.revenue.tracked).toBe(false);
    expect(res.body.revenue.totals).toEqual([]);
    expect(res.body.revenue.manualSales).toEqual(expected);
  });

  it('shows the same totals on the organization dashboard', async () => {
    const res = await get(`/organizations/${orgId}/dashboard`, owner.accessToken).expect(
      200,
    );
    expect(res.body.revenue.manualSales).toEqual(expected);
  });

  it('gives an academy manager no sales figures', async () => {
    const res = await get(
      `/academies/${academyId}/dashboard`,
      manager.accessToken,
    ).expect(200);
    expect(res.body.revenue.manualSales).toBeNull();
  });
});
