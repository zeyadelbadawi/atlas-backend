/**
 * Communication settings are readable, read-only, and correctly guarded
 * (cloud remediation, finding G). Both UIs used to answer 404 because
 * these routes did not exist.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

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

describe('Communication settings — read-only views (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('platform view: platform owner reads the configuration in force; others are refused', async () => {
    const owner = await signUpAndSignIn(app, 'comms-view-po');
    await admin.user.update({
      where: { id: owner.userId },
      data: { isPlatformOwner: true },
    });
    const res = await request(app.getHttpServer())
      .get('/platform-settings/communications')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body.editable).toBe(false);
    expect(['off', 'new_device', 'always']).toContain(res.body.emailOtpPolicyManagement);
    expect(res.body.trustedDeviceDaysManagement).toBeGreaterThan(0);
    expect(res.body.providerStatus[0].order.length).toBeGreaterThan(0);
    // Never a credential.
    expect(JSON.stringify(res.body)).not.toMatch(/api[_-]?key|secret/i);

    const other = await signUpAndSignIn(app, 'comms-view-not-po');
    await request(app.getHttpServer())
      .get('/platform-settings/communications')
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(403);
  });

  it('academy view: owner and manager read it; an instructor and an outsider are refused', async () => {
    const owner = await signUpAndSignIn(app, 'comms-view-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'comms-view-org');
    const academy = await seedAcademy(admin, org.id, 'comms-view-academy');
    const path = `/academies/${academy.id}/communication-settings`;

    const res = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body).toMatchObject({
      editable: false,
      emailOtpPolicy: 'inherit',
      announcementEmailAllowed: false,
    });

    const manager = await signUpAndSignIn(app, 'comms-view-manager');
    await seedMembership(admin, org.id, manager.userId, 'manager');
    // W5 (F12) — an organization manager who is not staff of THIS academy
    // (the manager of a sibling academy) is refused; the academy's own
    // manager reads it.
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(403);
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const instructor = await signUpAndSignIn(app, 'comms-view-instructor');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(403);

    const outsider = await signUpAndSignIn(app, 'comms-view-outsider');
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);
  });
});
