/**
 * D5-5 (B0-COM-02 residual) — the academy Revenue page's read,
 * `GET academies/:id/payouts/revenue-summary`, reports the academy's manual
 * sales beside the Atlas Payments ledger balance.
 *
 * The ledger only holds Atlas Payments sales (not launched, B0-COM-03), so
 * an academy selling by bank transfer saw an empty "revenue" there. The
 * summary now carries `manualSales` — the dashboard card's figure, from the
 * same query: succeeded academy-manual payments whose order is still `paid`,
 * gross, per 7/30/90 days by the order's `paidAt` — and keeps `academyId`
 * and `unsettled` exactly as before.
 *
 *   ARM-01  figures: approved paid sales counted per window; refunded,
 *           rejected and non-manual payments excluded; a sibling academy's
 *           and another organization's sales never counted; the ledger
 *           balance is still reported separately and unchanged
 *   ARM-02  the same figures as the academy dashboard card
 *   ARM-03  authorization: organization owner only — an academy manager, an
 *           instructor, another organization's owner and an anonymous
 *           caller get no figures
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  fixtureUsers,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseOrder,
  seedOrganizationWithOwner,
  seedRevenueLedgerEntry,
} from './utils/db-admin';
import { ORGANIZATION_MANAGER_PERMISSIONS } from '../src/tenancy/constants/organization-permissions.constants';

jest.setTimeout(60000);

const DAY = 24 * 60 * 60 * 1000;

describe('Academy revenue summary — manual sales (e2e) — D5-5', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let owner: { userId: string; token: string };
  let manager: { userId: string; token: string };
  let instructor: { userId: string; token: string };
  let otherOwner: { userId: string; token: string };
  let orgId: string;
  let academyId: string;
  let siblingId: string;
  let otherAcademyId: string;

  async function account(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery-arm';
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
      token: signIn.body.accessToken as string,
    };
  }

  async function buyer(label: string) {
    const user = await fixtureUsers().create({
      data: { email: uniqueTestEmail(label), name: label },
    });
    return user.id;
  }

  async function sale(options: {
    organizationId: string;
    academyId: string;
    courseId: string;
    amount: bigint;
    paidDaysAgo: number;
    orderStatus?: 'paid' | 'refunded' | 'pending_payment';
    paymentStatus?: 'succeeded' | 'failed';
    provider?: string;
    currency?: string;
  }) {
    const studentId = await buyer('arm-buyer');
    const order = await seedCourseOrder(
      admin,
      studentId,
      options.courseId,
      options.academyId,
      options.organizationId,
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
        payerUserId: studentId,
        payeeAcademyId: options.academyId,
        courseOrderId: order.id,
        methodKey: 'academy_bank_transfer',
        methodType: 'manual_bank_transfer',
        provider: options.provider ?? 'academy_manual',
        amountMinorUnits: options.amount,
        currency: options.currency ?? 'EGP',
        status: options.paymentStatus ?? 'succeeded',
      },
    });
    return order;
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    owner = await account('arm-owner');
    manager = await account('arm-manager');
    instructor = await account('arm-instructor');
    otherOwner = await account('arm-other-owner');

    const org = await seedOrganizationWithOwner(admin, owner.userId, 'arm-org');
    orgId = org.id;
    await seedActiveSubscriptionForOrg(admin, orgId, 'arm');
    const academy = await seedAcademy(admin, orgId, 'arm-academy');
    academyId = academy.id;
    siblingId = (await seedAcademy(admin, orgId, 'arm-sibling')).id;
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
    await admin.organizationMembership.create({
      data: { organizationId: orgId, userId: instructor.userId, role: 'instructor' },
    });
    await seedAcademyMember(admin, academyId, instructor.userId, 'instructor');

    const otherOrg = await seedOrganizationWithOwner(
      admin,
      otherOwner.userId,
      'arm-other',
    );
    otherAcademyId = (await seedAcademy(admin, otherOrg.id, 'arm-other-academy')).id;
    await seedAcademyMember(admin, otherAcademyId, otherOwner.userId, 'owner');

    const paidCourse = {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
    } as const;
    const course = await seedCourse(admin, academyId, 'arm course', paidCourse);
    const siblingCourse = await seedCourse(
      admin,
      siblingId,
      'arm sibling course',
      paidCourse,
    );
    const otherCourse = await seedCourse(
      admin,
      otherAcademyId,
      'arm other course',
      paidCourse,
    );
    const here = { organizationId: orgId, academyId, courseId: course.id };

    // Counted: approved 3 and 40 days ago (EGP), and 10 days ago in USD.
    await sale({ ...here, amount: 119000n, paidDaysAgo: 3 });
    const ledgerOrder = await sale({ ...here, amount: 50000n, paidDaysAgo: 40 });
    await sale({ ...here, amount: 2500n, paidDaysAgo: 10, currency: 'USD' });
    // Not counted: refunded order, rejected payment, a non-manual payment,
    // an approval older than 90 days.
    await sale({ ...here, amount: 7000n, paidDaysAgo: 2, orderStatus: 'refunded' });
    await sale({
      ...here,
      amount: 9000n,
      paidDaysAgo: 1,
      orderStatus: 'pending_payment',
      paymentStatus: 'failed',
    });
    await sale({ ...here, amount: 11000n, paidDaysAgo: 1, provider: 'atlas_manual' });
    await sale({ ...here, amount: 13000n, paidDaysAgo: 120 });
    // Not counted here: the sibling academy and another organization.
    await sale({
      organizationId: orgId,
      academyId: siblingId,
      courseId: siblingCourse.id,
      amount: 17000n,
      paidDaysAgo: 2,
    });
    await sale({
      organizationId: otherOrg.id,
      academyId: otherAcademyId,
      courseId: otherCourse.id,
      amount: 19000n,
      paidDaysAgo: 2,
    });

    // One Atlas Payments ledger row, to show the ledger balance is still
    // reported on its own and is not mixed into manual sales.
    await seedRevenueLedgerEntry(admin, academyId, ledgerOrder.id, {
      entryType: 'sale',
      amountMinorUnits: 4200n,
      currency: 'USD',
      occurredAt: new Date(Date.now() - DAY),
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => flush());

  const summary = (id: string, token?: string) => {
    const req = request(app.getHttpServer()).get(
      `/academies/${id}/payouts/revenue-summary`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const sortTotals = (totals: { currency: string }[]) =>
    [...totals].sort((a, b) => a.currency.localeCompare(b.currency));

  it('ARM-01 — counts approved paid manual sales per window and keeps the ledger balance separate', async () => {
    const res = await summary(academyId, owner.token).expect(200);

    // The existing contract is unchanged.
    expect(res.body.academyId).toBe(academyId);
    expect(res.body.unsettled).toEqual([{ currency: 'USD', amountMinorUnits: 4200 }]);

    const periods = (
      res.body.manualSales.periods as { days: number; totals: { currency: string }[] }[]
    ).map((period) => ({ days: period.days, totals: sortTotals(period.totals) }));
    expect(periods).toEqual([
      { days: 7, totals: [{ currency: 'EGP', amountMinorUnits: 119000, count: 1 }] },
      {
        days: 30,
        totals: [
          { currency: 'EGP', amountMinorUnits: 119000, count: 1 },
          { currency: 'USD', amountMinorUnits: 2500, count: 1 },
        ],
      },
      {
        days: 90,
        totals: [
          { currency: 'EGP', amountMinorUnits: 169000, count: 2 },
          { currency: 'USD', amountMinorUnits: 2500, count: 1 },
        ],
      },
    ]);
  });

  it('ARM-02 — reports exactly the academy dashboard card figure', async () => {
    const [revenuePage, dashboard] = await Promise.all([
      summary(academyId, owner.token).expect(200),
      request(app.getHttpServer())
        .get(`/academies/${academyId}/dashboard`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200),
    ]);
    const normalise = (value: {
      periods: { days: number; totals: { currency: string }[] }[];
    }) =>
      value.periods.map((period) => ({
        days: period.days,
        totals: sortTotals(period.totals),
      }));
    expect(normalise(revenuePage.body.manualSales)).toEqual(
      normalise(dashboard.body.revenue.manualSales),
    );
  });

  it('ARM-03 — only the organization owner gets figures', async () => {
    for (const caller of [manager, instructor]) {
      const refused = await summary(academyId, caller.token).expect(403);
      expect(refused.body.manualSales).toBeUndefined();
      expect(JSON.stringify(refused.body)).not.toContain('119000');
    }
    // Another organization's owner: refused at the academy boundary.
    const foreign = await summary(academyId, otherOwner.token).expect(403);
    expect(JSON.stringify(foreign.body)).not.toContain('119000');
    // Anonymous.
    await summary(academyId).expect(401);

    // The other owner reading THEIR academy sees only their own sale.
    const own = await summary(otherAcademyId, otherOwner.token).expect(200);
    const ninety = own.body.manualSales.periods.find(
      (period: { days: number }) => period.days === 90,
    );
    expect(ninety.totals).toEqual([
      { currency: 'EGP', amountMinorUnits: 19000, count: 1 },
    ]);
  });
});
