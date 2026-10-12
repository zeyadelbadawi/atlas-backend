/**
 * B0-ORG-06 — what a registration-policy change does to learners already
 * waiting for approval: NOTHING automatic. Switching from "approval" to
 * "open" or "invite" neither admits nor drops them; they stay `pending`
 * in the approval queue, and the owner can still approve or reject them
 * (the decision does not depend on the current policy).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';

async function signUp(app: INestApplication, label: string) {
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
    token: signIn.body.accessToken as string,
  };
}

describe('Registration policy change and pending learners (e2e, B0-ORG-06)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let owner: { userId: string; token: string };
  let academyId: string;
  let organizationId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
    owner = await signUp(app, 'org06-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'org06-org');
    organizationId = org.id;
    await seedActiveSubscriptionForOrg(admin, org.id, 'org06-sub');
    academyId = (await seedAcademy(admin, org.id, 'org06-academy')).id;
    await seedAcademyMember(admin, academyId, owner.userId, 'owner');
  });

  afterAll(async () => {
    if (organizationId) {
      await admin.organization.delete({ where: { id: organizationId } }).catch(() => {});
    }
    await admin?.$disconnect();
    await app?.close();
  });

  const setPolicy = (policy: 'open' | 'invite' | 'approval') =>
    request(app.getHttpServer())
      .patch(`/academies/${academyId}/registration-policy`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ registrationPolicy: policy })
      .expect(200);

  const statusOf = async (userId: string) =>
    (
      await admin.academyStudent.findFirst({
        where: { academyId, userId },
        select: { status: true },
      })
    )?.status;

  it.each(['open', 'invite'] as const)(
    'switching approval → %s leaves waiting learners pending, still decidable',
    async (next) => {
      await setPolicy('approval');
      const a = await signUp(app, `org06-${next}-a`);
      const b = await signUp(app, `org06-${next}-b`);
      for (const learner of [a, b]) {
        await admin.academyStudent.create({
          data: { academyId, userId: learner.userId, status: 'pending' },
        });
      }

      await setPolicy(next);
      expect(await statusOf(a.userId)).toBe('pending');
      expect(await statusOf(b.userId)).toBe('pending');

      await request(app.getHttpServer())
        .post(`/academies/${academyId}/students/${a.userId}/approve`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/academies/${academyId}/students/${b.userId}/reject`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(await statusOf(a.userId)).toBe('active');
      expect(await statusOf(b.userId)).toBe('inactive');
    },
  );
});
