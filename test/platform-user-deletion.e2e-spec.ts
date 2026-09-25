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
 *     themselves or another platform owner.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
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
