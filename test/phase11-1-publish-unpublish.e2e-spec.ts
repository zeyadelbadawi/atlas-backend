/**
 * Phase 11.1 — Website publish / unpublish (P111-PUB-001..014).
 *
 * WHAT THESE ACTUALLY ASSERT. The requirement is that the button reflects
 * the REAL persisted state, so the tests assert on the persisted column
 * and on what the PUBLIC runtime does — never on a response field that a
 * frontend toggle could have invented.
 *
 * `WebsiteConfigurationRepository`'s public read filters on
 * `status: 'published'` inside the WHERE clause, so "unpublished" is not a
 * cosmetic flag: it is precisely the thing that stops the public site
 * resolving. P111-PUB-004 and -005 pin that end to end.
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

const PASSWORD = 'correct-horse-battery';

async function signUpAndSignIn(app: INestApplication, label: string) {
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
    userId: signIn.body.user.id as string,
    accessToken: signIn.body.accessToken as string,
  };
}

describe('Phase 11.1 website publish/unpublish (e2e) — P111-PUB-001..014', () => {
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

  const publish = (academyId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/academies/${academyId}/website/publish`)
      .set('Authorization', `Bearer ${token}`);

  const unpublish = (academyId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/academies/${academyId}/website/unpublish`)
      .set('Authorization', `Bearer ${token}`);

  const getConfig = (academyId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/academies/${academyId}/website/configuration`)
      .set('Authorization', `Bearer ${token}`);

  it('P111-PUB-001 — a new website starts unpublished', async () => {
    const { owner, academy } = await seedManagedAcademy('p111-001');

    const config = await getConfig(academy.id, owner.accessToken).expect(200);

    expect(config.body.status).toBe('draft');
    // Never published, so there is no timestamp to show. The UI uses this
    // to tell "not published yet" from "taken offline".
    expect(config.body.publishedAt).toBeUndefined();
  });

  it('P111-PUB-002 — publishing persists the published state', async () => {
    const { owner, academy } = await seedManagedAcademy('p111-002');

    const response = await publish(academy.id, owner.accessToken).expect(201);
    expect(response.body.status).toBe('published');

    // The persisted column, not the response echo.
    const stored = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(stored.status).toBe('published');
    expect(stored.publishedAt).toBeInstanceOf(Date);
  });

  it('P111-PUB-003 — unpublishing persists the unpublished state', async () => {
    const { owner, academy } = await seedManagedAcademy('p111-003');
    await publish(academy.id, owner.accessToken).expect(201);

    const response = await unpublish(academy.id, owner.accessToken).expect(201);
    expect(response.body.status).toBe('draft');

    const stored = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(stored.status).toBe('draft');
    // Kept: it records when the site was last published, which stays true.
    expect(stored.publishedAt).toBeInstanceOf(Date);
  });

  it('P111-PUB-004 — publishing actually puts the public website online', async () => {
    const { owner, academy } = await seedManagedAcademy('p111-004');

    // Unpublished: the public runtime refuses it.
    await request(app.getHttpServer()).get(`/public/websites/${academy.id}`).expect(404);

    await publish(academy.id, owner.accessToken).expect(201);

    await request(app.getHttpServer()).get(`/public/websites/${academy.id}`).expect(200);
  });

  it('P111-PUB-005 — unpublishing actually takes the public website offline', async () => {
    // The headline requirement: this is not a cosmetic flag.
    const { owner, academy } = await seedManagedAcademy('p111-005');
    await publish(academy.id, owner.accessToken).expect(201);
    await request(app.getHttpServer()).get(`/public/websites/${academy.id}`).expect(200);

    await unpublish(academy.id, owner.accessToken).expect(201);

    await request(app.getHttpServer()).get(`/public/websites/${academy.id}`).expect(404);
  });

  it('P111-PUB-006 — the state survives a re-read, so a refresh shows the truth', async () => {
    // "Refreshing the page must preserve the correct state" — the frontend
    // re-reads the configuration, so this is exactly that path.
    const { owner, academy } = await seedManagedAcademy('p111-006');

    await publish(academy.id, owner.accessToken).expect(201);
    expect((await getConfig(academy.id, owner.accessToken).expect(200)).body.status).toBe(
      'published',
    );

    await unpublish(academy.id, owner.accessToken).expect(201);
    expect((await getConfig(academy.id, owner.accessToken).expect(200)).body.status).toBe(
      'draft',
    );
  });

  it('P111-PUB-007 — publish and unpublish round-trip repeatedly without drift', async () => {
    const { owner, academy } = await seedManagedAcademy('p111-007');

    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect((await publish(academy.id, owner.accessToken).expect(201)).body.status).toBe(
        'published',
      );
      expect(
        (await unpublish(academy.id, owner.accessToken).expect(201)).body.status,
      ).toBe('draft');
    }

    const stored = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(stored.status).toBe('draft');
  });

  it('P111-PUB-008 — repeating the same action is idempotent, not an error', async () => {
    // A double-submit must not produce a 409 or a broken state.
    const { owner, academy } = await seedManagedAcademy('p111-008');

    await publish(academy.id, owner.accessToken).expect(201);
    await publish(academy.id, owner.accessToken).expect(201);
    expect(
      (
        await admin.websiteConfiguration.findUniqueOrThrow({
          where: { academyId: academy.id },
        })
      ).status,
    ).toBe('published');

    await unpublish(academy.id, owner.accessToken).expect(201);
    await unpublish(academy.id, owner.accessToken).expect(201);
    expect(
      (
        await admin.websiteConfiguration.findUniqueOrThrow({
          where: { academyId: academy.id },
        })
      ).status,
    ).toBe('draft');
  });

  it('P111-PUB-009 — concurrent publish requests leave one coherent state', async () => {
    const { owner, academy } = await seedManagedAcademy('p111-009');

    await Promise.all([
      publish(academy.id, owner.accessToken),
      publish(academy.id, owner.accessToken),
      publish(academy.id, owner.accessToken),
    ]);

    const stored = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(stored.status).toBe('published');
  });

  // ---------------- authorization ----------------

  it('P111-PUB-010 — an unauthenticated caller cannot publish or unpublish', async () => {
    const { academy } = await seedManagedAcademy('p111-010');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/publish`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/unpublish`)
      .expect(401);
  });

  it('P111-PUB-011 — a user from another organization cannot publish or unpublish', async () => {
    const { academy } = await seedManagedAcademy('p111-011');
    const outsider = await signUpAndSignIn(app, 'p111-011-outsider');

    expect([403, 404]).toContain(
      (await publish(academy.id, outsider.accessToken)).status,
    );
    expect([403, 404]).toContain(
      (await unpublish(academy.id, outsider.accessToken)).status,
    );

    const stored = await admin.websiteConfiguration.findUnique({
      where: { academyId: academy.id },
    });
    expect(stored?.status ?? 'draft').toBe('draft');
  });

  it('P111-PUB-012 — an academy member without a managing role cannot publish or unpublish', async () => {
    // Organization membership alone is READ-sufficient; publishing is not.
    const { org, academy } = await seedManagedAcademy('p111-012');
    const instructor = await signUpAndSignIn(app, 'p111-012-instructor');
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: instructor.userId, role: 'instructor' },
    });
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    await publish(academy.id, instructor.accessToken).expect(403);
    await unpublish(academy.id, instructor.accessToken).expect(403);
  });

  it('P111-PUB-013 — unpublish is not a weaker door than publish', async () => {
    // Two routes that change the same thing must enforce the same rule;
    // taking a site OFF the internet must not be the easier operation.
    const { org, academy } = await seedManagedAcademy('p111-013');
    const owner2 = await signUpAndSignIn(app, 'p111-013-member');
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: owner2.userId, role: 'instructor' },
    });
    await seedAcademyMember(admin, academy.id, owner2.userId, 'instructor');

    const publishStatus = (await publish(academy.id, owner2.accessToken)).status;
    const unpublishStatus = (await unpublish(academy.id, owner2.accessToken)).status;
    expect(unpublishStatus).toBe(publishStatus);
  });

  it('P111-PUB-014 — unpublishing one academy never affects another', async () => {
    const first = await seedManagedAcademy('p111-014a');
    const second = await seedManagedAcademy('p111-014b');

    await publish(first.academy.id, first.owner.accessToken).expect(201);
    await publish(second.academy.id, second.owner.accessToken).expect(201);

    await unpublish(first.academy.id, first.owner.accessToken).expect(201);

    await request(app.getHttpServer())
      .get(`/public/websites/${first.academy.id}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/public/websites/${second.academy.id}`)
      .expect(200);
  });
});
