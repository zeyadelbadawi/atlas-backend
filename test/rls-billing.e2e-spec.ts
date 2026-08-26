/**
 * Direct PostgreSQL/RLS proof for `payment_methods` / `checkouts` /
 * `payments` / `payment_attempts` / `payment_proofs` / `payment_reviews` /
 * `tenant_invoices` / `payment_webhook_events`, plus the two `SECURITY
 * DEFINER`/session-variable-paired mechanisms this phase introduces
 * (`resolve_payment_organization`, `is_platform_owner`) and the additive
 * `tenant_subscriptions_tenant_update` policy — mirrors
 * `rls-tenant-subscriptions.e2e-spec.ts`/`rls-domain.e2e-spec.ts`'s exact
 * pattern: every test talks to Postgres directly through the app's own
 * `PrismaService` (connected as the restricted `atlas_app` role) and
 * `TenancyContextService`. No guard, no service, no HTTP request anywhere
 * in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — billing (checkouts/payments/*, direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createUser(
    label: string,
    isPlatformOwner = false,
  ): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: {
        email: uniqueTestEmail(label),
        passwordHash: 'x',
        name: label,
        isPlatformOwner,
      },
    });
    return { id: user.id };
  }

  async function createOrgOwnedBy(ownerId: string, slugLabel: string) {
    return prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const org = await tx.organization.create({
        data: {
          id,
          name: slugLabel,
          slug: `${slugLabel}-${Date.now()}`,
          ownerUserId: ownerId,
        },
      });
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
      });
      return org;
    });
  }

  async function createPlan(slugLabel: string) {
    return prisma.plan.create({
      data: {
        key: `${slugLabel}-${Date.now()}`,
        name: slugLabel,
        limits: {
          academies: 1,
          students: 1,
          instructors: 1,
          staff: 1,
          courses: 1,
          generalStorage: 1,
          videoStorage: 1,
        },
        features: {
          cms: false,
          seo: false,
          seoAdvanced: false,
          marketing: false,
          marketingAdvanced: false,
          analytics: false,
          analyticsAdvanced: false,
          customDomain: false,
          themes: false,
          multipleThemes: false,
          backup: false,
        },
        pricing: { amount: 10, currency: 'USD', billingCycle: 'monthly' },
      },
    });
  }

  async function createCheckout(organizationId: string, planKey: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.checkout.create({
        data: {
          organizationId,
          targetType: 'plan_subscription',
          targetKey: planKey,
          status: 'draft',
          snapshot: {
            target: { type: 'plan_subscription', planKey },
            displayName: 'x',
            price: { amountMinorUnits: 1000, currency: 'USD' },
            capturedAt: new Date().toISOString(),
          },
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: `rls-${randomUUID()}`,
        },
      }),
    );
  }

  async function createPayment(organizationId: string, checkoutId: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.payment.create({
        data: {
          organizationId,
          checkoutId,
          methodKey: 'atlas_bank_transfer',
          methodType: 'manual_bank_transfer',
          provider: 'atlas_manual',
          amountMinorUnits: 1000n,
          currency: 'USD',
          status: 'pending',
          reviewStatus: 'pending',
        },
      }),
    );
  }

  it('payment_methods (platform catalog) is readable with NO session context at all', async () => {
    const method = await prisma.paymentMethod.create({
      data: {
        key: `rls-method-${Date.now()}`,
        type: 'manual_bank_transfer',
        displayName: 'x',
        provider: 'atlas_manual',
        capabilities: {},
      },
    });
    const rows = await prisma.paymentMethod.findMany({ where: { id: method.id } });
    expect(rows).toHaveLength(1);
  });

  describe('checkouts', () => {
    it('SELECT: an active tenant context only ever sees its own Checkout', async () => {
      const owner1 = await createUser('rls-co-select-owner1');
      const owner2 = await createUser('rls-co-select-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-co-select-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-co-select-org2');
      const plan = await createPlan('rls-co-select-plan');
      const co1 = await createCheckout(org1.id, plan.key);
      const co2 = await createCheckout(org2.id, plan.key);

      const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.checkout.findMany({ where: { id: { in: [co1.id, co2.id] } } }),
      );
      expect(visible.map((c) => c.id)).toEqual([co1.id]);
    });

    it('SELECT: with no session variable set at all, every Checkout row is invisible (fail-closed)', async () => {
      const owner = await createUser('rls-co-noctx-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-co-noctx-org');
      const plan = await createPlan('rls-co-noctx-plan');
      const co = await createCheckout(org.id, plan.key);

      const rows = await prisma.checkout.findMany({ where: { id: co.id } });
      expect(rows).toEqual([]);
    });

    it('ATTACK (blocked): cannot create a Checkout for a different organization than the active tenant context', async () => {
      const owner1 = await createUser('rls-atk-co-owner1');
      const owner2 = await createUser('rls-atk-co-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-co-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-co-org2');
      const plan = await createPlan('rls-atk-co-plan');

      await expect(
        tenancyContext.runInTenantContext(org1.id, (tx) =>
          tx.checkout.create({
            data: {
              organizationId: org2.id,
              targetType: 'plan_subscription',
              targetKey: plan.key,
              status: 'draft',
              snapshot: {},
              expiresAt: new Date(Date.now() + 60_000),
              idempotencyKey: `rls-atk-${randomUUID()}`,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });
  });

  describe('payments', () => {
    it('SELECT: an active tenant context only ever sees its own Payment', async () => {
      const owner1 = await createUser('rls-pay-select-owner1');
      const owner2 = await createUser('rls-pay-select-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-pay-select-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-pay-select-org2');
      const plan = await createPlan('rls-pay-select-plan');
      const co1 = await createCheckout(org1.id, plan.key);
      const co2 = await createCheckout(org2.id, plan.key);
      const p1 = await createPayment(org1.id, co1.id);
      const p2 = await createPayment(org2.id, co2.id);

      const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.payment.findMany({ where: { id: { in: [p1.id, p2.id] } } }),
      );
      expect(visible.map((p) => p.id)).toEqual([p1.id]);
    });

    it('SELECT: with no session variable set at all, every Payment row is invisible (fail-closed)', async () => {
      const owner = await createUser('rls-pay-noctx-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-pay-noctx-org');
      const plan = await createPlan('rls-pay-noctx-plan');
      const co = await createCheckout(org.id, plan.key);
      const p = await createPayment(org.id, co.id);

      const rows = await prisma.payment.findMany({ where: { id: p.id } });
      expect(rows).toEqual([]);
    });

    it("ATTACK (blocked): a tenant context cannot UPDATE another organization's Payment", async () => {
      const owner1 = await createUser('rls-atk-pay-owner1');
      const owner2 = await createUser('rls-atk-pay-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-pay-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-pay-org2');
      const plan = await createPlan('rls-atk-pay-plan');
      const co2 = await createCheckout(org2.id, plan.key);
      const p2 = await createPayment(org2.id, co2.id);

      const affected = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.payment.updateMany({ where: { id: p2.id }, data: { status: 'cancelled' } }),
      );
      expect(affected.count).toBe(0);

      const stillPending = await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.payment.findUniqueOrThrow({ where: { id: p2.id } }),
      );
      expect(stillPending.status).toBe('pending');
    });

    it('PLATFORM REVIEW (allowed): a verified Platform Owner, under runInUserContext, reads a Payment across every organization', async () => {
      const owner = await createUser('rls-plat-pay-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-plat-pay-org');
      const plan = await createPlan('rls-plat-pay-plan');
      const co = await createCheckout(org.id, plan.key);
      const payment = await createPayment(org.id, co.id);
      const platformOwner = await createUser('rls-plat-pay-reviewer', true);

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.payment.findFirst({ where: { id: payment.id } }),
      );
      expect(visible?.id).toBe(payment.id);
    });

    it('PLATFORM REVIEW (blocked): a regular (non-platform-owner) user, under runInUserContext, cannot read a Payment belonging to a different organization', async () => {
      const owner = await createUser('rls-nonplat-pay-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-nonplat-pay-org');
      const plan = await createPlan('rls-nonplat-pay-plan');
      const co = await createCheckout(org.id, plan.key);
      const payment = await createPayment(org.id, co.id);
      const regularUser = await createUser('rls-nonplat-pay-regular', false);

      const visible = await tenancyContext.runInUserContext(regularUser.id, (tx) =>
        tx.payment.findFirst({ where: { id: payment.id } }),
      );
      expect(visible).toBeNull();
    });

    it('PLATFORM REVIEW (allowed): a verified Platform Owner can UPDATE a Payment across every organization', async () => {
      const owner = await createUser('rls-plat-upd-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-plat-upd-org');
      const plan = await createPlan('rls-plat-upd-plan');
      const co = await createCheckout(org.id, plan.key);
      const payment = await createPayment(org.id, co.id);
      const platformOwner = await createUser('rls-plat-upd-reviewer', true);

      const updated = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.payment.update({
          where: { id: payment.id },
          data: { reviewStatus: 'approved' },
        }),
      );
      expect(updated.reviewStatus).toBe('approved');
    });
  });

  describe('payment_attempts / payment_proofs / payment_reviews (transitive via payments.organization_id)', () => {
    it('SELECT: tenant context only sees attempts/proofs for its own Payments', async () => {
      const owner1 = await createUser('rls-child-owner1');
      const owner2 = await createUser('rls-child-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-child-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-child-org2');
      const plan = await createPlan('rls-child-plan');
      const co1 = await createCheckout(org1.id, plan.key);
      const co2 = await createCheckout(org2.id, plan.key);
      const p1 = await createPayment(org1.id, co1.id);
      const p2 = await createPayment(org2.id, co2.id);

      const attempt1 = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.paymentAttempt.create({ data: { paymentId: p1.id, status: 'initiated' } }),
      );
      await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.paymentAttempt.create({ data: { paymentId: p2.id, status: 'initiated' } }),
      );

      const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.paymentAttempt.findMany({ where: { paymentId: { in: [p1.id, p2.id] } } }),
      );
      expect(visible.map((a) => a.id)).toEqual([attempt1.id]);
    });

    it("ATTACK (blocked): cannot insert a payment_proof against another organization's Payment", async () => {
      const owner1 = await createUser('rls-atk-proof-owner1');
      const owner2 = await createUser('rls-atk-proof-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-proof-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-proof-org2');
      const plan = await createPlan('rls-atk-proof-plan');
      const co2 = await createCheckout(org2.id, plan.key);
      const p2 = await createPayment(org2.id, co2.id);

      await expect(
        tenancyContext.runInTenantContext(org1.id, (tx) =>
          tx.paymentProof.create({
            data: {
              paymentId: p2.id,
              fileName: 'x',
              storageKey: 'x',
              mimeType: 'image/png',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });

    it('PLATFORM REVIEW (allowed): a verified Platform Owner reads payment_reviews across every organization; INSERT requires reviewedBy = self', async () => {
      const owner = await createUser('rls-plat-review-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-plat-review-org');
      const plan = await createPlan('rls-plat-review-plan');
      const co = await createCheckout(org.id, plan.key);
      const payment = await createPayment(org.id, co.id);
      const platformOwner = await createUser('rls-plat-review-reviewer', true);
      const impersonator = await createUser('rls-plat-review-impersonator', true);

      // Cannot attribute a review to someone else, even as a real Platform Owner.
      await expect(
        tenancyContext.runInUserContext(impersonator.id, (tx) =>
          tx.paymentReview.create({
            data: {
              paymentId: payment.id,
              status: 'approved',
              reviewedBy: platformOwner.id,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);

      const review = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.paymentReview.create({
          data: {
            paymentId: payment.id,
            status: 'approved',
            reviewedBy: platformOwner.id,
          },
        }),
      );
      expect(review.reviewedBy).toBe(platformOwner.id);

      const seenByOrg = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.paymentReview.findFirst({ where: { id: review.id } }),
      );
      expect(seenByOrg?.id).toBe(review.id);
    });
  });

  describe('tenant_invoices / payment_webhook_events', () => {
    it('tenant_invoices: SELECT is tenant-scoped and fail-closed with no context', async () => {
      const owner = await createUser('rls-inv-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-inv-org');
      const invoice = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.tenantInvoice.create({
          data: {
            organizationId: org.id,
            number: `INV-${Date.now()}`,
            amountMinorUnits: 1000n,
            currency: 'USD',
          },
        }),
      );

      const rows = await prisma.tenantInvoice.findMany({ where: { id: invoice.id } });
      expect(rows).toEqual([]);

      const visible = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.tenantInvoice.findFirst({ where: { id: invoice.id } }),
      );
      expect(visible?.id).toBe(invoice.id);
    });

    it('payment_webhook_events: SELECT is tenant-scoped', async () => {
      const owner1 = await createUser('rls-whe-owner1');
      const owner2 = await createUser('rls-whe-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-whe-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-whe-org2');
      const plan = await createPlan('rls-whe-plan');
      const co1 = await createCheckout(org1.id, plan.key);
      const p1 = await createPayment(org1.id, co1.id);

      const event1 = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.paymentWebhookEvent.create({
          data: {
            organizationId: org1.id,
            provider: 'atlas_manual',
            eventId: `rls-evt-${randomUUID()}`,
            eventType: 'payment.succeeded',
            paymentId: p1.id,
          },
        }),
      );

      const visible = await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.paymentWebhookEvent.findFirst({ where: { id: event1.id } }),
      );
      expect(visible).toBeNull();
    });
  });

  describe('tenant_subscriptions — additive UPDATE policy (P12)', () => {
    it("LEGITIMATE (allowed): updating the active tenant context's own subscription", async () => {
      const owner = await createUser('rls-sub-upd-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-sub-upd-org');
      const plan = await createPlan('rls-sub-upd-plan');
      await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.tenantSubscription.create({
          data: { organizationId: org.id, planId: plan.id },
        }),
      );

      const updated = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.tenantSubscription.update({
          where: { organizationId: org.id },
          data: { status: 'active' },
        }),
      );
      expect(updated.status).toBe('active');
    });

    it("ATTACK (blocked): cannot UPDATE another organization's subscription", async () => {
      const owner1 = await createUser('rls-atk-sub-upd-owner1');
      const owner2 = await createUser('rls-atk-sub-upd-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-sub-upd-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-sub-upd-org2');
      const plan = await createPlan('rls-atk-sub-upd-plan');
      await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.tenantSubscription.create({
          data: { organizationId: org2.id, planId: plan.id },
        }),
      );

      const affected = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.tenantSubscription.updateMany({
          where: { organizationId: org2.id },
          data: { status: 'active' },
        }),
      );
      expect(affected.count).toBe(0);
    });
  });

  describe('SECURITY DEFINER: resolve_payment_organization (the one explicit RLS exception this phase introduces)', () => {
    it('resolves a real Payment id to its organization id, with NO session variable set at all', async () => {
      const owner = await createUser('rls-def-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-def-org');
      const plan = await createPlan('rls-def-plan');
      const co = await createCheckout(org.id, plan.key);
      const payment = await createPayment(org.id, co.id);

      const rows = await prisma.$queryRaw<{ organization_id: string }[]>(
        Prisma.sql`SELECT * FROM resolve_payment_organization(${payment.id})`,
      );
      expect(rows[0]?.organization_id).toBe(org.id);
    });

    it('returns nothing for a fabricated payment id', async () => {
      const rows = await prisma.$queryRaw<{ organization_id: string }[]>(
        Prisma.sql`SELECT * FROM resolve_payment_organization(${'00000000-0000-0000-0000-000000000000'})`,
      );
      expect(rows[0]?.organization_id ?? null).toBeNull();
    });

    it('an ordinary contextless query against payments itself still returns nothing (the function is the sole, narrow exception, not a broader bypass)', async () => {
      const owner = await createUser('rls-def-noleak-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-def-noleak-org');
      const plan = await createPlan('rls-def-noleak-plan');
      const co = await createCheckout(org.id, plan.key);
      const payment = await createPayment(org.id, co.id);

      const rows = await prisma.payment.findMany({ where: { id: payment.id } });
      expect(rows).toEqual([]);
    });
  });
});
