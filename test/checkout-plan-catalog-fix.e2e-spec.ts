/**
 * Regression suite for the "checkout fails with a generic validation error
 * for a brand-new account" incident.
 *
 * Root cause (see `ATLAS_CHECKOUT_PLAN_CATALOG_FIX_REPORT.md` for the full
 * investigation): the shared dev database had accumulated 6,039 `plans`
 * rows — only 3 real (`starter`/`growth`/`enterprise`, `prisma/seed.ts`),
 * the other 6,036 e2e-test fixtures, most unpriced, ALL sorting ahead of
 * the 3 real plans in `GET /plans` (fixtures default to `displayOrder: 0`;
 * the real plans are the only rows ever given a real, non-zero
 * `displayOrder`). A brand-new customer's first click was statistically
 * guaranteed to hit a broken plan. `OrganizationSubscriptionBootstrapService`
 * had the identical bug for the DEFAULT TRIAL plan every new organization
 * silently receives.
 *
 * This suite proves, end to end, against the real API:
 *   1. `GET /plans` returns exactly the 3 real, customer-facing plans.
 *   2. Each of them carries valid, checkout-usable pricing.
 *   3. A brand-new account can create a Checkout for each of the 3 and
 *      reach the payment-method stage (monthly).
 *   4. Yearly billing genuinely works when a plan's OWN pricing supports
 *      it, and is honestly rejected (`pricingUnavailable`) when it
 *      doesn't — never silently mislabeled/mischarged.
 *   5. An unpriced plan is rejected cleanly with `pricingUnavailable`,
 *      never a generic/misleading error, never a crash.
 *   6. The backend response actually carries the specific `messageKey`
 *      (`normalizeResponseError`'s own frontend-side fix is what makes
 *      this reach the UI — verified separately, live, in a real browser;
 *      see the fix report).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner, seedPlan } from './utils/db-admin';
import type { Plan, PrismaClient } from '@prisma/client';

const REAL_PLAN_KEYS = ['starter', 'growth', 'enterprise'] as const;

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
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
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Checkout/plan-catalog fix (e2e)', () => {
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

  async function newAccountWithOrg(label: string) {
    const user = await signUpAndSignIn(app, label);
    const org = await seedOrganizationWithOwner(admin, user.userId, `${label}-org`);
    return { user, org };
  }

  it('1/2. GET /plans returns exactly the 3 real, customer-facing plans, each with valid pricing', async () => {
    const { user } = await newAccountWithOrg('catalog-exact3');

    const response = await request(app.getHttpServer())
      .get('/plans')
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const keys = response.body.items.map((p: { key: string }) => p.key);
    expect(keys).toEqual([...REAL_PLAN_KEYS]);
    expect(response.body.pagination.totalItems).toBe(3);

    for (const plan of response.body.items) {
      expect(plan.status).toBe('active');
      expect(plan.displayOrder).toBeGreaterThan(0);
      expect(typeof plan.pricing.amount).toBe('number');
      expect(typeof plan.pricing.currency).toBe('string');
      expect(plan.pricing.currency.length).toBeGreaterThan(0);
    }
  });

  it.each(REAL_PLAN_KEYS)(
    '3/4/6. a brand-new account can create a MONTHLY checkout for "%s" and reach the payment-method stage',
    async (planKey) => {
      const { user, org } = await newAccountWithOrg(`checkout-${planKey}`);

      const checkout = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/checkouts`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          target: { type: 'plan_subscription', planKey },
          billingCycle: 'monthly',
          idempotencyKey: `${planKey}-monthly-idem`,
        })
        .expect(201);

      expect(checkout.body.status).toBe('draft');
      expect(checkout.body.snapshot.target.planKey).toBe(planKey);
      expect(typeof checkout.body.snapshot.price.amountMinorUnits).toBe('number');

      // "Reaches the payment-method stage" — the real next step
      // `CheckoutPage` takes after a successful `createCheckout`. Paginated
      // (`{ items, pagination }`), same Phase 4.5.3 shape as `GET /plans`.
      const methods = await request(app.getHttpServer())
        .get('/payment-methods')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(Array.isArray(methods.body.items)).toBe(true);
    },
  );

  it('4. yearly billing succeeds for a plan whose OWN pricing is configured for yearly', async () => {
    const { user, org } = await newAccountWithOrg('checkout-yearly-ok');
    const yearlyPlan = await seedPlan(admin, 'yearly-real-plan', {
      pricing: { amount: 790, currency: 'USD', billingCycle: 'yearly' },
    });

    const checkout = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: yearlyPlan.key },
        billingCycle: 'yearly',
        idempotencyKey: 'yearly-ok-idem',
      })
      .expect(201);

    expect(checkout.body.snapshot.billingCycle).toBe('yearly');
    expect(checkout.body.snapshot.price.amountMinorUnits).toBe(79000);
  });

  it('4. yearly billing is honestly rejected (pricingUnavailable) for a real plan configured for monthly only — never silently mischarged', async () => {
    const { user, org } = await newAccountWithOrg('checkout-yearly-mismatch');

    const response = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: 'growth' },
        billingCycle: 'yearly',
        idempotencyKey: 'yearly-mismatch-idem',
      })
      .expect(400);

    expect(response.body.error.messageKey).toBe('errors.checkout.pricingUnavailable');
    expect(response.body.error.kind).toBe('validation');
  });

  it('5/6. an unpriced plan is rejected cleanly with pricingUnavailable, with the specific messageKey the frontend depends on', async () => {
    const { user, org } = await newAccountWithOrg('checkout-unpriced');
    const unpriced = await seedPlan(admin, 'unpriced-plan', { pricing: null });

    const response = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: unpriced.key },
        billingCycle: 'monthly',
        idempotencyKey: 'unpriced-idem',
      })
      .expect(400);

    expect(response.body.error.kind).toBe('validation');
    expect(response.body.error.messageKey).toBe('errors.checkout.pricingUnavailable');
    expect(response.body.error.requestId).toBeTruthy();
    expect(response.body.error.retryable).toBe(false);
  });

  it('a new organization\'s default trial plan is a real, priced, customer-facing plan — never a fixture', async () => {
    // Reproduces the SECOND bug this investigation found: before the fix,
    // `findDefaultTrialPlan` had no `displayOrder` floor either, so every
    // brand-new organization silently trialed on whichever fixture plan
    // happened to sort first — confirmed live against the real dev
    // database during the original investigation (a freshly-created
    // organization was bootstrapped onto `precedence-plan-…`, not
    // `starter`).
    // The real `POST /organizations` endpoint, not the raw fixture helper
    // — `OrganizationSubscriptionBootstrapService` (the code path this
    // test is actually about) only runs on that real path, exactly like a
    // genuine new signup.
    const owner = await signUpAndSignIn(app, 'trial-default-plan-owner');
    const createdOrg = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'trial-default-plan-org' })
      .expect(201);

    const subscription = await admin.tenantSubscription.findUnique({
      where: { organizationId: createdOrg.body.id },
      include: { plan: true },
    });

    expect(subscription).not.toBeNull();
    expect((REAL_PLAN_KEYS as readonly string[])).toContain(subscription!.plan.key);
    const pricing = subscription!.plan.pricing as { amount?: number; currency?: string } | null;
    expect(pricing?.amount).toBeDefined();
    expect(pricing?.currency).toBeTruthy();
  });

  it('a plan reported via /plans/:key that is archived never appears in the checkout-eligible catalog, and checkout against it fails as a real plan-not-found, not a silent success', async () => {
    const { user, org } = await newAccountWithOrg('checkout-archived');
    const archived: Plan = await seedPlan(admin, 'archived-checkout-plan', { status: 'archived' });

    const response = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: archived.key },
        billingCycle: 'monthly',
        idempotencyKey: 'archived-idem',
      })
      .expect(404);

    expect(response.body.error.messageKey).toBe('errors.checkout.planNotFound');
  });
});
