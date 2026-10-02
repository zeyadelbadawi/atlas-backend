/**
 * Egyptian mobile wallets and InstaPay beside Bank Transfer (2 Oct 2026).
 *
 * The same manual flow as Bank Transfer (bank-transfer.e2e-spec.ts covers
 * its shared review, idempotency, concurrency, rollback and tenant rules),
 * pinned here for the two new kinds against the real database:
 *   - the Platform Owner configures a wallet (Vodafone/Orange/Etisalat
 *     Cash, WE Pay, or another provider by name) or an InstaPay address:
 *     validated, normalized, audited without the destination, EN + AR;
 *   - new details must be the method's own kind;
 *   - the placeholder rows the migration adds are disabled and never
 *     offered; saving real details replaces the placeholder;
 *   - an Organization Owner pays with a wallet / InstaPay: the payment
 *     records which method and keeps the exact details it was shown; a
 *     receipt is validated; the Platform Owner approves (subscription
 *     active) or rejects with a note; a repeated request or approval takes
 *     effect once; another organization cannot see the payment.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { Plan, PrismaClient } from '@prisma/client';

const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const NOT_AN_IMAGE = `data:image/png;base64,${Buffer.from('plain text, not a png').toString('base64')}`;

const TEXTS = {
  accountName: 'Ziad Gehad',
  accountNameAr: 'زياد جهاد',
  instructions: 'Send the exact amount, then upload a screenshot of the transfer.',
  instructionsAr: 'أرسل المبلغ المطلوب بالضبط ثم ارفع صورة التحويل.',
  referenceInstructions: 'Write your organization name in the transfer note.',
  referenceInstructionsAr: 'اكتب اسم مؤسستك في ملاحظة التحويل.',
};

describe('Mobile wallets and InstaPay (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let platform: { email: string; userId: string; token: string };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    platform = await account('mpm-platform-owner');
    await admin.user.update({
      where: { id: platform.userId },
      data: { isPlatformOwner: true },
    });
    platform = await signIn(platform.email);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) =>
      http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function signIn(email: string) {
    const response = await http()
      .post('/auth/sign-in')
      .send({ email, password: 'correct-horse-battery' })
      .expect(200);
    return {
      email,
      userId: response.body.user.id as string,
      token: response.body.accessToken as string,
    };
  }

  async function account(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: 'correct-horse-battery' })
      .expect(201);
    return signIn(email);
  }

  async function seedPlan(label: string): Promise<Plan> {
    return admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        limits: {
          academies: 2,
          students: 100,
          instructors: 5,
          staff: 5,
          courses: 20,
          generalStorage: 10,
          videoStorage: 10,
        },
        features: {
          cms: true,
          seo: true,
          seoAdvanced: false,
          marketing: false,
          marketingAdvanced: false,
          analytics: false,
          analyticsAdvanced: false,
          customDomain: false,
          themes: true,
          multipleThemes: false,
          backup: false,
        },
        pricing: { amount: 49, currency: 'USD', billingCycle: 'monthly' },
      },
    });
  }

  const offeredKeys = async () => {
    const keys: string[] = [];
    for (let page = 1; ; page += 1) {
      const res = await as(platform.token)
        .get(`/payment-methods?page=${page}&pageSize=100`)
        .expect(200);
      keys.push(...(res.body.items as { key: string }[]).map((m) => m.key));
      if (page >= res.body.pagination.totalPages) return keys;
    }
  };

  const createWallet = (body: object) =>
    as(platform.token).post('/platform-payment-methods/wallet', body);
  const createInstapay = (body: object) =>
    as(platform.token).post('/platform-payment-methods/instapay', body);

  describe('Platform Owner configuration', () => {
    it('a wallet is validated, normalized, bilingual and audited without its number', async () => {
      const created = await createWallet({
        displayName: 'Vodafone Cash',
        instructions: {
          walletProvider: 'vodafone_cash',
          walletNumber: '+20 10 1234 5678',
          ...TEXTS,
        },
      }).expect(201);
      expect(created.body).toMatchObject({
        type: 'manual_wallet_transfer',
        enabled: false,
        provider: 'atlas_manual',
        capabilities: { supportsProof: true, supportsManualReview: true },
        manualInstructions: {
          type: 'manual_wallet_transfer',
          walletProvider: 'vodafone_cash',
          walletNumber: '01012345678',
          ...TEXTS,
        },
      });
      expect(created.body.manualInstructions.placeholder).toBeUndefined();
      expect(created.body.key).toMatch(/^wallet_/);

      const audit = await admin.auditLogEntry.findMany({
        where: { targetId: created.body.id },
      });
      expect(audit.map((row) => row.action)).toEqual(['payment_method.created']);
      expect(JSON.stringify(audit)).not.toContain('01012345678');

      // Every accepted number form normalizes the same way.
      for (const walletNumber of ['01012345678', '201012345678', '0101 234 5678']) {
        const res = await createWallet({
          displayName: 'Vodafone Cash',
          instructions: { walletProvider: 'vodafone_cash', walletNumber, ...TEXTS },
        }).expect(201);
        expect(res.body.manualInstructions.walletNumber).toBe('01012345678');
      }
    });

    it('refuses invalid wallet and InstaPay details, and non-Platform-Owners', async () => {
      const bad = [
        { walletProvider: 'vodafone_cash', walletNumber: '0123456789', ...TEXTS }, // 10 digits
        { walletProvider: 'vodafone_cash', walletNumber: '01312345678', ...TEXTS }, // 013 is no network
        { walletProvider: 'vodafone_cash', walletNumber: 'PLACEHOLDER', ...TEXTS },
        { walletProvider: 'paypal', walletNumber: '01012345678', ...TEXTS },
        {
          walletProvider: 'vodafone_cash',
          walletNumber: '01012345678',
          ...TEXTS,
          accountName: '',
        },
      ];
      for (const instructions of bad) {
        await createWallet({ displayName: 'Wallet', instructions }).expect(400);
      }
      const noName = await createWallet({
        displayName: 'Other wallet',
        instructions: { walletProvider: 'other', walletNumber: '01112345678', ...TEXTS },
      }).expect(400);
      expect(noName.body.error.messageKey).toBe(
        'errors.paymentMethod.walletProviderNameRequired',
      );
      const other = await createWallet({
        displayName: 'CIB Smart Wallet',
        instructions: {
          walletProvider: 'other',
          walletProviderName: 'CIB Smart Wallet',
          walletNumber: '01112345678',
          ...TEXTS,
        },
      }).expect(201);
      expect(other.body.manualInstructions.walletProviderName).toBe('CIB Smart Wallet');

      for (const instapayAddress of [
        'ziad',
        'ziad@instapay.com',
        '@instapay',
        'a b@instapay',
      ]) {
        await createInstapay({
          displayName: 'InstaPay',
          instructions: { instapayAddress, ...TEXTS },
        }).expect(400);
      }
      const ipa = await createInstapay({
        displayName: 'InstaPay',
        instructions: { instapayAddress: 'Atlas.Test@InstaPay', ...TEXTS },
      }).expect(201);
      expect(ipa.body).toMatchObject({
        type: 'manual_instapay',
        manualInstructions: {
          type: 'manual_instapay',
          instapayAddress: 'atlas.test@instapay',
        },
      });

      const outsider = await account('mpm-outsider');
      await as(outsider.token)
        .post('/platform-payment-methods/wallet', {
          displayName: 'x',
          instructions: {
            walletProvider: 'orange_cash',
            walletNumber: '01212345678',
            ...TEXTS,
          },
        })
        .expect(403);
      await as(outsider.token)
        .post('/platform-payment-methods/instapay', {
          displayName: 'x',
          instructions: { instapayAddress: 'x@instapay', ...TEXTS },
        })
        .expect(403);
    });

    it("new details must be the method's own kind", async () => {
      const wallet = await createWallet({
        displayName: 'Orange Cash',
        instructions: {
          walletProvider: 'orange_cash',
          walletNumber: '01212345678',
          ...TEXTS,
        },
      }).expect(201);
      const ipa = await createInstapay({
        displayName: 'InstaPay',
        instructions: { instapayAddress: 'kind@instapay', ...TEXTS },
      }).expect(201);
      const patch = (id: string, body: object) =>
        as(platform.token).patch(`/platform-payment-methods/${id}`, body);

      const mismatch = await patch(wallet.body.id, {
        instapayInstructions: { instapayAddress: 'kind@instapay', ...TEXTS },
      }).expect(400);
      expect(mismatch.body.error.messageKey).toBe(
        'errors.paymentMethod.instructionsTypeMismatch',
      );
      await patch(ipa.body.id, {
        walletInstructions: {
          walletProvider: 'orange_cash',
          walletNumber: '01212345678',
          ...TEXTS,
        },
      }).expect(400);

      const updated = await patch(wallet.body.id, {
        walletInstructions: {
          walletProvider: 'etisalat_cash',
          walletNumber: '01112345678',
          ...TEXTS,
        },
        enabled: true,
      }).expect(200);
      expect(updated.body).toMatchObject({
        enabled: true,
        manualInstructions: {
          walletProvider: 'etisalat_cash',
          walletNumber: '01112345678',
        },
      });
    });

    it('the placeholder methods are disabled and never offered; real details replace a placeholder', async () => {
      const placeholders = await admin.paymentMethod.findMany({
        where: {
          key: {
            in: [
              'wallet_vodafone_cash',
              'wallet_orange_cash',
              'wallet_etisalat_cash',
              'instapay',
            ],
          },
        },
      });
      expect(placeholders).toHaveLength(4);
      for (const row of placeholders) {
        expect(row.enabled).toBe(false);
        expect(row.manualInstructions).toMatchObject({
          placeholder: true,
          accountName: 'Ziad Gehad',
          accountNameAr: 'زياد جهاد',
        });
      }
      expect(placeholders.find((row) => row.key === 'instapay')?.type).toBe(
        'manual_instapay',
      );
      const offered = await offeredKeys();
      for (const row of placeholders) expect(offered).not.toContain(row.key);

      // A placeholder of this test's own (the shared rows stay as they are).
      const own = await admin.paymentMethod.create({
        data: {
          key: `wallet_placeholder_${Date.now()}`,
          type: 'manual_wallet_transfer',
          displayName: 'Vodafone Cash',
          provider: 'atlas_manual',
          enabled: false,
          capabilities: placeholders[0].capabilities as object,
          manualInstructions: placeholders.find((r) => r.key === 'wallet_vodafone_cash')!
            .manualInstructions as object,
        },
      });
      const replaced = await as(platform.token)
        .patch(`/platform-payment-methods/${own.id}`, {
          walletInstructions: {
            walletProvider: 'vodafone_cash',
            walletNumber: '01098765432',
            ...TEXTS,
          },
        })
        .expect(200);
      expect(replaced.body.manualInstructions.placeholder).toBeUndefined();
      expect(replaced.body.manualInstructions.walletNumber).toBe('01098765432');
    });
  });

  describe('Organization Owner pays, Platform Owner reviews', () => {
    async function payWith(label: string, methodKey: string) {
      const owner = await account(`${label}-owner`);
      const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
      const plan = await seedPlan(`${label}-plan`);
      const co = await as(owner.token)
        .post(`/organizations/${org.id}/checkouts`, {
          target: { type: 'plan_subscription', planKey: plan.key },
          billingCycle: 'monthly',
          idempotencyKey: `${label}-${Math.random().toString(36).slice(2)}`,
        })
        .expect(201);
      const payment = await as(owner.token)
        .post(`/organizations/${org.id}/payments`, { checkoutId: co.body.id, methodKey })
        .expect(201);
      return { owner, org, plan, checkout: co.body, payment: payment.body };
    }

    it('a wallet payment records its method and details, takes a receipt, and approval activates the plan once', async () => {
      const method = await createWallet({
        displayName: 'Vodafone Cash',
        instructions: {
          walletProvider: 'vodafone_cash',
          walletNumber: '01055555555',
          ...TEXTS,
        },
        enabled: true,
      }).expect(201);
      expect(await offeredKeys()).toContain(method.body.key);

      const { owner, org, plan, checkout, payment } = await payWith(
        'mpm-wallet',
        method.body.key,
      );
      expect(payment).toMatchObject({
        methodKey: method.body.key,
        methodType: 'manual_wallet_transfer',
        instructions: {
          type: 'manual_wallet_transfer',
          walletProvider: 'vodafone_cash',
          walletNumber: '01055555555',
          accountNameAr: 'زياد جهاد',
        },
      });

      // Asking again returns the same payment.
      const again = await as(owner.token)
        .post(`/organizations/${org.id}/payments`, {
          checkoutId: checkout.id,
          methodKey: method.body.key,
        })
        .expect(201);
      expect(again.body.id).toBe(payment.id);

      // The method's details change later; this payment keeps what it showed.
      await as(platform.token)
        .patch(`/platform-payment-methods/${method.body.id}`, {
          walletInstructions: {
            walletProvider: 'vodafone_cash',
            walletNumber: '01066666666',
            ...TEXTS,
          },
        })
        .expect(200);

      const proofUrl = `/organizations/${org.id}/payments/${payment.id}/proof`;
      await as(owner.token)
        .patch(proofUrl, {
          fileData: NOT_AN_IMAGE,
          fileName: 'r.png',
          mimeType: 'image/png',
        })
        .expect(400);
      await as(owner.token)
        .patch(proofUrl, {
          fileData: PROOF_DATA_URL,
          fileName: 'r.png',
          mimeType: 'image/png',
        })
        .expect(200);
      const tracked = await as(owner.token)
        .get(`/organizations/${org.id}/payments/${payment.id}`)
        .expect(200);
      expect(tracked.body.reviewStatus).toBe('pending');
      expect(tracked.body.instructions.walletNumber).toBe('01055555555');

      // Another organization's owner cannot see it.
      const stranger = await account('mpm-wallet-stranger');
      const strangerOrg = await seedOrganizationWithOwner(
        admin,
        stranger.userId,
        'mpm-stranger-org',
      );
      await as(stranger.token)
        .get(`/organizations/${strangerOrg.id}/payments/${payment.id}`)
        .expect(404);
      await as(stranger.token)
        .get(`/organizations/${org.id}/payments/${payment.id}`)
        .expect((res) => expect([403, 404]).toContain(res.status));

      await as(platform.token).post(`/payments/${payment.id}/approve`, {}).expect(201);
      await as(platform.token).post(`/payments/${payment.id}/approve`, {}).expect(409);
      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });
      expect(subscription).toMatchObject({ status: 'active', planId: plan.id });
      expect(await admin.paymentReview.count({ where: { paymentId: payment.id } })).toBe(
        1,
      );
    });

    it('an InstaPay payment is reviewed the same way; a rejection needs a note and activates nothing', async () => {
      const method = await createInstapay({
        displayName: 'InstaPay',
        instructions: { instapayAddress: 'atlas.pay@instapay', ...TEXTS },
        enabled: true,
      }).expect(201);
      const { owner, org, payment } = await payWith('mpm-ipa', method.body.key);
      expect(payment).toMatchObject({
        methodType: 'manual_instapay',
        instructions: { type: 'manual_instapay', instapayAddress: 'atlas.pay@instapay' },
      });
      await as(owner.token)
        .patch(`/organizations/${org.id}/payments/${payment.id}/proof`, {
          fileData: PROOF_DATA_URL,
          fileName: 'screenshot.png',
          mimeType: 'image/png',
        })
        .expect(200);
      await as(platform.token)
        .post(`/payments/${payment.id}/reject`, { notes: 'short' })
        .expect(400);
      await as(platform.token)
        .post(`/payments/${payment.id}/reject`, {
          notes: 'The transfer amount does not match the invoice.',
        })
        .expect(201);
      const rejected = await as(owner.token)
        .get(`/organizations/${org.id}/payments/${payment.id}`)
        .expect(200);
      expect(rejected.body.reviewStatus).toBe('rejected');
      const subscription = await admin.tenantSubscription.findUnique({
        where: { organizationId: org.id },
      });
      expect(subscription?.status).not.toBe('active');
    });

    it('a disabled method cannot be paid', async () => {
      const method = await createWallet({
        displayName: 'WE Pay',
        instructions: { walletProvider: 'we_pay', walletNumber: '01512345678', ...TEXTS },
      }).expect(201);
      const owner = await account('mpm-disabled-owner');
      const org = await seedOrganizationWithOwner(
        admin,
        owner.userId,
        'mpm-disabled-org',
      );
      const plan = await seedPlan('mpm-disabled-plan');
      const co = await as(owner.token)
        .post(`/organizations/${org.id}/checkouts`, {
          target: { type: 'plan_subscription', planKey: plan.key },
          billingCycle: 'monthly',
          idempotencyKey: `mpm-disabled-${Math.random().toString(36).slice(2)}`,
        })
        .expect(201);
      await as(owner.token)
        .post(`/organizations/${org.id}/payments`, {
          checkoutId: co.body.id,
          methodKey: method.body.key,
        })
        .expect(404);
    });
  });
});
