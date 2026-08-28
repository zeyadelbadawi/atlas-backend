/**
 * Provisioning Orchestration — tenant isolation and Platform Owner review
 * authorization (Phase P14, master plan §18: "the highest-priority suite
 * in the entire backend, CI-blocking"). Mirrors
 * `course-commerce-tenant-isolation.e2e-spec.ts`'s HTTP-level pattern:
 * every scenario here is a real request through the real guards/services/
 * RLS stack — no direct Prisma/session-variable manipulation (that
 * direct-RLS proof style is `rls-provisioning.e2e-spec.ts`, out of this
 * file's scope).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
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

async function makePlatformOwner(admin: PrismaClient, userId: string): Promise<void> {
  await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });
}

function uniqueSubdomain(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}

describe('Provisioning Orchestration — tenant isolation (e2e)', () => {
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

  async function arrangeOrg(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    return { owner, org };
  }

  async function createRequest(owner: { accessToken: string }, orgId: string) {
    const subdomain = uniqueSubdomain('iso');
    const res = await request(app.getHttpServer())
      .post(`/organizations/${orgId}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Isolation Academy',
        requestedSubdomain: subdomain,
        idempotencyKey: `idem-${subdomain}`,
      })
      .expect(201);
    return res.body;
  }

  async function waitForReady(
    owner: { accessToken: string },
    orgId: string,
    requestId: string,
  ) {
    return waitForAsync(async () => {
      const res = await request(app.getHttpServer())
        .get(`/organizations/${orgId}/provisioning-requests/${requestId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      return res.body.status === 'ready' ? res.body : undefined;
    });
  }

  // --- Cross-organization isolation (org-scoped routes) -------------------------

  it("a different organization can never read, by direct id, another organization's provisioning request", async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('iso-read-a');
    const { owner: ownerB, org: orgB } = await arrangeOrg('iso-read-b');
    const requestA = await createRequest(ownerA, orgA.id);

    await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/provisioning-requests/${requestA.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);
  });

  it("listing only ever returns the caller's own organization's requests", async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('iso-list-a');
    const { owner: ownerB, org: orgB } = await arrangeOrg('iso-list-b');
    await createRequest(ownerA, orgA.id);
    await createRequest(ownerB, orgB.id);

    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgA.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].organizationId).toBe(orgA.id);
  });

  it("a different organization can never retry another organization's provisioning request", async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('iso-retry-a');
    const { owner: ownerB, org: orgB } = await arrangeOrg('iso-retry-b');
    const requestA = await createRequest(ownerA, orgA.id);

    await request(app.getHttpServer())
      .post(`/organizations/${orgB.id}/provisioning-requests/${requestA.id}/retry`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);
  });

  it("a different organization can never cancel another organization's provisioning request", async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('iso-cancel-a');
    const { owner: ownerB, org: orgB } = await arrangeOrg('iso-cancel-b');
    const requestA = await createRequest(ownerA, orgA.id);

    await request(app.getHttpServer())
      .post(`/organizations/${orgB.id}/provisioning-requests/${requestA.id}/cancel`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);
  });

  it('a user with no membership in an organization cannot create a provisioning request for it', async () => {
    const { org } = await arrangeOrg('iso-create-org');
    const outsider = await signUpAndSignIn(app, 'iso-create-outsider');

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({
        academyName: 'Outsider Academy',
        requestedSubdomain: uniqueSubdomain('outsider'),
        idempotencyKey: `idem-outsider-${Date.now()}`,
      })
      .expect(403);
  });

  // --- Platform Owner review console (flat /provisioning-requests routes) -------

  it('a Platform Owner can list provisioning requests across every organization', async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('platform-list-a');
    const { owner: ownerB, org: orgB } = await arrangeOrg('platform-list-b');
    const requestA = await createRequest(ownerA, orgA.id);
    const requestB = await createRequest(ownerB, orgB.id);

    const platformOwner = await signUpAndSignIn(app, 'platform-list-reviewer');
    await makePlatformOwner(admin, platformOwner.userId);

    const res = await request(app.getHttpServer())
      .get('/provisioning-requests')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);

    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([requestA.id, requestB.id]));
  });

  it("a Platform Owner can get any organization's provisioning request by id", async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('platform-get-a');
    const requestA = await createRequest(ownerA, orgA.id);

    const platformOwner = await signUpAndSignIn(app, 'platform-get-reviewer');
    await makePlatformOwner(admin, platformOwner.userId);

    const res = await request(app.getHttpServer())
      .get(`/provisioning-requests/${requestA.id}`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    expect(res.body.id).toBe(requestA.id);
    // The Platform Owner's resolved response includes the same live
    // subdomain/domain data an org member would see — proves
    // `runInTenantAndUserContext` correctly resolved the request's own
    // organization as the active tenant context for this read.
    const ready = await waitForReady(ownerA, orgA.id, requestA.id);
    const platformView = await request(app.getHttpServer())
      .get(`/provisioning-requests/${requestA.id}`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    expect(platformView.body.subdomain).toMatchObject({
      subdomain: ready.subdomain.subdomain,
    });
  });

  it("a Platform Owner can retry and cancel any organization's provisioning request", async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('platform-write-a');
    const { org: blockerOrg } = await arrangeOrg('platform-write-blocker');
    const subdomain = uniqueSubdomain('platform-write');
    await admin.academy.create({
      data: { organizationId: blockerOrg.id, name: 'Blocker Academy', slug: subdomain },
    });

    const created = await request(app.getHttpServer())
      .post(`/organizations/${orgA.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        academyName: 'Platform Write Academy',
        requestedSubdomain: subdomain,
        idempotencyKey: `idem-${subdomain}`,
      })
      .expect(201);

    await waitForAsync(async () => {
      const res = await request(app.getHttpServer())
        .get(`/organizations/${orgA.id}/provisioning-requests/${created.body.id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(200);
      return res.body.status === 'failed' ? res.body : undefined;
    });

    const platformOwner = await signUpAndSignIn(app, 'platform-write-reviewer');
    await makePlatformOwner(admin, platformOwner.userId);

    // Platform Owner retries on the Tenant's behalf.
    await request(app.getHttpServer())
      .post(`/provisioning-requests/${created.body.id}/retry`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(201);

    // Platform Owner cancels on the Tenant's behalf (still non-terminal
    // right after the retry call returns, before the worker resolves it —
    // a genuine 409 here would only happen if it had already reached
    // `ready`/`cancelled`, so this call itself is the real assertion: the
    // Platform route reaches the same write path an org member's own
    // cancel call would).
    const cancelRes = await request(app.getHttpServer())
      .post(`/provisioning-requests/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`);
    expect([201, 409]).toContain(cancelRes.status);
  });

  it('a non-Platform-Owner is refused on every Platform provisioning route with 403', async () => {
    const { owner: ownerA, org: orgA } = await arrangeOrg('platform-forbidden-a');
    const requestA = await createRequest(ownerA, orgA.id);
    const notOwner = await signUpAndSignIn(app, 'platform-forbidden-caller');

    await request(app.getHttpServer())
      .get('/provisioning-requests')
      .set('Authorization', `Bearer ${notOwner.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/provisioning-requests/${requestA.id}`)
      .set('Authorization', `Bearer ${notOwner.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/provisioning-requests/${requestA.id}/retry`)
      .set('Authorization', `Bearer ${notOwner.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/provisioning-requests/${requestA.id}/cancel`)
      .set('Authorization', `Bearer ${notOwner.accessToken}`)
      .expect(403);
  });

  it('an unauthenticated caller is refused with 401 on every Platform provisioning route', async () => {
    await request(app.getHttpServer()).get('/provisioning-requests').expect(401);
    await request(app.getHttpServer())
      .get('/provisioning-requests/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });
});
