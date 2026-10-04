/**
 * W8 — gifted setup days on the first paid subscription (8A), durable
 * trial/gift eligibility across account deletion (8B), and the D1–D4
 * regressions, end to end against the real database, RLS and HTTP stack.
 *
 * Every customer here is a fresh address, so ledger state from earlier runs
 * on this shared database can never satisfy an assertion by accident.
 */
import type { INestApplication } from '@nestjs/common';
import type { Plan, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import { createAdminPrisma, seedPaymentMethod, seedPlan } from './utils/db-admin';
import { deletionCodeFor } from './utils/account-deletion';
import { ledgerSubjectHash, legacyLedgerSubjectHash } from './utils/customer-identity';
import { PrismaService } from '../src/database/prisma.service';
import { PaymentWebhookService } from '../src/billing/services/payment-webhook.service';
import { TrialForensicsScrubService } from '../src/retention/services/trial-forensics-scrub.service';
import { addBillingPeriod, DAY_MS } from '../src/billing/utils/billing-period.util';

const PASSWORD = 'correct-horse-battery';
const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface Account {
  readonly email: string;
  readonly userId: string;
  readonly token: string;
}

describe('W8 gifted setup days & durable eligibility (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appPrisma: PrismaService;
  let flushRateLimitKeys: () => Promise<void>;
  let platform: Account;
  let methodKey: string;
  let giftPlan: Plan;
  let yearlyGiftPlan: Plan;

  const stamp = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    appPrisma = testApp.prisma;
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    const owner = await register(`w8-platform-${stamp()}@atlas.test`);
    await admin.user.update({
      where: { id: owner.userId },
      data: { isPlatformOwner: true },
    });
    platform = await signIn(owner.email);

    methodKey = (await seedPaymentMethod(admin, 'w8-method')).key;
    giftPlan = await seedPlan(admin, 'w8-gift', {
      pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
    });
    giftPlan = await admin.plan.update({
      where: { id: giftPlan.id },
      data: { giftedDaysMonthly: 7, giftedDaysYearly: 14 },
    });
    yearlyGiftPlan = await seedPlan(admin, 'w8-yearly', {
      pricing: { amount: 790, currency: 'USD', billingCycle: 'yearly' },
    });
    yearlyGiftPlan = await admin.plan.update({
      where: { id: yearlyGiftPlan.id },
      data: { giftedDaysMonthly: 5, giftedDaysYearly: 14 },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // ---------------------------------------------------------------- helpers

  async function signIn(email: string): Promise<Account> {
    const res = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { email, userId: res.body.user.id, token: res.body.accessToken };
  }

  async function register(email: string): Promise<Account> {
    await http()
      .post('/auth/register')
      .send({ name: 'W8 Tester', email, password: PASSWORD })
      .expect(201);
    return signIn(email);
  }

  async function createOrg(token: string): Promise<string> {
    const res = await http()
      .post('/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `W8 Org ${stamp()}` })
      .expect(201);
    return res.body.id as string;
  }

  async function startTrial(token: string, orgId: string) {
    const res = await http()
      .post(`/organizations/${orgId}/subscription/trial`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: true });
    return res.body as { started?: boolean };
  }

  /** checkout → payment → proof: leaves a payment pending review. */
  async function pay(
    token: string,
    orgId: string,
    planKey: string,
    billingCycle?: 'monthly' | 'yearly',
  ): Promise<string> {
    const checkout = await http()
      .post(`/organizations/${orgId}/checkouts`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        target: { type: 'plan_subscription', planKey },
        ...(billingCycle ? { billingCycle } : {}),
        idempotencyKey: `w8-${stamp()}`,
      })
      .expect(201);
    const payment = await http()
      .post(`/organizations/${orgId}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checkoutId: checkout.body.id, methodKey })
      .expect(201);
    await http()
      .patch(`/organizations/${orgId}/payments/${payment.body.id}/proof`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
      .expect(200);
    return payment.body.id as string;
  }

  function approve(paymentId: string) {
    return http()
      .post(`/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${platform.token}`)
      .send({ notes: 'w8' });
  }

  function subscription(orgId: string) {
    return admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
  }

  async function lifecycle(token: string, orgId: string) {
    const res = await http()
      .get(`/organizations/${orgId}/subscription/lifecycle`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body;
  }

  /** The receipt (`lifecycle.subscription.activated`) outbox row for one paid period. */
  async function receiptValues(orgId: string, periodEnd: Date) {
    const rows = await admin.communicationOutbox.findMany({
      where: { organizationId: orgId, key: 'lifecycle.subscription.activated' },
    });
    const row = rows.find(
      (r) =>
        (r.values as Record<string, unknown> | null)?.anchorAt ===
        periodEnd.toISOString(),
    );
    expect(row).toBeDefined();
    return row!.values as Record<string, unknown>;
  }

  /** The `formatLifecycleInstant` shape every lifecycle email uses. */
  const utc = (at: Date) =>
    `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;

  function giftLedgerCount(email: string) {
    return admin.paidGiftRedemption.count({
      where: { subjectHash: ledgerSubjectHash(email) },
    });
  }

  function trialLedgerCount(email: string) {
    return admin.trialRedemption.count({
      where: {
        subjectHash: { in: [ledgerSubjectHash(email), legacyLedgerSubjectHash(email)] },
      },
    });
  }

  async function deleteAccount(account: Account) {
    await http()
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ ...(await deletionCodeFor(app, admin, account.token)), confirm: true })
      .expect(200);
  }

  // ------------------------------------------------------------------ 8A

  it('the first approved payment grants N gifted days, then a FULL paid period from the gift end', async () => {
    const owner = await register(`w8-first-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    expect((await lifecycle(owner.token, orgId)).giftAvailable).toBe(true);

    const paymentId = await pay(owner.token, orgId, giftPlan.key, 'monthly');
    const before = Date.now();
    await approve(paymentId).expect(201);
    const after = Date.now();

    const row = await subscription(orgId);
    expect(row.status).toBe('active');
    expect(row.billingCycle).toBe('monthly');
    expect(row.giftedDays).toBe(7);
    expect(row.giftedPaymentId).toBe(paymentId);
    expect(row.giftedStartsAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.giftedStartsAt!.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(row.giftedEndsAt!.getTime() - row.giftedStartsAt!.getTime()).toBe(7 * DAY_MS);
    expect(row.currentPeriodStart).toEqual(row.giftedEndsAt);
    expect(row.currentPeriodEnd).toEqual(addBillingPeriod(row.giftedEndsAt!, 'monthly'));

    // Owner-facing reads carry the gift; giftAvailable flips to false.
    const life = await lifecycle(owner.token, orgId);
    expect(life).toMatchObject({
      giftedDays: 7,
      giftedDaysRemaining: 7,
      giftAvailable: false,
    });
    const api = await http()
      .get(`/organizations/${orgId}/subscription`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(api.body).toMatchObject({
      giftedDays: 7,
      giftedEndsAt: row.giftedEndsAt!.toISOString(),
      currentPeriodStart: row.giftedEndsAt!.toISOString(),
    });

    // Durable ledger row (v2, never the address) and a tenant audit entry.
    const ledger = await admin.paidGiftRedemption.findUniqueOrThrow({
      where: { subjectHash: ledgerSubjectHash(owner.email) },
    });
    expect(ledger).toMatchObject({
      hashVersion: 2,
      source: 'approval',
      organizationId: orgId,
      paymentId,
      giftedDays: 7,
      billingCycle: 'monthly',
    });
    expect(JSON.stringify(ledger)).not.toContain(owner.email);
    expect(
      await admin.auditLogEntry.count({
        where: { organizationId: orgId, action: 'subscription.gift.granted' },
      }),
    ).toBe(1);

    // The receipt carries the gift exactly as the approval recorded it:
    // gift period from the gift columns, paid period from the subscription.
    const receipt = await receiptValues(orgId, row.currentPeriodEnd!);
    expect(receipt).toMatchObject({
      giftedDays: 7,
      giftStartDate: utc(row.giftedStartsAt!),
      giftEndDate: utc(row.giftedEndsAt!),
      periodStartDate: utc(row.currentPeriodStart!),
      periodEndDate: utc(row.currentPeriodEnd!),
    });
    expect(receipt.periodStartDate).toBe(receipt.giftEndDate);
  });

  it('a renewal gets no gift: it extends from the current end and leaves the gift untouched', async () => {
    const owner = await register(`w8-renew-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    await approve(await pay(owner.token, orgId, giftPlan.key, 'monthly')).expect(201);
    const first = await subscription(orgId);

    await approve(await pay(owner.token, orgId, giftPlan.key, 'monthly')).expect(201);
    const second = await subscription(orgId);
    expect(second.currentPeriodStart).toEqual(first.currentPeriodEnd);
    expect(second.currentPeriodEnd).toEqual(
      addBillingPeriod(first.currentPeriodEnd!, 'monthly'),
    );
    expect(second.giftedDays).toBe(7);
    expect(second.giftedPaymentId).toBe(first.giftedPaymentId);
    expect(second.giftedEndsAt).toEqual(first.giftedEndsAt);
    expect(await giftLedgerCount(owner.email)).toBe(1);

    // The first receipt carried the gift; the renewal's carries none, even
    // though the gift columns are still set on the row.
    expect(await receiptValues(orgId, first.currentPeriodEnd!)).toMatchObject({
      giftedDays: 7,
    });
    const renewal = await receiptValues(orgId, second.currentPeriodEnd!);
    expect(renewal).toMatchObject({
      periodStartDate: utc(second.currentPeriodStart!),
      periodEndDate: utc(second.currentPeriodEnd!),
    });
    expect(renewal).not.toHaveProperty('giftedDays');
    expect(renewal).not.toHaveProperty('giftStartDate');
    expect(renewal).not.toHaveProperty('giftEndDate');
  });

  it('a second organization of the same owner email gets no gift', async () => {
    const owner = await register(`w8-twoorg-${stamp()}@atlas.test`);
    const orgA = await createOrg(owner.token);
    await approve(await pay(owner.token, orgA, giftPlan.key, 'monthly')).expect(201);
    expect((await subscription(orgA)).giftedDays).toBe(7);

    const orgB = await createOrg(owner.token);
    expect((await lifecycle(owner.token, orgB)).giftAvailable).toBe(false);
    const before = Date.now();
    await approve(await pay(owner.token, orgB, giftPlan.key, 'monthly')).expect(201);
    const b = await subscription(orgB);
    expect(b.status).toBe('active');
    expect(b.giftedDays).toBeNull();
    expect(b.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(b.currentPeriodEnd).toEqual(
      addBillingPeriod(b.currentPeriodStart!, 'monthly'),
    );
    expect(await giftLedgerCount(owner.email)).toBe(1);

    // An ineligible customer's receipt carries no gift fields at all.
    const receipt = await receiptValues(orgB, b.currentPeriodEnd!);
    expect(receipt).not.toHaveProperty('giftedDays');
    expect(receipt).not.toHaveProperty('giftStartDate');
    expect(receipt).not.toHaveProperty('giftEndDate');
  });

  it('a trialist who converts DOES get the gift (distinct from the trial)', async () => {
    const owner = await register(`w8-trialist-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    expect((await startTrial(owner.token, orgId)).started).toBe(true);
    expect((await subscription(orgId)).status).toBe('trialing');

    await approve(await pay(owner.token, orgId, giftPlan.key, 'monthly')).expect(201);
    const row = await subscription(orgId);
    expect(row.status).toBe('active');
    expect(row.giftedDays).toBe(7);
    expect(await trialLedgerCount(owner.email)).toBe(1);
    expect(await giftLedgerCount(owner.email)).toBe(1);
  });

  it('account deletion then re-signup with the same email: no trial and no gift', async () => {
    const email = `w8-deleted-${stamp()}@atlas.test`;
    const first = await register(email);
    const orgA = await createOrg(first.token);
    expect((await startTrial(first.token, orgA)).started).toBe(true);
    await approve(await pay(first.token, orgA, giftPlan.key, 'monthly')).expect(201);
    expect((await subscription(orgA)).giftedDays).toBe(7);

    await deleteAccount(first);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: first.userId } })).status,
    ).toBe('deleted');
    // The ledgers survive the anonymisation.
    expect(await trialLedgerCount(email)).toBe(1);
    expect(await giftLedgerCount(email)).toBe(1);

    const again = await register(email);
    expect(again.userId).not.toBe(first.userId);
    const orgB = await createOrg(again.token);
    const life = await lifecycle(again.token, orgB);
    expect(life.trialAvailable).toBe(false);
    expect(life.giftAvailable).toBe(false);
    expect((await startTrial(again.token, orgB)).started).toBe(false);
    expect((await subscription(orgB)).trialEndsAt).toBeNull();

    await approve(await pay(again.token, orgB, giftPlan.key, 'monthly')).expect(201);
    const b = await subscription(orgB);
    expect(b.status).toBe('active');
    expect(b.giftedDays).toBeNull();
    expect(await giftLedgerCount(email)).toBe(1);
  });

  it('a Gmail alias of an existing customer (dots, +tag, case) is the same identity', async () => {
    const s = stamp();
    const original = await register(`w8.alias.${s}@gmail.com`);
    const orgA = await createOrg(original.token);
    expect((await startTrial(original.token, orgA)).started).toBe(true);
    await approve(await pay(original.token, orgA, giftPlan.key, 'monthly')).expect(201);
    expect((await subscription(orgA)).giftedDays).toBe(7);

    const alias = await register(`W8Alias${s}+promo@gmail.com`);
    expect(ledgerSubjectHash(alias.email)).toBe(ledgerSubjectHash(original.email));
    const orgB = await createOrg(alias.token);
    expect((await startTrial(alias.token, orgB)).started).toBe(false);
    await approve(await pay(alias.token, orgB, giftPlan.key, 'monthly')).expect(201);
    expect((await subscription(orgB)).giftedDays).toBeNull();
    expect(await giftLedgerCount(original.email)).toBe(1);
  });

  it('two simultaneous first payments for the same identity produce exactly one gift', async () => {
    const owner = await register(`w8-race-${stamp()}@atlas.test`);
    const orgA = await createOrg(owner.token);
    const orgB = await createOrg(owner.token);
    const [payA, payB] = [
      await pay(owner.token, orgA, giftPlan.key, 'monthly'),
      await pay(owner.token, orgB, giftPlan.key, 'monthly'),
    ];

    const [resA, resB] = await Promise.all([approve(payA), approve(payB)]);
    expect([resA.status, resB.status]).toEqual([201, 201]);

    const [a, b] = await Promise.all([subscription(orgA), subscription(orgB)]);
    expect([a.status, b.status]).toEqual(['active', 'active']);
    const gifted = [a, b].filter((row) => row.giftedDays !== null);
    expect(gifted).toHaveLength(1);
    expect(await giftLedgerCount(owner.email)).toBe(1);
  });

  it('D4 — a natively yearly plan bought without an explicit cycle is applied as YEARLY (14-day gift)', async () => {
    const owner = await register(`w8-yearly-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    const paymentId = await pay(owner.token, orgId, yearlyGiftPlan.key);
    const checkout = await admin.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { checkout: { select: { billingCycle: true } } },
    });
    expect(checkout.checkout?.billingCycle).toBe('yearly');

    await approve(paymentId).expect(201);
    const row = await subscription(orgId);
    expect(row.billingCycle).toBe('yearly');
    expect(row.giftedDays).toBe(14);
    expect(row.currentPeriodEnd).toEqual(addBillingPeriod(row.giftedEndsAt!, 'yearly'));
  });

  it('D4 — a legacy checkout row with a NULL cycle and a yearly snapshot is still applied as yearly', async () => {
    const owner = await register(`w8-legacy-cycle-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    const paymentId = await pay(owner.token, orgId, yearlyGiftPlan.key);
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await admin.checkout.update({
      where: { id: payment.checkoutId! },
      data: { billingCycle: null },
    });

    await approve(paymentId).expect(201);
    const row = await subscription(orgId);
    expect(row.billingCycle).toBe('yearly');
    expect(row.currentPeriodEnd).toEqual(
      addBillingPeriod(row.currentPeriodStart!, 'yearly'),
    );
  });

  // ------------------------------------------------------------ D1 / D2

  it('D1 — cancel, renew, cancel again: the second cancel is recorded and sets cancelAtPeriodEnd', async () => {
    const owner = await register(`w8-cancel-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    await approve(await pay(owner.token, orgId, giftPlan.key, 'monthly')).expect(201);

    const cancel = () =>
      http()
        .post(`/organizations/${orgId}/subscription/cancel`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ confirm: true, reason: 'not_using_it' })
        .expect(200);

    expect((await cancel()).body).toMatchObject({
      cancelled: true,
      alreadyCancelled: false,
    });
    expect((await subscription(orgId)).cancelAtPeriodEnd).toBe(true);
    // Same period: idempotent.
    expect((await cancel()).body.alreadyCancelled).toBe(true);

    await approve(await pay(owner.token, orgId, giftPlan.key, 'monthly')).expect(201);
    const renewed = await subscription(orgId);
    expect(renewed.cancelAtPeriodEnd).toBe(false);

    const second = await cancel();
    expect(second.body).toMatchObject({
      cancelled: true,
      alreadyCancelled: false,
      effectiveAt: renewed.currentPeriodEnd!.toISOString(),
    });
    expect((await subscription(orgId)).cancelAtPeriodEnd).toBe(true);
    expect(
      await admin.subscriptionCancellation.count({
        where: { organizationId: orgId, kind: 'paid' },
      }),
    ).toBe(2);
  });

  it('D2 — a succeeded webhook after a manual approval does not apply a second period', async () => {
    const owner = await register(`w8-double-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    const paymentId = await pay(owner.token, orgId, giftPlan.key, 'monthly');
    await approve(paymentId).expect(201);
    const approved = await subscription(orgId);

    const webhook = app.get(PaymentWebhookService);
    await webhook.processEvent({
      provider: 'atlas_manual',
      eventId: `w8-evt-${stamp()}`,
      eventType: 'payment.succeeded',
      paymentId,
      occurredAt: new Date().toISOString(),
    });

    const after = await subscription(orgId);
    expect(after.currentPeriodStart).toEqual(approved.currentPeriodStart);
    expect(after.currentPeriodEnd).toEqual(approved.currentPeriodEnd);
  });

  it('D2 — an approval racing a succeeded webhook for the same payment applies exactly one period', async () => {
    const owner = await register(`w8-race-apply-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    const paymentId = await pay(owner.token, orgId, giftPlan.key, 'monthly');
    const webhook = app.get(PaymentWebhookService);

    await Promise.all([
      approve(paymentId),
      webhook.processEvent({
        provider: 'atlas_manual',
        eventId: `w8-evt-race-${stamp()}`,
        eventType: 'payment.succeeded',
        paymentId,
        occurredAt: new Date().toISOString(),
      }),
    ]);

    const row = await subscription(orgId);
    expect(row.status).toBe('active');
    expect(row.giftedDays).toBe(7);
    // One gift + ONE paid month — never a second month stacked on top.
    expect(row.currentPeriodStart).toEqual(row.giftedEndsAt);
    expect(row.currentPeriodEnd).toEqual(addBillingPeriod(row.giftedEndsAt!, 'monthly'));
  });

  // --------------------------------------------------------- plan admin

  it('plan admin: gifted days accept 5..15 / blank / 0 and reject everything else (DTO and DB CHECK)', async () => {
    const plan = await seedPlan(admin, 'w8-admin');
    const patch = async (body: Record<string, unknown>, expected: number) => {
      const current = await admin.plan.findUniqueOrThrow({ where: { id: plan.id } });
      return http()
        .patch(`/platform-plans/${plan.key}`)
        .set('Authorization', `Bearer ${platform.token}`)
        .send({ expectedVersion: current.version, ...body })
        .expect(expected);
    };

    for (const bad of [4, 16, 0.5, 7.5, '7', -3]) {
      await patch({ giftedDaysMonthly: bad }, 400);
      await patch({ giftedDaysYearly: bad }, 400);
    }
    const ok = await patch({ giftedDaysMonthly: 5, giftedDaysYearly: 15 }, 200);
    expect(ok.body).toMatchObject({ giftedDaysMonthly: 5, giftedDaysYearly: 15 });
    const cleared = await patch({ giftedDaysMonthly: 0, giftedDaysYearly: null }, 200);
    expect(cleared.body).toMatchObject({
      giftedDaysMonthly: null,
      giftedDaysYearly: null,
    });
    expect(await admin.plan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({
      giftedDaysMonthly: null,
      giftedDaysYearly: null,
    });

    // A non-platform-owner cannot change it.
    const outsider = await register(`w8-outsider-${stamp()}@atlas.test`);
    await http()
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ expectedVersion: 0, giftedDaysMonthly: 7 })
      .expect(403);

    // The database refuses out-of-range values from ANY writer.
    for (const bad of [4, 16]) {
      await expect(
        admin.plan.update({ where: { id: plan.id }, data: { giftedDaysMonthly: bad } }),
      ).rejects.toThrow(/plans_gifted_days_monthly_range_chk/);
    }
  });

  // ------------------------------------------------------------ 8B ledger

  it('HMAC v2 rows are verified against legacy v1 rows: a v1-only subject is refused a trial', async () => {
    const email = `w8-legacy-${stamp()}@atlas.test`;
    await admin.trialRedemption.create({
      data: {
        subjectHash: legacyLedgerSubjectHash(email),
        hashVersion: 1,
        source: 'claim',
        redeemedAt: new Date(Date.now() - 400 * DAY_MS),
      },
    });

    const account = await register(email);
    const orgId = await createOrg(account.token);
    expect((await lifecycle(account.token, orgId)).trialAvailable).toBe(false);
    expect((await startTrial(account.token, orgId)).started).toBe(false);
    expect((await subscription(orgId)).status).toBe('no_plan');

    // A fresh address under v2 is still granted.
    const fresh = await register(`w8-fresh-${stamp()}@atlas.test`);
    const freshOrg = await createOrg(fresh.token);
    expect((await startTrial(fresh.token, freshOrg)).started).toBe(true);
    const row = await admin.trialRedemption.findUniqueOrThrow({
      where: { subjectHash: ledgerSubjectHash(fresh.email) },
    });
    expect(row).toMatchObject({ hashVersion: 2, source: 'claim' });
  });

  it('the application role cannot UPDATE or DELETE either ledger', async () => {
    const owner = await register(`w8-appendonly-${stamp()}@atlas.test`);
    const orgId = await createOrg(owner.token);
    await approve(await pay(owner.token, orgId, giftPlan.key, 'monthly')).expect(201);
    const hash = ledgerSubjectHash(owner.email);

    await expect(
      appPrisma.$executeRaw`UPDATE "paid_gift_redemptions" SET "gifted_days" = 15 WHERE "subject_hash" = ${hash}`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      appPrisma.$executeRaw`DELETE FROM "paid_gift_redemptions" WHERE "subject_hash" = ${hash}`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      appPrisma.$executeRaw`DELETE FROM "trial_redemptions" WHERE "subject_hash" = ${hash}`,
    ).rejects.toThrow(/permission denied/);
    expect(await giftLedgerCount(owner.email)).toBe(1);
  });

  it('retention: IP and user agent are cleared after 180 days; hashes and younger rows are kept', async () => {
    const old = await admin.trialRedemption.create({
      data: {
        subjectHash: `w8-old-${stamp()}`,
        hashVersion: 2,
        redeemedAt: new Date(Date.now() - 181 * DAY_MS),
        ipAddress: '198.51.100.7',
        userAgent: 'old-agent',
      },
    });
    const young = await admin.trialRedemption.create({
      data: {
        subjectHash: `w8-young-${stamp()}`,
        hashVersion: 2,
        redeemedAt: new Date(Date.now() - 179 * DAY_MS),
        ipAddress: '198.51.100.8',
        userAgent: 'young-agent',
      },
    });

    const scrubbed = await app.get(TrialForensicsScrubService).run();
    expect(scrubbed).toBeGreaterThanOrEqual(1);
    expect(
      await admin.trialRedemption.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({
      subjectHash: old.subjectHash,
      ipAddress: null,
      userAgent: null,
    });
    expect(
      await admin.trialRedemption.findUniqueOrThrow({ where: { id: young.id } }),
    ).toMatchObject({
      ipAddress: '198.51.100.8',
      userAgent: 'young-agent',
    });
    // The definer function refuses a window that would wipe fresh signals.
    await expect(app.get(TrialForensicsScrubService).run(7)).rejects.toThrow(
      /at least 30 days/,
    );
  });
});
