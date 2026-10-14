/**
 * B0-SUP-02 — learners cannot open Atlas support tickets (default rule:
 * learner support stays with the academy, OQ-23). The tenant support-case
 * routes run behind `ManagementSurfaceGuard`, so a session opened on an
 * academy website is refused — a learner's, and even the organization
 * owner's own academy-site session — while the owner on the management
 * surface can file a case.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('B0-SUP-02 learner support path (e2e)', () => {
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

  async function signUpAndSignIn(label: string) {
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

  /** An Academy-surface session (password, then the emailed code). */
  async function academySession(academyId: string, host: string, email: string) {
    const open = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('Host', host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    if (open.body.accessToken) return open.body.accessToken as string;
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    const rows = await admin.$queryRaw<{ values: { code?: string } | null }[]>`
      SELECT "values" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${user.id} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    const verified = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .set('Host', host)
      .send({
        challengeId: open.body.challengeId,
        code: rows[0]?.values?.code,
        rememberDevice: false,
        surface: 'academy',
      })
      .expect(200);
    return verified.body.accessToken as string;
  }

  const fileCase = (organizationId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/organizations/${organizationId}/support-cases`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Help please', description: 'Something is not working.' });

  it('refuses academy-site sessions (learner and owner) and accepts the owner on the management surface', async () => {
    const owner = await signUpAndSignIn('sup02-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'sup02-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'sup02');
    const academy = await seedAcademy(admin, org.id, 'sup02-academy');
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    const host = `sup02-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sup02.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });

    const student = await signUpAndSignIn('sup02-student');
    await seedAcademyStudent(admin, academy.id, student.userId);
    const learnerToken = await academySession(academy.id, host, student.email);
    const learner = await fileCase(org.id, learnerToken);
    expect(learner.status).toBe(403);
    expect(learner.body.error.messageKey).toBe('errors.auth.managementSurfaceOnly');

    const ownerOnSite = await fileCase(
      org.id,
      await academySession(academy.id, host, owner.email),
    );
    expect(ownerOnSite.status).toBe(403);
    expect(ownerOnSite.body.error.messageKey).toBe('errors.auth.managementSurfaceOnly');

    expect(await admin.supportCase.count({ where: { organizationId: org.id } })).toBe(0);
    await fileCase(org.id, owner.token).expect(201);
    expect(await admin.supportCase.count({ where: { organizationId: org.id } })).toBe(1);
  });
});
