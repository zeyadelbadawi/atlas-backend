/**
 * Notifications — functional + security e2e suite (Phase P17, master
 * plan §21). Covers `GET /notifications`, `GET /notifications/summary`,
 * `PATCH /notifications/:id/read`, `POST /notifications/read-all`,
 * `GET/PATCH /notifications/preferences`, and the duplicate-notification
 * protection contract (`Notification`'s own `dedupeKey` mechanism).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { NotificationFanoutService } from '../src/notification-events/services/notification-fanout.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { PrismaClient } from '@prisma/client';

jest.setTimeout(30000);

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

describe('Notifications — P17 (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let notificationFanoutService: NotificationFanoutService;
  let tenancyContextService: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    notificationFanoutService = app.get(NotificationFanoutService);
    tenancyContextService = app.get(TenancyContextService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  /** Directly exercises the fanout writer — the same mechanism every real domain event in this phase uses — bypassing the need to trigger a full business flow twice (some of which, like a payment review, are structurally impossible to repeat via the real HTTP surface once approved). */
  async function seedNotification(
    userId: string,
    dedupeKey: string | null,
  ): Promise<boolean> {
    return tenancyContextService.runInUserContext(userId, (tx) =>
      notificationFanoutService.notify(tx, {
        userId,
        type: 'system',
        priority: 'medium',
        titleKey: 'notifications:events.provisioningCompleted.title',
        messageKey: 'notifications:events.provisioningCompleted.message',
        values: { academyName: 'Test Academy' },
        dedupeKey,
      }),
    );
  }

  // --- Ownership / isolation --------------------------------------------

  describe('Ownership', () => {
    it('N1: an authenticated user can retrieve own notifications', async () => {
      const user = await signUpAndSignIn(app, 'notif-own');
      await seedNotification(user.userId, `n1-${user.userId}`);

      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      expect(
        res.body.items.every((n: { userId: string }) => n.userId === user.userId),
      ).toBe(true);
    });

    it('N2: a user cannot retrieve another user’s notifications', async () => {
      const owner = await signUpAndSignIn(app, 'notif-victim');
      const attacker = await signUpAndSignIn(app, 'notif-attacker');
      await seedNotification(owner.userId, `n2-${owner.userId}`);

      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .expect(200);

      expect(
        res.body.items.some((n: { userId: string }) => n.userId === owner.userId),
      ).toBe(false);
    });

    it('N3: a user can mark own notification as read', async () => {
      const user = await signUpAndSignIn(app, 'notif-markown');
      await seedNotification(user.userId, `n3-${user.userId}`);
      const list = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      const notificationId = list.body.items[0].id;

      const res = await request(app.getHttpServer())
        .patch(`/notifications/${notificationId}/read`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.isRead).toBe(true);
    });

    it('N4: a user cannot mark another user’s notification as read', async () => {
      const owner = await signUpAndSignIn(app, 'notif-markvictim');
      const attacker = await signUpAndSignIn(app, 'notif-markattacker');
      await seedNotification(owner.userId, `n4-${owner.userId}`);
      const list = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      const notificationId = list.body.items[0].id;

      await request(app.getHttpServer())
        .patch(`/notifications/${notificationId}/read`)
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .expect(404);

      // Confirm it genuinely wasn't mutated.
      const stillUnread = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(
        stillUnread.body.items.find((n: { id: string }) => n.id === notificationId)
          .isRead,
      ).toBe(false);
    });

    it('N5: mark-all-as-read only affects the caller’s own notifications', async () => {
      const owner = await signUpAndSignIn(app, 'notif-allvictim');
      const attacker = await signUpAndSignIn(app, 'notif-allattacker');
      await seedNotification(owner.userId, `n5-${owner.userId}`);
      await seedNotification(attacker.userId, `n5b-${attacker.userId}`);

      await request(app.getHttpServer())
        .post('/notifications/read-all')
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .expect(201);

      const ownerList = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(
        ownerList.body.items.find((n: { userId: string }) => n.userId === owner.userId)
          .isRead,
      ).toBe(false);
    });

    it('N6: unauthenticated callers cannot reach any notifications route', async () => {
      await request(app.getHttpServer()).get('/notifications').expect(401);
      await request(app.getHttpServer()).get('/notifications/summary').expect(401);
      await request(app.getHttpServer()).get('/notifications/preferences').expect(401);
    });
  });

  // --- Preferences ---------------------------------------------------------

  describe('Preferences', () => {
    it('N7: a fresh account defaults to email-only (no push/SMS provider exists)', async () => {
      const user = await signUpAndSignIn(app, 'notif-defaultprefs');
      const res = await request(app.getHttpServer())
        .get('/notifications/preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(res.body).toEqual({ email: true, push: false, sms: false });
    });

    it('N8: a user can update own notification preferences', async () => {
      const user = await signUpAndSignIn(app, 'notif-updateprefs');
      const res = await request(app.getHttpServer())
        .patch('/notifications/preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ email: false, push: false, sms: false })
        .expect(200);
      expect(res.body).toEqual({ email: false, push: false, sms: false });

      const reread = await request(app.getHttpServer())
        .get('/notifications/preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(reread.body).toEqual({ email: false, push: false, sms: false });
    });

    it('N9: rejects a partial preferences payload (the contract requires the full object)', async () => {
      const user = await signUpAndSignIn(app, 'notif-partialprefs');
      await request(app.getHttpServer())
        .patch('/notifications/preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ email: false })
        .expect(400);
    });
  });

  // --- Summary ---------------------------------------------------------------

  describe('Summary', () => {
    it('N10: summary counts match the real underlying rows', async () => {
      const user = await signUpAndSignIn(app, 'notif-summary');
      await seedNotification(user.userId, `n10a-${user.userId}`);
      await seedNotification(user.userId, `n10b-${user.userId}`);

      const res = await request(app.getHttpServer())
        .get('/notifications/summary')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect(res.body.unread).toBeGreaterThanOrEqual(2);
      expect(res.body.byType.system).toBeGreaterThanOrEqual(2);
    });
  });

  // --- Duplicate protection ---------------------------------------------------

  describe('Duplicate protection', () => {
    it('N11: a repeated event with the same dedupe key never creates a second notification row', async () => {
      const user = await signUpAndSignIn(app, 'notif-dedupe');
      const dedupeKey = `dedupe-test-${user.userId}`;

      const first = await seedNotification(user.userId, dedupeKey);
      const second = await seedNotification(user.userId, dedupeKey);

      expect(first).toBe(true);
      expect(second).toBe(false);

      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      const matching = res.body.items.filter(
        (n: { values?: { academyName?: string } }) =>
          n.values?.academyName === 'Test Academy',
      );
      expect(matching).toHaveLength(1);
    });

    it('N12: events with no dedupe key (e.g. security alerts) are never merged', async () => {
      const user = await signUpAndSignIn(app, 'notif-nodedupe');
      const first = await seedNotification(user.userId, null);
      const second = await seedNotification(user.userId, null);
      expect(first).toBe(true);
      expect(second).toBe(true);
    });
  });
});
