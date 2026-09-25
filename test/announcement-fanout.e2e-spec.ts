/**
 * Announcement fan-out off the request path (cloud remediation, finding F).
 *
 * Publishing used to emit one notification per learner INSIDE the publish
 * transaction (5 s interactive-transaction budget), so a large academy's
 * publish timed out and rolled back. Pinned here against real Postgres,
 * Redis and the real queue worker:
 *   - a publish to an audience larger than several batches returns
 *     promptly and emits nothing inline;
 *   - every learner then receives exactly one notification;
 *   - a replayed job never notifies anyone twice (per-recipient dedupe);
 *   - a job for a publish that is not visible (in flight / rolled back) is
 *     refused for retry and emits nothing.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import {
  AnnouncementFanOutService,
  AnnouncementNotYetVisibleError,
} from '../src/community/services/announcement-fanout.service';
import { ANNOUNCEMENT_FANOUT_BATCH_SIZE } from '../src/community/queue/announcement-fanout.types';
import type { PrismaClient } from '@prisma/client';

const AUDIENCE = ANNOUNCEMENT_FANOUT_BATCH_SIZE * 2 + 37;

async function signUpAndSignIn(app: INestApplication, label: string) {
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

describe('Announcement fan-out (e2e, real queue)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let fanOut: AnnouncementFanOutService;
  let owner: { userId: string; accessToken: string };
  let organizationId: string;
  let academyId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
    fanOut = app.get(AnnouncementFanOutService);

    owner = await signUpAndSignIn(app, 'fanout-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'fanout-org');
    organizationId = org.id;
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, 'fanout-academy');
    academyId = academy.id;
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    const learners = Array.from({ length: AUDIENCE }, (_, i) => ({
      id: randomUUID(),
      email: `fanout-learner-${i}-${randomUUID()}@example.test`,
      name: `Learner ${i}`,
      passwordHash: 'not-a-real-hash',
    }));
    await admin.user.createMany({ data: learners });
    await admin.academyStudent.createMany({
      data: learners.map((learner) => ({ academyId: academy.id, userId: learner.id })),
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function rowsFor(announcementId: string) {
    return admin.communicationOutbox.count({
      where: { key: 'announcement.published', entityId: announcementId },
    });
  }

  async function eventuallyRows(announcementId: string, expected: number) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const count = await rowsFor(announcementId);
      if (count >= expected || Date.now() > deadline) return count;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  it('publishes promptly and reaches every learner exactly once, across several batches', async () => {
    const server = app.getHttpServer();
    const created = await request(server)
      .post(`/academies/${academyId}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Campus closed Friday', body: 'All sessions move online.' })
      .expect(201);

    const started = Date.now();
    await request(server)
      .post(`/academies/${academyId}/announcements/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    const publishMs = Date.now() - started;

    // Nothing is emitted inline — the request only enqueued the work.
    expect(await rowsFor(created.body.id)).toBe(0);
    expect(publishMs).toBeLessThan(3000);

    expect(await eventuallyRows(created.body.id, AUDIENCE)).toBe(AUDIENCE);

    // A replayed job (BullMQ retry, overlapping worker) adds nothing.
    const announcement = await admin.announcement.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    await fanOut.run({
      announcementId: announcement.id,
      academyId,
      organizationId,
      courseId: null,
      actorUserId: owner.userId,
      publishedAt: announcement.publishedAt!.toISOString(),
    });
    expect(await rowsFor(created.body.id)).toBe(AUDIENCE);
  });

  it('refuses (for retry) a job whose publish is not visible, and emits nothing', async () => {
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyId}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Still a draft', body: 'Never published.' })
      .expect(201);

    await expect(
      fanOut.run({
        announcementId: created.body.id,
        academyId,
        organizationId,
        courseId: null,
        actorUserId: owner.userId,
        publishedAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(AnnouncementNotYetVisibleError);
    expect(await rowsFor(created.body.id)).toBe(0);
  });
});
