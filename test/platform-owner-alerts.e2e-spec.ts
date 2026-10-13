/**
 * B0-SUP-01 — Platform Owners are told about work instead of polling:
 * a subscription payment proof, a new support case, a customer reply on
 * one, and a new organization signup each give every active Platform
 * Owner one in-app notification and one email (outbox row), linked to the
 * record. A retried request writes nothing new, and nothing about the
 * requester's own text is copied into the alert.
 *
 * The two course-commerce alerts (Atlas-collected proof, refund) depend on
 * the `atlas_payments` collection mode, which is not tenant-selectable at
 * launch (B0-COM-03); they are covered by the service's unit spec.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import type { CommunicationsConfig, IdentityConfig } from '../src/config/configuration';
import { PlatformOwnerAlertService } from '../src/communications/services/platform-owner-alert.service';
import {
  COMMUNICATION_CATALOG,
  type CommunicationEventKey,
} from '../src/communications/catalog/communication-catalog';

const PASSWORD = 'correct-horse-battery';
const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('B0-SUP-01 Platform Owner alerts (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let alerts: PlatformOwnerAlertService;
  let communications: {
    platformOwnerAlertsMode: CommunicationsConfig['platformOwnerAlertsMode'];
  };
  let flushRateLimitKeys: () => Promise<void>;
  let platform: { email: string; userId: string; token: string };
  let secondPlatform: { userId: string };
  let suspendedPlatform: { userId: string };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) =>
      http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function signIn(email: string) {
    const response = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
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
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    return signIn(email);
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    alerts = app.get(PlatformOwnerAlertService, { strict: false });
    // Off by default under NODE_ENV=test (every other suite would fan out
    // to the shared database's many Platform Owners); on for this suite.
    communications = app
      .get(ConfigService)
      .getOrThrow<CommunicationsConfig>('communications') as {
      platformOwnerAlertsMode: CommunicationsConfig['platformOwnerAlertsMode'];
    };
    communications.platformOwnerAlertsMode = 'on';

    platform = await account('sup01-platform');
    secondPlatform = await account('sup01-platform-2');
    suspendedPlatform = await account('sup01-platform-suspended');
    await admin.user.updateMany({
      where: {
        id: { in: [platform.userId, secondPlatform.userId, suspendedPlatform.userId] },
      },
      data: { isPlatformOwner: true },
    });
    await admin.user.update({
      where: { id: suspendedPlatform.userId },
      data: { status: 'suspended' },
    });
    platform = await signIn(platform.email);
  });

  afterAll(async () => {
    await alerts.drain();
    communications.platformOwnerAlertsMode = 'off';
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  /** The alerts this key wrote about one entity, per recipient. */
  async function delivered(key: string, entityId: string) {
    await alerts.drain();
    const [outbox, notifications] = await Promise.all([
      admin.$queryRaw<{ recipient_user_id: string; values: Record<string, unknown> }[]>`
        SELECT "recipient_user_id", "values" FROM "communication_outbox"
        WHERE "key" = ${key} AND "entity_id" = ${entityId}`,
      admin.notification.findMany({
        where: {
          titleKey: COMMUNICATION_CATALOG[key as CommunicationEventKey].titleKey,
          dedupeKey: { contains: entityId },
        },
        select: { userId: true, actionUrl: true, values: true, context: true },
      }),
    ]);
    return { outbox, notifications };
  }

  function expectOwnersAlerted(
    rows: Awaited<ReturnType<typeof delivered>>,
    actionUrl: string,
  ) {
    const emailed = rows.outbox.map((row) => row.recipient_user_id);
    const inApp = rows.notifications.map((row) => row.userId);
    for (const ids of [emailed, inApp]) {
      expect(ids).toEqual(
        expect.arrayContaining([platform.userId, secondPlatform.userId]),
      );
      expect(ids).not.toContain(suspendedPlatform.userId);
      // One per recipient: dedupe holds.
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const row of rows.notifications) {
      expect(row.actionUrl).toBe(actionUrl);
      expect(row.context).toBe('management');
    }
  }

  it('a subscription payment proof alerts every active Platform Owner, once per proof', async () => {
    const owner = await account('sup01-sub-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'sup01-sub-org');
    const plan = await admin.plan.create({
      data: {
        key: `sup01-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: 'SUP-01 plan',
        limits: { academies: 1, students: 10, instructors: 1, staff: 1, courses: 5 },
        features: {},
        pricing: { amount: 1190, currency: 'EGP', billingCycle: 'monthly' },
      },
    });
    const method = await as(platform.token)
      .post('/platform-payment-methods/bank-transfer', {
        displayName: 'Bank transfer SUP-01',
        instructions: {
          bankName: 'Test Bank (e2e)',
          accountName: 'Atlas Test Account',
          accountNumber: '0001 2345 6789',
          instructions: 'Transfer the exact amount shown, then upload your receipt.',
          referenceInstructions: 'Use your organization name as the transfer reference.',
        },
        enabled: true,
      })
      .expect(201);
    const checkout = await as(owner.token)
      .post(`/organizations/${org.id}/checkouts`, {
        target: { type: 'plan_subscription', planKey: plan.key },
        billingCycle: 'monthly',
        idempotencyKey: `sup01-${Math.random().toString(36).slice(2)}`,
      })
      .expect(201);
    const payment = await as(owner.token)
      .post(`/organizations/${org.id}/payments`, {
        checkoutId: checkout.body.id,
        methodKey: method.body.key,
      })
      .expect(201);
    await as(owner.token)
      .patch(`/organizations/${org.id}/payments/${payment.body.id}/proof`, {
        fileData: PROOF_DATA_URL,
        fileName: 'receipt.png',
        mimeType: 'image/png',
      })
      .expect(200);

    const rows = await delivered(
      'platform.subscription_payment.submitted',
      payment.body.id,
    );
    expectOwnersAlerted(rows, `/dashboard/platform/payments/${payment.body.id}`);
    const mine = rows.outbox.find((row) => row.recipient_user_id === platform.userId);
    expect(mine?.values).toMatchObject({
      organizationName: org.name,
      amount: 1190,
      currency: 'EGP',
    });
  });

  it('a new support case and each customer reply alert every active Platform Owner', async () => {
    const owner = await account('sup01-case-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'sup01-case-org');
    const created = await as(owner.token)
      .post(`/organizations/${org.id}/support-cases`, {
        subject: 'Private subject line',
        description: 'Something is not working.',
      })
      .expect(201);
    const caseId = created.body.id as string;

    const opened = await delivered('platform.support_case.created', caseId);
    expectOwnersAlerted(opened, `/dashboard/platform/support/${caseId}`);
    // The customer's own text stays on the case.
    expect(JSON.stringify(opened)).not.toContain('Private subject line');
    expect(JSON.stringify(opened)).not.toContain('Something is not working.');

    await as(owner.token)
      .post(`/support-cases/mine/${caseId}/messages`, { body: 'Any update?' })
      .expect((res) => {
        if (res.status !== 201 && res.status !== 200) {
          throw new Error(`reply failed: ${res.status} ${JSON.stringify(res.body)}`);
        }
      });
    await as(owner.token)
      .post(`/support-cases/mine/${caseId}/messages`, { body: 'Still broken.' })
      .expect((res) => {
        if (res.status !== 201 && res.status !== 200) {
          throw new Error(`reply failed: ${res.status} ${JSON.stringify(res.body)}`);
        }
      });
    const replies = await delivered('platform.support_case.customer_replied', caseId);
    const toMe = replies.outbox.filter(
      (row) => row.recipient_user_id === platform.userId,
    );
    // One alert per reply, not one per case.
    expect(toMe).toHaveLength(2);
    expect(JSON.stringify(replies)).not.toContain('Any update?');
  });

  it('a new organization signup alerts every active Platform Owner', async () => {
    const organizationName = `SUP-01 Signup ${Math.random().toString(36).slice(2, 8)}`;
    const email = uniqueTestEmail('sup01-signup');
    // The live config object `AuthService` reads on every request.
    const identity = app.get(ConfigService).getOrThrow<IdentityConfig>('identity') as {
      signupOrganizationMode: IdentityConfig['signupOrganizationMode'];
    };
    const previousMode = identity.signupOrganizationMode;
    identity.signupOrganizationMode = 'on';
    try {
      await http()
        .post('/auth/register')
        .send({ name: 'Owner Name', email, password: PASSWORD, organizationName })
        .expect(201);
    } finally {
      identity.signupOrganizationMode = previousMode;
    }
    const organization = await admin.organization.findFirstOrThrow({
      where: { name: organizationName },
    });

    const rows = await delivered('platform.organization.signed_up', organization.id);
    expectOwnersAlerted(rows, `/dashboard/platform/organizations/${organization.id}`);
    const mine = rows.outbox.find((row) => row.recipient_user_id === platform.userId);
    expect(mine?.values).toMatchObject({ organizationName, trialStarted: false });
    // The owner's contact details stay on the organization record.
    expect(JSON.stringify(rows)).not.toContain(email);
  });
});
