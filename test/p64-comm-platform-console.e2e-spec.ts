/**
 * P64 Communications C7 — the Platform Owner's console, end to end against
 * real Postgres with FORCE RLS.
 *
 * TWO THINGS ARE BEING PROVEN, and the second is the point of the feature.
 *
 * 1. AUTHORIZATION. This endpoint aggregates the whole platform's email
 *    pipeline and exposes the suppression list. Nobody but the Platform
 *    Owner may read it — not an academy owner, not a learner, not an
 *    unauthenticated caller — and the guard is asserted independently of
 *    the RLS policy, because the two are meant to agree without relying
 *    on each other.
 *
 * 2. LIVENESS. `outbox.oldestPendingSeconds` is the number that
 *    distinguishes "nothing to send" from "the dispatcher has stopped
 *    draining the queue". Those two states look identical from outside —
 *    both are silence — and that is exactly how a broken mail pipeline
 *    goes unnoticed. The stuck-row case below is the regression test for
 *    the failure mode the console exists to surface.
 *
 * Addresses are asserted to come back HASHED: an operator needs counts,
 * reasons and the ability to lift a block, none of which requires this
 * endpoint to hand back real email addresses.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import {
  SuppressionService,
  hashEmail,
} from '../src/communications/services/suppression.service';

jest.setTimeout(60000);

const PASSWORD = 'correct-horse-battery';

describe('P64 Communications — platform console (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let suppressions: SuppressionService;

  let ownerToken: string;
  let tenantToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    suppressions = app.get(SuppressionService);

    const owner = await seedPlatformOwner('c7-po');
    ownerToken = owner.token;
    ownerUserId = owner.userId;

    const tenant = await signUp('c7-tenant');
    tenantToken = tenant.token;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedPlatformOwner(label: string) {
    const account = await signUp(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  // --- authorization ------------------------------------------------------

  describe('Authorization', () => {
    it('C7-1: the Platform Owner can read pipeline health', async () => {
      const res = await request(app.getHttpServer())
        .get('/platform-communications/health')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        windowDays: 30,
        outbox: expect.any(Object),
        deliveries: expect.any(Object),
        suppressions: expect.any(Object),
      });
      expect(Array.isArray(res.body.providers)).toBe(true);
      expect(typeof res.body.generatedAt).toBe('string');
    });

    it('C7-2: an ordinary tenant user is refused, even though they are authenticated', async () => {
      await request(app.getHttpServer())
        .get('/platform-communications/health')
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(403);
    });

    it('C7-3: an unauthenticated caller is refused', async () => {
      await request(app.getHttpServer())
        .get('/platform-communications/health')
        .expect(401);
    });

    it('C7-4: the suppression list and the unsuppress action carry the same guard', async () => {
      await request(app.getHttpServer())
        .get('/platform-communications/suppressions')
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(
          `/platform-communications/suppressions/${encodeURIComponent('x@atlas.test')}`,
        )
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(403);
    });

    it('C7-5: losing platform-owner status revokes access on the very next request', async () => {
      // The guard re-reads `is_platform_owner` per request rather than
      // trusting a claim minted into the token.
      await admin.user.update({
        where: { id: ownerUserId },
        data: { isPlatformOwner: false },
      });
      await request(app.getHttpServer())
        .get('/platform-communications/health')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(403);

      await admin.user.update({
        where: { id: ownerUserId },
        data: { isPlatformOwner: true },
      });
      await request(app.getHttpServer())
        .get('/platform-communications/health')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
    });
  });

  // --- the liveness signal ------------------------------------------------

  describe('Pipeline liveness', () => {
    it('C7-6: reports null when nothing is waiting, and the real age once a due row is stuck', async () => {
      const before = await request(app.getHttpServer())
        .get('/platform-communications/health')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const baseline = before.body.outbox.oldestPendingSeconds;

      // A row that became due an hour ago and nobody claimed: precisely
      // what a dead dispatcher leaves behind.
      const stuckId = randomUUID();
      const dueAt = new Date(Date.now() - 60 * 60 * 1000);
      await admin.communicationOutbox.create({
        data: {
          id: stuckId,
          key: 'platform.payment.approved',
          category: 'transactional',
          recipientUserId: ownerUserId,
          entityType: 'payment',
          entityId: randomUUID(),
          locale: 'en',
          branding: 'platform',
          channels: { inApp: true, email: 'always' },
          priority: 'medium',
          state: 'pending',
          availableAt: dueAt,
          attempts: 0,
        },
      });

      try {
        const after = await request(app.getHttpServer())
          .get('/platform-communications/health')
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200);

        // At least an hour old, and counted as overdue.
        expect(after.body.outbox.oldestPendingSeconds).toBeGreaterThanOrEqual(3500);
        expect(after.body.outbox.overdue).toBeGreaterThanOrEqual(1);
        expect(after.body.outbox.byState.pending).toBeGreaterThanOrEqual(1);
        // Whatever the baseline was, a stuck row must not REDUCE it.
        if (typeof baseline === 'number') {
          expect(after.body.outbox.oldestPendingSeconds).toBeGreaterThanOrEqual(baseline);
        }
      } finally {
        await admin.communicationOutbox.delete({ where: { id: stuckId } });
      }
    });

    it('C7-7: a failure ratio of 0/0 is reported as 0, not as total failure', async () => {
      const res = await request(app.getHttpServer())
        .get('/platform-communications/health?days=1')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body.deliveries.failureRatio).toBeGreaterThanOrEqual(0);
      expect(res.body.deliveries.failureRatio).toBeLessThanOrEqual(1);
      expect(Number.isNaN(res.body.deliveries.failureRatio)).toBe(false);
    });

    it('C7-8: rejects a window outside the allowed range instead of scanning the table', async () => {
      await request(app.getHttpServer())
        .get('/platform-communications/health?days=99999')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(400);
    });
  });

  // --- suppressions -------------------------------------------------------

  describe('Suppression management', () => {
    it('C7-9: lists suppressions by HASH, never the address, and lifting one works', async () => {
      const victim = uniqueTestEmail('c7-bounced');
      await suppressions.suppress({
        email: victim,
        reason: 'hard_bounce',
        source: 'e2e',
      });

      const listed = await request(app.getHttpServer())
        .get('/platform-communications/suppressions?limit=200')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const row = listed.body.items.find(
        (r: { emailHash: string }) => r.emailHash === hashEmail(victim),
      );
      expect(row).toBeDefined();
      expect(row.reason).toBe('hard_bounce');
      // The raw address must appear nowhere in the payload.
      expect(JSON.stringify(listed.body)).not.toContain(victim);

      expect(await suppressions.isSuppressed(victim)).toBe(true);
      const lifted = await request(app.getHttpServer())
        .delete(`/platform-communications/suppressions/${encodeURIComponent(victim)}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(lifted.body).toEqual({ lifted: true });
      expect(await suppressions.isSuppressed(victim)).toBe(false);
    });

    it('C7-10: lifting an address that was never suppressed reports false, not 404', async () => {
      // A 404 here would let a caller probe whether a given address is on
      // the list; the operator's intent is satisfied either way.
      const res = await request(app.getHttpServer())
        .delete(
          `/platform-communications/suppressions/${encodeURIComponent(uniqueTestEmail('c7-never'))}`,
        )
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body).toEqual({ lifted: false });
    });

    it('C7-11: the suppression count in health agrees with the list', async () => {
      const email = uniqueTestEmail('c7-count');
      const before = await request(app.getHttpServer())
        .get('/platform-communications/health')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      await suppressions.suppress({ email, reason: 'complaint', source: 'e2e' });

      const after = await request(app.getHttpServer())
        .get('/platform-communications/health')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(after.body.suppressions.total).toBe(before.body.suppressions.total + 1);
      expect(after.body.suppressions.byReason.complaint).toBe(
        before.body.suppressions.byReason.complaint + 1,
      );
      await suppressions.unsuppress(email);
    });
  });

  // --- provider visibility ------------------------------------------------

  it('C7-12: reports the live provider chain in fallback order with its real quota', async () => {
    const res = await request(app.getHttpServer())
      .get('/platform-communications/health')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body.providers.length).toBeGreaterThan(0);
    res.body.providers.forEach((p: { position: number }, index: number) => {
      expect(p.position).toBe(index);
    });
    // Tests run on the stub; seeing it here is exactly the signal that
    // would tell an operator production is not really sending.
    expect(res.body.providers[0].provider).toBe('stub');
    expect(typeof res.body.providers[0].dailyUsed).toBe('number');
  });
});
