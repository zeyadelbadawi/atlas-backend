/**
 * Academy Manual Payments — the "Payment methods" section of the academy
 * setup form (e2e). The methods chosen there travel on the provisioning
 * request and are saved, enabled, to the new academy by the worker's
 * `academy` step; invalid details are refused before the request exists;
 * "set up later" saves none.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import {
  createAdminPrisma,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';

jest.setTimeout(90000);

function uniqueName(label: string): string {
  return `${label} Academy ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueSubdomain(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}

const BANK = {
  bankName: 'Banque Misr',
  accountName: 'Cairo Coding School',
  accountNumber: '100200300400',
  instructions: 'Transfer the course price, then upload the receipt.',
  referenceInstructions: 'Put your email in the transfer note.',
};
const WALLET = {
  walletProvider: 'orange_cash',
  walletNumber: '01212345678',
  accountName: 'Cairo Coding School',
  instructions: 'Send the price to this Orange Cash wallet.',
  referenceInstructions: 'Keep the confirmation SMS.',
};

describe('Academy manual payments — setup form (e2e)', () => {
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

  async function arrangeOrg(label: string) {
    const email = uniqueTestEmail(`${label}-owner`);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: `${label} owner`, email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const owner = { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    return { owner, org };
  }

  function post(token: string, orgId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/organizations/${orgId}/provisioning-requests`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function waitForReady(token: string, orgId: string, requestId: string) {
    return waitForAsync(
      async () => {
        const res = await request(app.getHttpServer())
          .get(`/organizations/${orgId}/provisioning-requests/${requestId}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        return ['ready', 'failed', 'cancelled'].includes(res.body.status)
          ? res.body
          : undefined;
      },
      { timeoutMs: 45000 },
    );
  }

  it('saves the chosen methods, enabled, to the new academy', async () => {
    const { owner, org } = await arrangeOrg('mp-prov');
    const created = await post(owner.accessToken, org.id, {
      academyName: uniqueName('Cairo Coding'),
      requestedSubdomain: uniqueSubdomain('mp-prov'),
      paymentMethods: { bankTransfer: BANK, wallet: WALLET },
      idempotencyKey: `mp-prov-${Date.now()}`,
    }).expect(201);

    const ready = await waitForReady(owner.accessToken, org.id, created.body.id);
    expect(ready.status).toBe('ready');

    const methods = await admin.academyPaymentMethod.findMany({
      where: { academyId: ready.academyId },
      orderBy: { displayOrder: 'asc' },
    });
    expect(methods.map((m) => [m.type, m.enabled])).toEqual([
      ['manual_bank_transfer', true],
      ['manual_wallet_transfer', true],
    ]);
    expect(methods[1].instructions).toMatchObject({
      walletProvider: 'orange_cash',
      walletNumber: '01212345678',
    });
    expect(methods.every((m) => m.organizationId === org.id)).toBe(true);

    // The owner sees them on the settings page straight away.
    const list = await request(app.getHttpServer())
      .get(`/academies/${ready.academyId}/payment-methods`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(list.body).toHaveLength(2);
  });

  it('"set up later" saves no method', async () => {
    const { owner, org } = await arrangeOrg('mp-later');
    const created = await post(owner.accessToken, org.id, {
      academyName: uniqueName('Later'),
      requestedSubdomain: uniqueSubdomain('mp-later'),
      idempotencyKey: `mp-later-${Date.now()}`,
    }).expect(201);
    const ready = await waitForReady(owner.accessToken, org.id, created.body.id);
    expect(ready.status).toBe('ready');
    expect(
      await admin.academyPaymentMethod.count({ where: { academyId: ready.academyId } }),
    ).toBe(0);
  });

  it('refuses invalid details and unknown keys before the request exists', async () => {
    const { owner, org } = await arrangeOrg('mp-bad');
    const base = {
      academyName: uniqueName('Bad'),
      requestedSubdomain: uniqueSubdomain('mp-bad'),
    };
    await post(owner.accessToken, org.id, {
      ...base,
      paymentMethods: { wallet: { ...WALLET, walletNumber: '999' } },
      idempotencyKey: `mp-bad-1-${Date.now()}`,
    }).expect(400);
    await post(owner.accessToken, org.id, {
      ...base,
      paymentMethods: { instapay: { ...BANK, instapayAddress: 'not-an-address' } },
      idempotencyKey: `mp-bad-2-${Date.now()}`,
    }).expect(400);
    await post(owner.accessToken, org.id, {
      ...base,
      paymentMethods: { paypal: { email: 'x@example.com' } },
      idempotencyKey: `mp-bad-3-${Date.now()}`,
    }).expect(400);
    await post(owner.accessToken, org.id, {
      ...base,
      paymentMethods: { bankTransfer: { ...BANK, accountName: '   ' } },
      idempotencyKey: `mp-bad-4-${Date.now()}`,
    }).expect(400);
    expect(
      await admin.provisioningRequest.count({
        where: { organizationId: org.id },
      }),
    ).toBe(0);
  });
});
