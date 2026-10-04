/**
 * The subscription receipt (`lifecycle.subscription.activated`) for EVERY
 * way a platform plan can be paid for, end to end against the real
 * database, RLS and HTTP stack.
 *
 * Atlas confirms a plan payment in exactly two ways, and both now end in
 * the same shared apply step (`PaymentApplicationService.
 * applySuccessfulPayment`), which emits the receipt:
 *
 *   - a Platform Owner approving a manual transfer — every manual method
 *     type: bank transfer, wallet transfer, InstaPay;
 *   - a signed `payment.succeeded` webhook (the gateway path), which used
 *     to activate the plan and send nothing.
 *
 * Asserted per path: one receipt per activation; gift details exactly when
 * this payment was granted gifted days, and taken from the subscription
 * row; none on renewals; no duplicate from webhook redelivery or from an
 * approval and a webhook for the same payment; no receipt for a failed or
 * rejected payment. Every customer is a fresh address, so ledger state
 * from earlier runs on this shared database cannot satisfy an assertion.
 */
import type { INestApplication } from '@nestjs/common';
import type { Plan, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import { createAdminPrisma, seedPaymentMethod, seedPlan } from './utils/db-admin';
import { ledgerSubjectHash } from './utils/customer-identity';
import { PaymentWebhookService } from '../src/billing/services/payment-webhook.service';
import { TemplateRegistry } from '../src/communications/templates/template-registry';
import type { ProcessWebhookEventJobPayload } from '../src/billing/queue/payment-webhook.types';

const PASSWORD = 'correct-horse-battery';
const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const RECEIPT = 'lifecycle.subscription.activated';

type ManualType = 'manual_bank_transfer' | 'manual_wallet_transfer' | 'manual_instapay';

interface Account {
  readonly email: string;
  readonly userId: string;
  readonly token: string;
}

describe('Subscription receipt — every payment method (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let platform: Account;
  let giftPlan: Plan;
  const methods = {} as Record<ManualType, string>;

  const stamp = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    const owner = await register(`receipt-platform-${stamp()}@atlas.test`);
    await admin.user.update({
      where: { id: owner.userId },
      data: { isPlatformOwner: true },
    });
    platform = await signIn(owner.email);

    for (const type of [
      'manual_bank_transfer',
      'manual_wallet_transfer',
      'manual_instapay',
    ] as const) {
      methods[type] = (await seedPaymentMethod(admin, `receipt-${type}`, { type })).key;
    }
    giftPlan = await seedPlan(admin, 'receipt-plan', {
      pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
    });
    giftPlan = await admin.plan.update({
      where: { id: giftPlan.id },
      data: { giftedDaysMonthly: 7, giftedDaysYearly: 14 },
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
      .send({ name: 'Receipt Tester', email, password: PASSWORD })
      .expect(201);
    return signIn(email);
  }

  async function customer(): Promise<{ account: Account; orgId: string }> {
    const account = await register(`receipt-${stamp()}@atlas.test`);
    const res = await http()
      .post('/organizations')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ name: `Receipt Org ${stamp()}` })
      .expect(201);
    return { account, orgId: res.body.id as string };
  }

  /** checkout → payment (→ proof, for a manual review): returns the payment id. */
  async function pay(
    token: string,
    orgId: string,
    methodKey: string,
    opts: { proof: boolean },
  ): Promise<string> {
    const checkout = await http()
      .post(`/organizations/${orgId}/checkouts`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        target: { type: 'plan_subscription', planKey: giftPlan.key },
        idempotencyKey: `receipt-${stamp()}`,
      })
      .expect(201);
    const payment = await http()
      .post(`/organizations/${orgId}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checkoutId: checkout.body.id, methodKey })
      .expect(201);
    if (opts.proof) {
      await http()
        .patch(`/organizations/${orgId}/payments/${payment.body.id}/proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
        .expect(200);
    }
    return payment.body.id as string;
  }

  function approve(paymentId: string) {
    return http()
      .post(`/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${platform.token}`)
      .send({ notes: 'receipt' });
  }

  function reject(paymentId: string) {
    return http()
      .post(`/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${platform.token}`)
      .send({ notes: 'receipt test rejection' });
  }

  /** A signed gateway event, processed exactly as the BullMQ worker does. */
  function webhook(
    paymentId: string,
    eventType: ProcessWebhookEventJobPayload['eventType'],
    eventId: string = `evt_${randomUUID()}`,
  ) {
    return app.get(PaymentWebhookService).processEvent({
      provider: PaymentWebhookService.PROVIDER,
      eventId,
      eventType,
      paymentId,
      occurredAt: new Date().toISOString(),
    });
  }

  function receipts(orgId: string) {
    return admin.communicationOutbox.findMany({
      where: { organizationId: orgId, key: RECEIPT },
      orderBy: { createdAt: 'asc' },
    });
  }

  function subscription(orgId: string) {
    return admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
  }

  const utc = (at: Date) =>
    `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;

  /** Gift values in the receipt equal the subscription row this payment wrote. */
  async function expectGiftReceipt(orgId: string, ownerUserId: string) {
    const rows = await receipts(orgId);
    expect(rows).toHaveLength(1);
    const sub = await subscription(orgId);
    expect(sub.status).toBe('active');
    expect(sub.giftedDays).toBe(7);
    expect(rows[0].recipientUserId).toBe(ownerUserId);
    expect(rows[0].values).toMatchObject({
      anchorAt: sub.currentPeriodEnd!.toISOString(),
      planName: giftPlan.name,
      giftedDays: 7,
      giftStartDate: utc(sub.giftedStartsAt!),
      giftEndDate: utc(sub.giftedEndsAt!),
      periodStartDate: utc(sub.currentPeriodStart!),
      periodEndDate: utc(sub.currentPeriodEnd!),
    });
    // The paid period starts where the gift ends.
    expect(sub.currentPeriodStart!.toISOString()).toBe(sub.giftedEndsAt!.toISOString());
    return rows[0].values as Record<string, unknown>;
  }

  // ------------------------------------------------- manual review methods

  it.each(['manual_bank_transfer', 'manual_wallet_transfer', 'manual_instapay'] as const)(
    '%s — an approved first payment sends ONE receipt with the gifted days',
    async (type) => {
      const { account, orgId } = await customer();
      const paymentId = await pay(account.token, orgId, methods[type], { proof: true });
      await approve(paymentId).expect(201);

      const payment = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment.methodType).toBe(type);
      await expectGiftReceipt(orgId, account.userId);

      // A second approval of the same payment is refused and sends nothing.
      await approve(paymentId).expect(409);
      expect(await receipts(orgId)).toHaveLength(1);
    },
  );

  it('a rejected payment sends no receipt and activates nothing', async () => {
    const { account, orgId } = await customer();
    const paymentId = await pay(account.token, orgId, methods.manual_bank_transfer, {
      proof: true,
    });
    await reject(paymentId).expect(201);
    expect(await receipts(orgId)).toHaveLength(0);
    const sub = await admin.tenantSubscription.findUnique({
      where: { organizationId: orgId },
    });
    expect(sub?.status).not.toBe('active');
  });

  // ------------------------------------------------------- gateway webhook

  it('gateway — a webhook-confirmed first payment sends ONE receipt with the gifted days', async () => {
    const { account, orgId } = await customer();
    const paymentId = await pay(account.token, orgId, methods.manual_bank_transfer, {
      proof: false,
    });
    await webhook(paymentId, 'payment.succeeded');

    const values = await expectGiftReceipt(orgId, account.userId);
    const ledger = await admin.paidGiftRedemption.findUniqueOrThrow({
      where: { subjectHash: ledgerSubjectHash(account.email) },
    });
    expect(ledger.source).toBe('gateway');
    expect(ledger.paymentId).toBe(paymentId);

    // It renders in both locales, with the gift stated separately.
    const input = {
      branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
      actionUrl: 'https://platform.test/dashboard/tenant/subscription',
      settingsUrl: 'https://platform.test/settings/notifications',
    };
    const en = TemplateRegistry.render(RECEIPT, 'en', input, values);
    expect(en.text).toContain('Gifted days: 7 days');
    expect(en.text).toContain('Paid subscription period');
    const ar = TemplateRegistry.render(RECEIPT, 'ar', input, values);
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toMatch(/مُهداة|مهداة|هدية/);
  });

  it('gateway — a redelivered event, and a second event for the same payment, send no second receipt', async () => {
    const { account, orgId } = await customer();
    const paymentId = await pay(account.token, orgId, methods.manual_bank_transfer, {
      proof: false,
    });
    const eventId = `evt_${randomUUID()}`;
    await webhook(paymentId, 'payment.succeeded', eventId);
    await webhook(paymentId, 'payment.succeeded', eventId);
    await webhook(paymentId, 'payment.succeeded');
    expect(await receipts(orgId)).toHaveLength(1);
    expect(await admin.paymentWebhookEvent.count({ where: { paymentId } })).toBe(2);
  });

  it('approval then webhook for the same payment — one receipt', async () => {
    const { account, orgId } = await customer();
    const paymentId = await pay(account.token, orgId, methods.manual_instapay, {
      proof: true,
    });
    await approve(paymentId).expect(201);
    await webhook(paymentId, 'payment.succeeded');
    expect(await receipts(orgId)).toHaveLength(1);
  });

  it('webhook then approval for the same payment — one receipt', async () => {
    const { account, orgId } = await customer();
    const paymentId = await pay(account.token, orgId, methods.manual_wallet_transfer, {
      proof: true,
    });
    await webhook(paymentId, 'payment.succeeded');
    // The proof is still pending review, so the approval is accepted — but
    // the payment already succeeded, so it applies and sends nothing new.
    await approve(paymentId).expect(201);
    expect(await receipts(orgId)).toHaveLength(1);
  });

  it('gateway — a failed payment sends no receipt and activates nothing', async () => {
    const { account, orgId } = await customer();
    const paymentId = await pay(account.token, orgId, methods.manual_bank_transfer, {
      proof: false,
    });
    await webhook(paymentId, 'payment.failed');
    expect(await receipts(orgId)).toHaveLength(0);
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('failed');
    const sub = await admin.tenantSubscription.findUnique({
      where: { organizationId: orgId },
    });
    expect(sub?.status).not.toBe('active');
  });

  // ------------------------------------------------------------- renewals

  it.each(['approval', 'gateway'] as const)(
    'renewal by %s — its own receipt, with no gift wording',
    async (via) => {
      const { account, orgId } = await customer();
      const first = await pay(account.token, orgId, methods.manual_bank_transfer, {
        proof: true,
      });
      await approve(first).expect(201);

      const renewal = await pay(account.token, orgId, methods.manual_bank_transfer, {
        proof: via === 'approval',
      });
      if (via === 'approval') await approve(renewal).expect(201);
      else await webhook(renewal, 'payment.succeeded');

      const rows = await receipts(orgId);
      expect(rows).toHaveLength(2);
      const sub = await subscription(orgId);
      const renewalValues = rows.find(
        (r) =>
          (r.values as Record<string, unknown>).anchorAt ===
          sub.currentPeriodEnd!.toISOString(),
      )!.values as Record<string, unknown>;
      expect(renewalValues).not.toHaveProperty('giftedDays');
      expect(renewalValues).not.toHaveProperty('giftStartDate');
      expect(renewalValues).not.toHaveProperty('giftEndDate');
      const en = TemplateRegistry.render(
        RECEIPT,
        'en',
        {
          branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
          actionUrl: 'https://platform.test/dashboard/tenant/subscription',
          settingsUrl: 'https://platform.test/settings/notifications',
        },
        renewalValues,
      );
      expect(en.text).not.toMatch(/gift/i);
    },
  );
});
