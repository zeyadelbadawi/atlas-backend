/**
 * Organization billing & payments are the OWNER's (real Postgres, RLS
 * enforced).
 *
 * `organizations/:id/payment-settings*`, `.../payments*`, `.../invoices` and
 * `.../checkouts*` used to sit behind `OrganizationMembershipGuard` alone,
 * which admits ANY organization member — so an organization Manager or
 * Instructor could read and change the payment configuration and gateway
 * credentials, start checkouts and payments on the organization's behalf,
 * cancel them, and download payment proofs and invoices.
 *
 * Each route now declares the owner-exclusive permission it needs
 * (`@OrganizationPermissions`, enforced by the same guard):
 *   - payment settings, gateway credentials, invoices: `tenant.billing.view`
 *   - reading payments / proofs / checkouts:           `tenant.payment.view`
 *   - creating checkouts/payments/intents, proof, cancel: `tenant.payment.create`
 * Only `ORGANIZATION_OWNER_PERMISSIONS` carries them.
 *
 * The Manager and Instructor here carry exactly the permission sets the
 * real grant writes (`ORGANIZATION_MANAGER_PERMISSIONS` /
 * `ORGANIZATION_INSTRUCTOR_PERMISSIONS`), so a 403 is the rule under test,
 * never an artificially empty membership.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Plan, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedPaymentMethod,
} from './utils/db-admin';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../src/tenancy/constants/organization-permissions.constants';

const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface Caller {
  readonly userId: string;
  readonly accessToken: string;
}

async function signUpAndSignIn(app: INestApplication, label: string): Promise<Caller> {
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

async function seedPricedPlan(admin: PrismaClient, keyLabel: string): Promise<Plan> {
  const key = `${keyLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.plan.create({
    data: {
      key,
      name: keyLabel,
      limits: {
        academies: 5,
        students: 100,
        instructors: 10,
        staff: 10,
        courses: 50,
        generalStorage: 20,
        videoStorage: 20,
      },
      features: { liveSessions: false },
      pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
    },
  });
}

type Method = 'get' | 'post' | 'patch' | 'put';

interface RouteCase {
  readonly family: 'payment-settings' | 'payments' | 'checkouts';
  readonly method: Method;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

describe('Organization billing & payments — owner only (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  let owner: Caller;
  let manager: Caller;
  let instructor: Caller;
  let organizationId: string;
  let checkoutId: string;
  let paymentId: string;
  let methodKey: string;
  let planKey: string;
  let routes: readonly RouteCase[];

  const http = () => request(app.getHttpServer());
  const call = (caller: Caller, route: RouteCase) => {
    const req = http()
      [route.method](route.path)
      .set('Authorization', `Bearer ${caller.accessToken}`);
    return route.body ? req.send(route.body) : req;
  };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();

    owner = await signUpAndSignIn(app, 'bown-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'bown-org');
    organizationId = org.id;
    const plan = await seedPricedPlan(admin, 'bown-plan');
    planKey = plan.key;
    await admin.tenantSubscription.create({
      data: { organizationId, planId: plan.id, status: 'trialing' },
    });
    methodKey = (await seedPaymentMethod(admin, 'bown-method')).key;

    manager = await signUpAndSignIn(app, 'bown-manager');
    await admin.organizationMembership.create({
      data: {
        organizationId,
        userId: manager.userId,
        role: 'manager',
        permissions: [...ORGANIZATION_MANAGER_PERMISSIONS],
      },
    });
    instructor = await signUpAndSignIn(app, 'bown-instructor');
    await admin.organizationMembership.create({
      data: {
        organizationId,
        userId: instructor.userId,
        role: 'instructor',
        permissions: [...ORGANIZATION_INSTRUCTOR_PERMISSIONS],
      },
    });

    // The owner's own flow — unchanged: checkout, payment, proof.
    const checkout = await http()
      .post(`/organizations/${organizationId}/checkouts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey },
        billingCycle: 'monthly',
        idempotencyKey: `bown-${Date.now()}`,
      })
      .expect(201);
    checkoutId = checkout.body.id as string;
    const payment = await http()
      .post(`/organizations/${organizationId}/payments`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ checkoutId, methodKey })
      .expect(201);
    paymentId = payment.body.id as string;
    await http()
      .patch(`/organizations/${organizationId}/payments/${paymentId}/proof`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
      .expect(200);

    const base = `/organizations/${organizationId}`;
    routes = [
      { family: 'payment-settings', method: 'get', path: `${base}/payment-settings` },
      {
        family: 'payment-settings',
        method: 'patch',
        path: `${base}/payment-settings`,
        body: { paymentCollectionMode: 'atlas_payments' },
      },
      {
        family: 'payment-settings',
        method: 'get',
        path: `${base}/payment-settings/gateway-providers`,
      },
      {
        family: 'payment-settings',
        method: 'get',
        path: `${base}/payment-settings/gateway-credentials`,
      },
      {
        family: 'payment-settings',
        method: 'put',
        path: `${base}/payment-settings/gateway-credentials`,
        body: { providerKey: 'bown-unknown-provider', config: {} },
      },
      {
        family: 'payment-settings',
        method: 'post',
        path: `${base}/payment-settings/gateway-credentials/test-connection`,
      },
      {
        family: 'payment-settings',
        method: 'post',
        path: `${base}/payment-settings/gateway-credentials/enable`,
      },
      {
        family: 'payment-settings',
        method: 'post',
        path: `${base}/payment-settings/gateway-credentials/disable`,
      },
      {
        family: 'payment-settings',
        method: 'get',
        path: `${base}/payment-settings/connected-account`,
      },
      {
        family: 'payment-settings',
        method: 'get',
        path: `${base}/payment-settings/commission`,
      },
      {
        family: 'payments',
        method: 'post',
        path: `${base}/payments`,
        body: { checkoutId, methodKey },
      },
      { family: 'payments', method: 'get', path: `${base}/payments` },
      { family: 'payments', method: 'get', path: `${base}/payments/${paymentId}` },
      {
        family: 'payments',
        method: 'patch',
        path: `${base}/payments/${paymentId}/proof`,
        body: { fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' },
      },
      {
        family: 'payments',
        method: 'post',
        path: `${base}/payments/${paymentId}/cancel`,
      },
      {
        family: 'payments',
        method: 'post',
        path: `${base}/payments/intents`,
        body: { checkoutId },
      },
      {
        family: 'payments',
        method: 'get',
        path: `${base}/payments/${paymentId}/proof/file`,
      },
      { family: 'payments', method: 'get', path: `${base}/invoices` },
      {
        family: 'checkouts',
        method: 'post',
        path: `${base}/checkouts`,
        body: {
          target: { type: 'plan_subscription', planKey },
          billingCycle: 'monthly',
          idempotencyKey: `bown-manager-${Date.now()}`,
        },
      },
      { family: 'checkouts', method: 'get', path: `${base}/checkouts/${checkoutId}` },
    ];
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it.each(['payment-settings', 'payments', 'checkouts'] as const)(
    'an organization Manager is refused on every %s route (403)',
    async (family) => {
      for (const route of routes.filter((r) => r.family === family)) {
        const res = await call(manager, route);
        expect({ route: `${route.method} ${route.path}`, status: res.status }).toEqual({
          route: `${route.method} ${route.path}`,
          status: 403,
        });
      }
    },
  );

  it.each(['payment-settings', 'payments', 'checkouts'] as const)(
    'an organization Instructor is refused on every %s route (403)',
    async (family) => {
      for (const route of routes.filter((r) => r.family === family)) {
        const res = await call(instructor, route);
        expect({ route: `${route.method} ${route.path}`, status: res.status }).toEqual({
          route: `${route.method} ${route.path}`,
          status: 403,
        });
      }
    },
  );

  it('the refused calls changed nothing: no extra checkout, payment, settings row or credential, and the payment is not cancelled', async () => {
    expect(await admin.checkout.count({ where: { organizationId } })).toBe(1);
    expect(await admin.payment.count({ where: { organizationId } })).toBe(1);
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).not.toBe('cancelled');
    expect(
      await admin.organizationPaymentSettings.count({ where: { organizationId } }),
    ).toBe(0);
    expect(
      await admin.organizationGatewayCredential.count({ where: { organizationId } }),
    ).toBe(0);
  });

  it('the organization owner still reads every route family', async () => {
    const base = `/organizations/${organizationId}`;
    for (const path of [
      `${base}/payment-settings`,
      `${base}/payment-settings/gateway-providers`,
      `${base}/payment-settings/commission`,
      `${base}/payments`,
      `${base}/payments/${paymentId}`,
      `${base}/payments/${paymentId}/proof/file`,
      `${base}/invoices`,
      `${base}/checkouts/${checkoutId}`,
    ]) {
      const res = await http()
        .get(path)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  it('the organization owner still passes the permission gate on every mutating route', async () => {
    // Whatever the business outcome (a duplicate payment, a provider that is
    // not configured…), the owner is never refused by authorization.
    for (const route of routes.filter((r) => r.method !== 'get')) {
      const res = await call(owner, route);
      expect({ route: `${route.method} ${route.path}`, status: res.status }).not.toEqual({
        route: `${route.method} ${route.path}`,
        status: 403,
      });
      expect(res.status).toBeLessThan(500);
    }
  });

  it('an outsider is still refused, and an unauthenticated caller still gets 401', async () => {
    const outsider = await signUpAndSignIn(app, 'bown-outsider');
    await http()
      .get(`/organizations/${organizationId}/payments`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);
    await http().get(`/organizations/${organizationId}/payments`).expect(401);
  });
});
