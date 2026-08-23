/**
 * `CurrentUser.organizations`/`.organizationMemberships` — real data from
 * PostgreSQL, never hardcoded/derived from the request (master plan §21
 * Phase P2, this phase's §20).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

describe('CurrentUser organization data (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('a user with no organizations gets empty arrays, not fabricated demo data', async () => {
    const email = uniqueTestEmail('curuser-none');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'No Orgs Fixture', email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    expect(signIn.body.user.organizations).toEqual([]);
    expect(signIn.body.user.organizationMemberships).toEqual([]);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);
    expect(me.body.organizations).toEqual([]);
    expect(me.body.organizationMemberships).toEqual([]);
  });

  it('a user with real organizations sees them on both sign-in and /users/me, identically on both fields', async () => {
    const email = uniqueTestEmail('curuser-real');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Real Orgs Fixture', email, password })
      .expect(201);
    const firstSignIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const userId: string = firstSignIn.body.user.id;

    const org1 = await seedOrganizationWithOwner(admin, userId, 'curuser-org1');
    const org2 = await seedOrganizationWithOwner(admin, userId, 'curuser-org2');

    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    const orgIds = signIn.body.user.organizations
      .map((o: { organizationId: string }) => o.organizationId)
      .sort();
    expect(orgIds).toEqual([org1.id, org2.id].sort());
    expect(signIn.body.user.organizations).toEqual(
      signIn.body.user.organizationMemberships,
    );

    const membership = signIn.body.user.organizations.find(
      (o: { organizationId: string }) => o.organizationId === org1.id,
    );
    expect(membership.organizationName).toBe(org1.name);
    expect(membership.role).toBe('owner');
    expect(membership.isPrimary).toBe(true);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);
    const meOrgIds = me.body.organizations
      .map((o: { organizationId: string }) => o.organizationId)
      .sort();
    expect(meOrgIds).toEqual([org1.id, org2.id].sort());
  });

  it("never leaks another user's organization membership", async () => {
    const userA = await (async () => {
      const email = uniqueTestEmail('curuser-leak-a');
      const password = 'correct-horse-battery';
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'Leak Test A', email, password })
        .expect(201);
      return request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password })
        .expect(200);
    })();
    const userB = await (async () => {
      const email = uniqueTestEmail('curuser-leak-b');
      const password = 'correct-horse-battery';
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'Leak Test B', email, password })
        .expect(201);
      return request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password })
        .expect(200);
    })();

    await seedOrganizationWithOwner(admin, userB.body.user.id, 'curuser-leak-org-b');

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${userA.body.accessToken}`)
      .expect(200);

    expect(me.body.organizations).toEqual([]);
  });
});
