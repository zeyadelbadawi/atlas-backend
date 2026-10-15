/**
 * Platform Owner administrative deletion against real Postgres (cloud
 * remediation, deletion workstream). The self-delete path has real-RLS
 * coverage in phase10-6; the administrative path (be `2965719`) had only
 * unit specs with mocked transactions, which cannot prove RLS — a query
 * in the wrong context returns a confident zero instead of failing.
 *
 * Pinned here as the real `atlas_app` role:
 *   - the plan reports the target's REAL membership count (non-zero);
 *   - deletion anonymises the target and really removes their memberships
 *     (the silent-RLS regression), and archives the academies they own;
 *   - a non-platform-owner is refused; a platform owner cannot delete
 *     themselves or another platform owner;
 *   - (D5-1) the target's learner devices are revoked at every academy,
 *     and a refresh token bound to one of them is dead — the operator's
 *     context could never have reached those rows, the target's must.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import { hashDeviceCookie } from '../src/tenancy/services/student-device.service';

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
    refreshToken: signIn.body.refreshToken as string,
    email,
  };
}

describe('Platform Owner administrative deletion (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let platformOwner: { userId: string; accessToken: string };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
    platformOwner = await signUpAndSignIn(app, 'pud-po');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function seedClientOwner(label: string) {
    const owner = await signUpAndSignIn(app, label);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { ...owner, organizationId: org.id, academyId: academy.id };
  }

  it('plans with real counts, then anonymises, removes memberships and archives owned academies', async () => {
    const target = await seedClientOwner('pud-target');
    const server = app.getHttpServer();

    const plan = await request(server)
      .get(`/platform-user-management/${target.userId}/deletion-plan`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    // These counts depend on the TARGET's tenant/user context; under the
    // wrong context they silently read zero and the line disappears.
    const line = (key: string) =>
      (plan.body.lines as { key: string; count: number }[]).find((l) => l.key === key);
    expect(plan.body.subjectRole).toBe('client_owner');
    expect(line('organizations')?.count).toBe(1);
    expect(line('academies')?.count).toBe(1);
    expect(line('sessions')?.count).toBeGreaterThanOrEqual(1);

    const res = await request(server)
      .post(`/platform-user-management/${target.userId}/delete`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ confirm: true, reason: 'other' })
      .expect(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.academiesArchived).toBeGreaterThan(0);

    const user = await admin.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.status).toBe('deleted');
    expect(user.email).not.toBe(target.email);
    expect(
      await admin.organizationMembership.count({ where: { userId: target.userId } }),
    ).toBe(0);
    expect(await admin.academyMember.count({ where: { userId: target.userId } })).toBe(0);
    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: target.academyId },
    });
    expect(academy.status).toBe('archived');
  });

  it('D5-1 — revokes every learner device of the target and kills device-bound sessions', async () => {
    const learner = await signUpAndSignIn(app, 'pud-learner');
    const host = await seedClientOwner('pud-learner-host');
    const second = await seedAcademy(admin, host.organizationId, 'pud-learner-second');
    const devices = [];
    for (const academyId of [host.academyId, second.id]) {
      await seedAcademyStudent(admin, academyId, learner.userId);
      devices.push(
        await admin.studentDevice.create({
          data: {
            userId: learner.userId,
            academyId,
            cookieHash: hashDeviceCookie(`pud-${academyId}`),
            label: 'Safari on iOS',
          },
        }),
      );
    }
    await admin.refreshToken.updateMany({
      where: { userId: learner.userId, revokedAt: null },
      data: { deviceId: devices[1].id },
    });

    await request(app.getHttpServer())
      .post(`/platform-user-management/${learner.userId}/delete`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ confirm: true })
      .expect(200);

    expect(
      await admin.studentDevice.count({
        where: { userId: learner.userId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await admin.refreshToken.count({
        where: { userId: learner.userId, revokedAt: null },
      }),
    ).toBe(0);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: learner.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${learner.accessToken}`)
      .expect(401);
    const audit = await admin.auditLogEntry.findFirstOrThrow({
      where: { action: 'account.deleted_by_platform_owner', targetId: learner.userId },
    });
    expect((audit.context as Record<string, unknown>).devicesRevoked).toBe(2);
  });

  it('refuses a caller who is not a platform owner', async () => {
    const target = await seedClientOwner('pud-refuse-target');
    const caller = await seedClientOwner('pud-refuse-caller');
    await request(app.getHttpServer())
      .post(`/platform-user-management/${target.userId}/delete`)
      .set('Authorization', `Bearer ${caller.accessToken}`)
      .send({ confirm: true })
      .expect(403);
    const user = await admin.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.status).not.toBe('deleted');
  });

  it('refuses deleting itself or another platform owner', async () => {
    await request(app.getHttpServer())
      .post(`/platform-user-management/${platformOwner.userId}/delete`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ confirm: true })
      .expect((r) => expect([403, 409]).toContain(r.status));

    const otherOwner = await signUpAndSignIn(app, 'pud-other-po');
    await admin.user.update({
      where: { id: otherOwner.userId },
      data: { isPlatformOwner: true },
    });
    await request(app.getHttpServer())
      .post(`/platform-user-management/${otherOwner.userId}/delete`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ confirm: true })
      .expect((r) => expect([403, 409]).toContain(r.status));
    const other = await admin.user.findUniqueOrThrow({
      where: { id: otherOwner.userId },
    });
    expect(other.status).not.toBe('deleted');
  });
});
