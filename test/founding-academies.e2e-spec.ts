/**
 * B2 — Founding Academies (e2e).
 *
 *  - Platform Owner only: a tenant owner gets 403 on every route.
 *  - Seats: 1..20, the 21st is refused, concurrent creates never exceed 20.
 *  - Pricing is decided server-side from the organization's membership:
 *    a member's yearly checkout of the locked plan is at the locked price
 *    (also after a catalog price increase), a non-member sending the same
 *    request — even with a price or founding field in the body — gets the
 *    catalog price, a renewal starting after the lock end is at the
 *    catalog price, and revoking returns the next renewal to the catalog
 *    while the paid period stays as it was.
 *  - A family change re-locks at that plan's annual catalog price today.
 *  - Email founders: preview count, confirm-count guard, one audit row per
 *    recipient.
 *  - The renewal price notice is sent once, before a renewal that leaves
 *    the lock at a different price.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Plan, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedTenantSubscription,
} from './utils/db-admin';
import { FoundingNoticeService } from '../src/founding/services/founding-notice.service';

jest.setTimeout(120000);

const DAY = 24 * 60 * 60 * 1000;

describe('Founding Academies (e2e) — B2', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let po: { userId: string; accessToken: string };
  let owner: { userId: string; accessToken: string };
  let planA: Plan;
  let planB: Plan;
  const createdPlanIds: string[] = [];
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await http()
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
    };
  }

  async function seedCatalogPlan(label: string, monthly: number, yearly: number) {
    const plan = await admin.plan.create({
      data: {
        key: `b2-${label}-${tag}`,
        name: `B2 ${label}`,
        status: 'active',
        displayOrder: 90 + createdPlanIds.length,
        family: 'normal',
        limits: { academies: 1, students: 100, instructors: 3, staff: 3, courses: 20 },
        features: {},
        pricing: {
          amount: monthly,
          currency: 'EGP',
          billingCycle: 'monthly',
          yearlyAmount: yearly,
        },
      },
    });
    createdPlanIds.push(plan.id);
    return plan;
  }

  async function orgWithYearlySubscription(label: string, periodEnd: Date, plan: Plan) {
    const org = await seedOrganizationWithOwner(admin, owner.userId, `b2-${label}`);
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    await admin.tenantSubscription.update({
      where: { organizationId: org.id },
      data: {
        billingCycle: 'yearly',
        currentPeriodStart: new Date(periodEnd.getTime() - 365 * DAY),
        currentPeriodEnd: periodEnd,
      },
    });
    return org;
  }

  function addFounding(organizationId: string, planKey: string) {
    return http()
      .post('/platform-founding-academies')
      .set(bearer(po.accessToken))
      .send({ organizationId, planKey });
  }

  function yearlyCheckout(organizationId: string, planKey: string, extra: object = {}) {
    return http()
      .post(`/organizations/${organizationId}/checkouts`)
      .set(bearer(owner.accessToken))
      .send({
        target: { type: 'plan_subscription', planKey },
        billingCycle: 'yearly',
        idempotencyKey: `b2-${Math.random().toString(36).slice(2)}`,
        ...extra,
      });
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
    po = await signUp('b2-po');
    await admin.user.update({
      where: { id: po.userId },
      data: { isPlatformOwner: true },
    });
    owner = await signUp('b2-owner');
    // The programme is global: start from no held seats.
    await admin.foundingMembership.updateMany({
      where: { status: { not: 'revoked' } },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'e2e reset' },
    });
    planA = await seedCatalogPlan('a', 1000, 10000);
    planB = await seedCatalogPlan('b', 2000, 20000);
  });

  beforeEach(async () => {
    await flush();
  });

  afterAll(async () => {
    await admin.foundingMembership.updateMany({
      where: { status: { not: 'revoked' } },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'e2e cleanup' },
    });
    // Out of every catalog list for the specs that follow.
    await admin.plan.updateMany({
      where: { id: { in: createdPlanIds } },
      data: { status: 'archived' },
    });
    await admin.$disconnect();
    await app.close();
  });

  it('refuses every route to a non-Platform-Owner and to an anonymous caller', async () => {
    await http().get('/platform-founding-academies').expect(401);
    for (const [method, path] of [
      ['get', '/platform-founding-academies'],
      ['get', '/platform-founding-academies/summary'],
      ['get', '/platform-founding-academies/export'],
      ['post', '/platform-founding-academies'],
      ['post', '/platform-founding-academies/email'],
    ] as const) {
      const response = await http()[method](path).set(bearer(owner.accessToken)).send({});
      expect([403, 404]).toContain(response.status);
    }
  });

  it('prices a member yearly checkout at the locked price, and a non-member at the catalog price', async () => {
    const soon = new Date(Date.now() + 10 * DAY);
    const member = await orgWithYearlySubscription('member', soon, planA);
    const outsider = await orgWithYearlySubscription('outsider', soon, planA);

    const created = await addFounding(member.id, planA.key).expect(201);
    expect(created.body).toMatchObject({
      seatNumber: expect.any(Number),
      status: 'active',
      lockedPrice: { amount: 10000, currency: 'EGP' },
      plan: { key: planA.key },
    });
    expect(created.body.nextRenewal).toMatchObject({ amount: 10000, locked: true });
    expect(created.body.timeline.map((e: { action: string }) => e.action)).toContain(
      'platform.founding.created',
    );

    // The catalog price goes up after the lock was taken.
    await admin.plan.update({
      where: { id: planA.id },
      data: {
        pricing: {
          amount: 1200,
          currency: 'EGP',
          billingCycle: 'monthly',
          yearlyAmount: 12000,
        },
      },
    });

    const memberCheckout = await yearlyCheckout(member.id, planA.key).expect(201);
    expect(memberCheckout.body.snapshot.price).toEqual({
      amountMinorUnits: 1000000,
      currency: 'EGP',
    });
    expect(memberCheckout.body.snapshot.founding.lockEndsAt).toBe(
      created.body.lockEndsAt,
    );

    // Monthly stays at the catalog price even for a member.
    const monthly = await http()
      .post(`/organizations/${member.id}/checkouts`)
      .set(bearer(owner.accessToken))
      .send({
        target: { type: 'plan_subscription', planKey: planA.key },
        billingCycle: 'monthly',
        idempotencyKey: `b2-monthly-${tag}`,
      })
      .expect(201);
    expect(monthly.body.snapshot.price.amountMinorUnits).toBe(120000);
    expect(monthly.body.snapshot.founding).toBeUndefined();

    // A non-member sending the same request (plus anything a client could
    // invent) gets the catalog price, and nothing about the programme.
    const outsiderCheckout = await yearlyCheckout(outsider.id, planA.key, {
      price: { amountMinorUnits: 1000000, currency: 'EGP' },
      founding: { lockEndsAt: created.body.lockEndsAt },
      foundingMembershipId: created.body.id,
    });
    if (outsiderCheckout.status === 201) {
      expect(outsiderCheckout.body.snapshot.price).toEqual({
        amountMinorUnits: 1200000,
        currency: 'EGP',
      });
      expect(outsiderCheckout.body.snapshot.founding).toBeUndefined();
    } else {
      expect(outsiderCheckout.status).toBe(400);
    }

    // The owner's subscription screen shows the lock and the renewal amount.
    const subscription = await http()
      .get(`/organizations/${member.id}/subscription`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(subscription.body.founding).toMatchObject({
      status: 'active',
      lockedPrice: { amount: 10000, currency: 'EGP' },
      lockEndsAt: created.body.lockEndsAt,
      nextRenewal: { amount: 10000, locked: true },
    });
    const outsiderSubscription = await http()
      .get(`/organizations/${outsider.id}/subscription`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(outsiderSubscription.body.founding).toBeUndefined();
  });

  it('prices a renewal starting after the lock end at the catalog price, and notices it once', async () => {
    const periodEnd = new Date(Date.now() + 20 * DAY);
    const org = await orgWithYearlySubscription('after-lock', periodEnd, planB);
    const created = await addFounding(org.id, planB.key).expect(201);
    // Lock started ~24 months ago; it ends before the renewal starts.
    await admin.foundingMembership.update({
      where: { id: created.body.id },
      data: {
        lockStartsAt: new Date(Date.now() - 720 * DAY),
        lockEndsAt: new Date(Date.now() + 5 * DAY),
      },
    });
    await admin.plan.update({
      where: { id: planB.id },
      data: {
        pricing: {
          amount: 2500,
          currency: 'EGP',
          billingCycle: 'monthly',
          yearlyAmount: 25000,
        },
      },
    });

    const checkout = await yearlyCheckout(org.id, planB.key).expect(201);
    expect(checkout.body.snapshot.price.amountMinorUnits).toBe(2500000);
    expect(checkout.body.snapshot.founding).toBeUndefined();

    const notices = app.get(FoundingNoticeService);
    const first = await notices.sendRenewalPriceNotices(po.userId, new Date());
    expect(first).toBeGreaterThanOrEqual(1);
    const audit = await admin.auditLogEntry.findMany({
      where: {
        targetId: created.body.id,
        action: 'platform.founding.renewal_price_notice_sent',
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].context).toMatchObject({ renewalAmount: 25000, lockedAmount: 20000 });
    await notices.sendRenewalPriceNotices(po.userId, new Date());
    expect(
      await admin.auditLogEntry.count({
        where: {
          targetId: created.body.id,
          action: 'platform.founding.renewal_price_notice_sent',
        },
      }),
    ).toBe(1);
  });

  it('re-locks a family change at that plan price today, and revoke returns the next renewal to the catalog', async () => {
    // Within 30 days of the period end, so moving to another plan is
    // self-serve (CF-24 refuses it earlier in an annual period).
    const periodEnd = new Date(Date.now() + 20 * DAY);
    const org = await orgWithYearlySubscription('family', periodEnd, planA);
    const created = await addFounding(org.id, planA.key).expect(201);

    const changed = await http()
      .patch(`/platform-founding-academies/${created.body.id}`)
      .set(bearer(po.accessToken))
      .send({
        expectedUpdatedAt: created.body.updatedAt,
        planKey: planB.key,
        conciergeHoursUsed: 2.5,
      })
      .expect(200);
    const currentB = (await admin.plan.findUniqueOrThrow({ where: { id: planB.id } }))
      .pricing as {
      yearlyAmount: number;
    };
    expect(changed.body.plan.key).toBe(planB.key);
    expect(changed.body.lockedPrice.amount).toBe(currentB.yearlyAmount);
    expect(changed.body.lockEndsAt).toBe(created.body.lockEndsAt);
    expect(changed.body.conciergeHoursUsed).toBe(2.5);
    const actions = changed.body.timeline.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'platform.founding.plan_changed',
        'platform.founding.updated',
      ]),
    );

    // A stale edit is refused.
    await http()
      .patch(`/platform-founding-academies/${created.body.id}`)
      .set(bearer(po.accessToken))
      .send({ expectedUpdatedAt: created.body.updatedAt, notes: 'late' })
      .expect(409);

    // The new plan's checkout is now at the re-locked price.
    const relocked = await yearlyCheckout(org.id, planB.key).expect(201);
    expect(relocked.body.snapshot.price.amountMinorUnits).toBe(
      currentB.yearlyAmount * 100,
    );
    expect(relocked.body.snapshot.founding).toBeDefined();
    // Raise B's catalog price: the lock holds until revoked.
    await admin.plan.update({
      where: { id: planB.id },
      data: {
        pricing: {
          amount: 3000,
          currency: 'EGP',
          billingCycle: 'monthly',
          yearlyAmount: 30000,
        },
      },
    });
    const stillLocked = await yearlyCheckout(org.id, planB.key).expect(201);
    expect(stillLocked.body.snapshot.price.amountMinorUnits).toBe(
      currentB.yearlyAmount * 100,
    );

    const revoked = await http()
      .post(`/platform-founding-academies/${created.body.id}/revoke`)
      .set(bearer(po.accessToken))
      .send({ reason: 'Asked to leave the programme' })
      .expect(200);
    expect(revoked.body.status).toBe('revoked');

    const after = await yearlyCheckout(org.id, planB.key).expect(201);
    expect(after.body.snapshot.price.amountMinorUnits).toBe(3000000);
    expect(after.body.snapshot.founding).toBeUndefined();
    const sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(sub.currentPeriodEnd?.toISOString()).toBe(periodEnd.toISOString());
  });

  it('emails founders with a confirmed count and one audit row per recipient', async () => {
    const list = await http()
      .get('/platform-founding-academies')
      .query({ status: 'active', pageSize: 100 })
      .set(bearer(po.accessToken))
      .expect(200);
    const ids = list.body.items.map((item: { id: string }) => item.id);
    expect(ids.length).toBeGreaterThan(0);

    const preview = await http()
      .post('/platform-founding-academies/email/preview')
      .set(bearer(po.accessToken))
      .send({ audience: 'selected', membershipIds: [ids[0]] })
      .expect(200);
    expect(preview.body.recipientCount).toBe(1);

    const body = {
      audience: 'all_active',
      subjectEn: 'Your setup session',
      bodyEn: 'Hello,\n\nLet us book your setup session.',
      subjectAr: 'جلسة التجهيز',
      bodyAr: 'أهلًا،\n\nخلينا نحدد ميعاد جلسة التجهيز.',
    };
    await http()
      .post('/platform-founding-academies/email')
      .set(bearer(po.accessToken))
      .send({ ...body, confirmRecipientCount: ids.length + 1 })
      .expect(409);
    const sent = await http()
      .post('/platform-founding-academies/email')
      .set(bearer(po.accessToken))
      .send({ ...body, confirmRecipientCount: ids.length })
      .expect(202);
    expect(sent.body.queued).toBe(ids.length);
    const rows = await admin.auditLogEntry.findMany({
      where: { action: 'platform.founding.emailed' },
    });
    const forSend = rows.filter(
      (row) => (row.context as { sendId?: string } | null)?.sendId === sent.body.sendId,
    );
    expect(forSend).toHaveLength(ids.length);
    expect(JSON.stringify(forSend)).not.toContain('setup session');

    await http()
      .post('/platform-founding-academies/email/preview')
      .set(bearer(po.accessToken))
      .send({
        audience: 'selected',
        membershipIds: ['00000000-0000-4000-8000-000000000000'],
      })
      .expect(400);
  });

  it('never assigns more than 20 seats, even to concurrent creates', async () => {
    const summary = await http()
      .get('/platform-founding-academies/summary')
      .set(bearer(po.accessToken))
      .expect(200);
    const free = summary.body.seatsAvailable as number;
    const orgs = [];
    for (let i = 0; i < free + 2; i++) {
      orgs.push(await seedOrganizationWithOwner(admin, owner.userId, `b2-seat-${i}`));
    }
    // Fill all but two seats one by one…
    for (const org of orgs.slice(0, free - 2)) {
      await addFounding(org.id, planA.key).expect(201);
    }
    // …then race four creates for the last two seats.
    const raced = await Promise.all(
      orgs.slice(free - 2).map((org) => addFounding(org.id, planA.key)),
    );
    expect(raced.filter((r) => r.status === 201)).toHaveLength(2);
    expect(raced.filter((r) => r.status === 409)).toHaveLength(2);

    const held = await admin.foundingMembership.findMany({
      where: { status: { not: 'revoked' } },
    });
    expect(held).toHaveLength(20);
    expect(new Set(held.map((row) => row.seatNumber)).size).toBe(20);
    expect(Math.max(...held.map((row) => row.seatNumber))).toBe(20);

    const extra = await seedOrganizationWithOwner(admin, owner.userId, 'b2-seat-21');
    const refused = await addFounding(extra.id, planA.key).expect(409);
    expect(refused.body.error.messageKey).toBe('errors.founding.seatsFull');

    const full = await http()
      .get('/platform-founding-academies/summary')
      .set(bearer(po.accessToken))
      .expect(200);
    expect(full.body).toMatchObject({ seatCap: 20, seatsTaken: 20, seatsAvailable: 0 });

    const csv = await http()
      .get('/platform-founding-academies/export')
      .set(bearer(po.accessToken))
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n').filter(Boolean).length).toBeGreaterThanOrEqual(21);
  });

  it('refuses a plan outside the self-serve catalog exactly like an unknown one', async () => {
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'b2-hidden');
    const hidden = await admin.plan.create({
      data: {
        key: `b2-hidden-${tag}`,
        name: 'B2 hidden',
        status: 'active',
        displayOrder: 0,
        family: 'normal',
        limits: {},
        features: {},
        pricing: {
          amount: 1,
          currency: 'EGP',
          billingCycle: 'monthly',
          yearlyAmount: 10,
        },
      },
    });
    createdPlanIds.push(hidden.id);
    const a = await http()
      .get('/platform-founding-academies/quote')
      .query({ organizationId: org.id, planKey: hidden.key })
      .set(bearer(po.accessToken));
    const b = await http()
      .get('/platform-founding-academies/quote')
      .query({ organizationId: org.id, planKey: `no-such-plan-${tag}` })
      .set(bearer(po.accessToken));
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(a.body.error.messageKey).toBe('errors.founding.planNotEligible');
    expect(b.body.error.messageKey).toBe(a.body.error.messageKey);
  });
});
