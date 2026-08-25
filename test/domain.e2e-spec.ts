/**
 * Domain management e2e suite (master plan §21 Phase P11, §10). Exercises
 * `DomainController`/`PlatformDomainController`/`InfrastructureController`'s
 * real HTTP surface. No real Cloudflare credentials exist in this test
 * environment (matches every environment today per the real frontend's
 * own documented "no real Cloudflare account exists" state) — every
 * assertion here reflects the honest `not_configured`/`connected: false`
 * behavior that follows, never a fabricated success.
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

describe('Domain management (e2e)', () => {
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

  async function seedManagedAcademy(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, org, academy };
  }

  it('a brand-new Academy has no subdomain/custom domain, and honest not_configured SSL/CDN', async () => {
    const { owner, academy } = await seedManagedAcademy('domain-fresh');
    const response = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(response.body.academyId).toBe(academy.id);
    expect(response.body.subdomain).toBeUndefined();
    expect(response.body.customDomain).toBeUndefined();
    expect(response.body.ssl).toEqual({ status: 'not_configured' });
    expect(response.body.cdn).toEqual({ status: 'not_configured' });
  });

  it('adding a custom domain creates a real domain_connections row in verification_required status — never fabricated "connected"', async () => {
    const { owner, academy } = await seedManagedAcademy('domain-add');
    const hostname = `add-${Date.now()}.example.com`;

    const response = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ hostname })
      .expect(201);

    expect(response.body.customDomain.hostname).toBe(hostname);
    expect(response.body.customDomain.status).toBe('verification_required');
    expect(response.body.customDomain.status).not.toBe('connected');

    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.hostname).toBe(hostname);
    expect(row.status).toBe('verification_required');
  });

  it('normalizes hostname casing/whitespace on add', async () => {
    const { owner, academy } = await seedManagedAcademy('domain-normalize');
    const response = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ hostname: `  Normalize-${Date.now()}.EXAMPLE.com  ` })
      .expect(201);

    expect(response.body.customDomain.hostname).toBe(
      response.body.customDomain.hostname.toLowerCase(),
    );
  });

  it('rejects a malformed hostname (URL-shaped, path, or invalid label)', async () => {
    const { owner, academy } = await seedManagedAcademy('domain-invalid');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ hostname: 'https://example.com/path' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ hostname: 'not a hostname' })
      .expect(400);
  });

  it('rejects a hostname already connected to a different Academy', async () => {
    const { owner: ownerA, academy: academyA } =
      await seedManagedAcademy('domain-taken-a');
    const { owner: ownerB, academy: academyB } =
      await seedManagedAcademy('domain-taken-b');
    const hostname = `taken-${Date.now()}.example.com`;

    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ hostname })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/academies/${academyB.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ hostname })
      .expect(409);
  });

  it('verifyDomain with no domain configured returns 404', async () => {
    const { owner, academy } = await seedManagedAcademy('domain-verify-none');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/verify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('verifyDomain with no real Cloudflare credentials leaves the row unchanged — never simulates success', async () => {
    const { owner, academy } = await seedManagedAcademy('domain-verify-noop');
    const hostname = `verify-${Date.now()}.example.com`;
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ hostname })
      .expect(201);

    const verified = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/verify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    expect(verified.body.customDomain.status).toBe('verification_required');
    expect(verified.body.customDomain.status).not.toBe('connected');
  });

  it('removeCustomDomain resets the row rather than deleting it', async () => {
    const { owner, academy } = await seedManagedAcademy('domain-remove');
    const hostname = `remove-${Date.now()}.example.com`;
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ hostname })
      .expect(201);

    const removed = await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(removed.body.customDomain).toBeUndefined();

    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.status).toBe('not_configured');
    expect(row.hostname).toBeNull();
  });

  it('a plain org member (no academy role) can read domain configuration but cannot write it', async () => {
    const { academy, org } = await seedManagedAcademy('domain-authz');
    const plainMember = await signUpAndSignIn(app, 'domain-authz-member');
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: plainMember.userId, role: 'member' },
    });

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/domain`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .send({ hostname: `authz-${Date.now()}.example.com` })
      .expect(403);
  });

  describe('Platform domain configuration', () => {
    it('any authenticated user can read the platform domain configuration', async () => {
      const { owner } = await seedManagedAcademy('pdom-read');
      const response = await request(app.getHttpServer())
        .get('/platform-domain')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(typeof response.body.configured).toBe('boolean');
    });

    it('a non-platform-owner cannot update the platform domain configuration', async () => {
      const { owner } = await seedManagedAcademy('pdom-write-403');
      await request(app.getHttpServer())
        .patch('/platform-domain')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ baseDomain: 'atlas-test.dev' })
        .expect(403);
    });

    it('a platform owner can update the platform domain configuration', async () => {
      const owner = await signUpAndSignIn(app, 'pdom-owner');
      await admin.user.update({
        where: { id: owner.userId },
        data: { isPlatformOwner: true },
      });

      const response = await request(app.getHttpServer())
        .patch('/platform-domain')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ baseDomain: `atlas-test-${Date.now()}.dev` })
        .expect(200);
      expect(response.body.configured).toBe(true);
      expect(response.body.baseDomain).toEqual(expect.any(String));
    });
  });

  describe('Infrastructure provider status', () => {
    it('reports connected: false with no real Cloudflare credentials configured', async () => {
      const { owner } = await seedManagedAcademy('infra-status');
      const response = await request(app.getHttpServer())
        .get('/infrastructure/cloudflare/status')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(response.body).toEqual({ provider: 'cloudflare', connected: false });
    });

    it('rejects an unknown provider name', async () => {
      const { owner } = await seedManagedAcademy('infra-unknown');
      await request(app.getHttpServer())
        .get('/infrastructure/not-a-real-provider/status')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(400);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .get('/infrastructure/cloudflare/status')
        .expect(401);
    });
  });
});
