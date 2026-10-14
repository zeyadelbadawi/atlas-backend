/**
 * B0-OPS-10 — the subscription proof backlog gauges read the real Platform
 * Owner review queue under RLS: a pending subscription payment counts and
 * ages from its LATEST proof; reviewed payments and course-order payments
 * (no checkout) do not count.
 *
 * The database is shared with other suites, so counts are deltas and the
 * age assertion is a lower bound.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import { SubscriptionProofBacklogMetrics } from '../src/billing/metrics/subscription-proof-backlog.metrics';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct-horse-battery';

describe('B0-OPS-10 subscription proof backlog gauges (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let metrics: SubscriptionProofBacklogMetrics;
  let clock = Date.now();

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
    metrics = app.get(SubscriptionProofBacklogMetrics);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  /** Each read is a fresh query (the per-scrape cache is keyed on time). */
  function read() {
    clock += 60_000;
    return metrics.read(clock);
  }

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return user.id;
  }

  async function payment(
    organizationId: string,
    options: {
      reviewStatus: 'pending' | 'approved' | 'not_required';
      withCheckout?: boolean;
      proofsUploadedAt?: Date[];
    },
  ) {
    const checkout =
      options.withCheckout === false
        ? null
        : await admin.checkout.create({
            data: {
              organizationId,
              targetType: 'plan_subscription',
              targetKey: 'plan',
              billingCycle: 'monthly',
              snapshot: {},
              status: 'pending_payment',
              expiresAt: new Date(Date.now() + DAY),
              idempotencyKey: `ops10-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            },
          });
    const created = await admin.payment.create({
      data: {
        organizationId,
        checkoutId: checkout?.id ?? null,
        methodKey: 'manual_bank_transfer',
        methodType: 'manual_bank_transfer',
        provider: 'atlas_manual',
        amountMinorUnits: 119_000n,
        currency: 'EGP',
        status: 'pending',
        reviewStatus: options.reviewStatus,
      },
    });
    for (const uploadedAt of options.proofsUploadedAt ?? []) {
      await admin.paymentProof.create({
        data: {
          paymentId: created.id,
          fileName: 'receipt.png',
          storageKey: `test/ops10/${created.id}/${uploadedAt.getTime()}.png`,
          mimeType: 'image/png',
          uploadedAt,
        },
      });
    }
    return created;
  }

  it('counts pending subscription proofs and ages them from the latest proof', async () => {
    const operator = await signUp('ops10-operator');
    await admin.user.update({ where: { id: operator }, data: { isPlatformOwner: true } });
    const owner = await signUp('ops10-owner');
    const org = await seedOrganizationWithOwner(admin, owner, 'ops10-org');

    const before = await read();
    expect(before).not.toBeNull();

    // Pending, first proof 5 days ago, resubmitted 2 days ago → waits 2 days.
    await payment(org.id, {
      reviewStatus: 'pending',
      proofsUploadedAt: [new Date(Date.now() - 5 * DAY), new Date(Date.now() - 2 * DAY)],
    });
    // Already reviewed: not waiting.
    await payment(org.id, {
      reviewStatus: 'approved',
      proofsUploadedAt: [new Date(Date.now() - 9 * DAY)],
    });
    // A course-order payment (no checkout) pending review: the academy or
    // course-payment queue, not this one.
    await payment(org.id, {
      reviewStatus: 'pending',
      withCheckout: false,
      proofsUploadedAt: [new Date(Date.now() - 9 * DAY)],
    });

    const after = await read();
    expect(after!.pending - before!.pending).toBe(1);
    expect(after!.oldestPendingSeconds).toBeGreaterThanOrEqual(2 * 24 * 3600 - 5);

    // And it reaches the scrape output with the queue label only.
    const text = await METRICS_REGISTRY.getSingleMetricAsString(
      'atlas_subscription_proofs_pending',
    );
    expect(text).toMatch(/atlas_subscription_proofs_pending\{queue="subscription"\} \d+/);
  });
});
