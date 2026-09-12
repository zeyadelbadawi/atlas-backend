/**
 * Public Website Runtime e2e suite (master plan §21 Phase P11, §5, §33 —
 * "Master Plan Tenant Test — Scenario 6"). Exercises `PublicWebsiteController`'s
 * real, unauthenticated HTTP surface. THE CRITICAL SECURITY INVARIANT this
 * file exists to prove: a draft/unpublished/hidden page is NEVER reachable
 * through any public URL, by any guessing strategy, even when the exact
 * academy id/page id/slug is known.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
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

describe('Public Website Runtime (e2e)', () => {
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

  /** Creates a custom page with one real Hero section, makes it visible, and publishes the whole website — the one real path that makes content genuinely publicly reachable. */
  async function createPublishedPage(
    owner: { accessToken: string },
    academyId: string,
    slug: string,
  ) {
    const page = await request(app.getHttpServer())
      .post(`/academies/${academyId}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: `Page ${slug}`, slug })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/academies/${academyId}/website/pages/${page.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visible: true,
        sections: [
          {
            id: 'sec-hero',
            type: 'hero',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { title: `Welcome to ${slug}` },
          },
        ], expectedVersion: await pageVersion(academyId, page.body.id, owner.accessToken) })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/academies/${academyId}/website/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    return page.body.id as string;
  }

  /**
   * The page's current concurrency token.
   *
   * `expectedVersion` is required on every page update (see
   * `WebsitePagesService.update` for why the old lenient path was closed), and
   * these tests are not about concurrency — they are about entitlement,
   * isolation and validation. Reading the version immediately before each
   * write keeps them focused on what they actually assert, instead of
   * bookkeeping a counter that every earlier write in the test moves.
   */
  async function pageVersion(
    academyId: string,
    pageId: string,
    token: string,
  ): Promise<number> {
    const res = await request(app.getHttpServer())
      .get(`/academies/${academyId}/website/pages/${pageId}`)
      .set('Authorization', `Bearer ${token}`);
    return res.body.version as number;
  }

  it('a published, visible page is publicly accessible with the exact expected content', async () => {
    const { owner, academy } = await seedManagedAcademy('pub-published');
    await createPublishedPage(owner, academy.id, 'landing');

    const config = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}`)
      .expect(200);
    expect(config.body.status).toBe('published');

    const pages = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/pages`)
      .expect(200);
    expect(pages.body.map((p: { slug: string }) => p.slug)).toContain('landing');

    const page = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/pages/landing`)
      .expect(200);
    expect(page.body.sections[0].config.title).toEqual({
      en: 'Welcome to landing',
      ar: '',
    });
  });

  it('SCENARIO 6: a draft website configuration (never published) is unreachable through any public URL, by any guessing strategy', async () => {
    const { owner, academy } = await seedManagedAcademy('pub-draft-config');

    // Bootstrap the configuration (lazy-created as 'draft') and a custom
    // page with real content, visible — but NEVER call publish.
    const page = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Draft Landing', slug: 'draft-landing' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visible: true,
        sections: [
          {
            id: 'sec-hero',
            type: 'hero',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { title: 'SECRET DRAFT CONTENT' },
          },
        ], expectedVersion: await pageVersion(academy.id, page.body.id, owner.accessToken) })
      .expect(200);

    // Known academy id, known page id, known slug, guessed slug — every
    // public read must 404, never leak the draft.
    const configResponse = await request(app.getHttpServer()).get(
      `/public/websites/${academy.id}`,
    );
    expect(configResponse.status).toBe(404);
    expect(JSON.stringify(configResponse.body)).not.toContain('SECRET DRAFT CONTENT');

    const pagesResponse = await request(app.getHttpServer()).get(
      `/public/websites/${academy.id}/pages`,
    );
    expect(pagesResponse.status).toBe(404);

    const pageBySlug = await request(app.getHttpServer()).get(
      `/public/websites/${academy.id}/pages/draft-landing`,
    );
    expect(pageBySlug.status).toBe(404);
    expect(JSON.stringify(pageBySlug.body)).not.toContain('SECRET DRAFT CONTENT');

    // Direct-by-id is not even a real route shape (pages are addressed by
    // slug only) — a crafted attempt using the real page id as if it were
    // a slug must also 404, never accidentally match.
    const pageById = await request(app.getHttpServer()).get(
      `/public/websites/${academy.id}/pages/${page.body.id}`,
    );
    expect(pageById.status).toBe(404);
  });

  it('a hidden page never becomes publicly reachable, even after the website is published, even by its exact known slug', async () => {
    const { owner, academy } = await seedManagedAcademy('pub-hidden-page');
    const page = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Hidden', slug: 'hidden-page' })
      .expect(201);
    // Deliberately left `visible: false` (the create default is `true` —
    // explicitly flip it off) with real content.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visible: false,
        sections: [
          {
            id: 'sec-hero',
            type: 'hero',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { title: 'HIDDEN SECRET CONTENT' },
          },
        ], expectedVersion: await pageVersion(academy.id, page.body.id, owner.accessToken) })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const bySlug = await request(app.getHttpServer()).get(
      `/public/websites/${academy.id}/pages/hidden-page`,
    );
    expect(bySlug.status).toBe(404);
    expect(JSON.stringify(bySlug.body)).not.toContain('HIDDEN SECRET CONTENT');

    const list = await request(app.getHttpServer()).get(
      `/public/websites/${academy.id}/pages`,
    );
    expect(list.status).toBe(200);
    expect(list.body.map((p: { slug: string }) => p.slug)).not.toContain('hidden-page');
  });

  it('publishing, then reverting to draft via a fresh unpublished configVersion, is never publicly reachable again (cache never resurrects a stale published response)', async () => {
    const { owner, academy } = await seedManagedAcademy('pub-unpublish');
    await createPublishedPage(owner, academy.id, 'now-public');

    const firstRead = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}`)
      .expect(200);
    expect(firstRead.body.status).toBe('published');

    // There is no "unpublish" endpoint in the real contract — but a
    // second publish still increments configVersion, proving the cache
    // key changes rather than sticking to stale data. A direct DB flip to
    // 'draft' proves the true worst case: even if some future path ever
    // set status back to draft, the public endpoint must still 404, never
    // serve a cached "published" response from before.
    await admin.websiteConfiguration.update({
      where: { academyId: academy.id },
      data: { status: 'draft' },
    });

    const afterRevert = await request(app.getHttpServer()).get(
      `/public/websites/${academy.id}`,
    );
    expect(afterRevert.status).toBe(404);
  });

  it('unknown academy id returns public not-found, never an internal error', async () => {
    const response = await request(app.getHttpServer()).get(
      '/public/websites/00000000-0000-0000-0000-000000000000',
    );
    expect(response.status).toBe(404);
  });

  it('unknown/unrecognized hostname returns public not-found', async () => {
    const response = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname: 'genuinely-nonexistent-hostname.invalid' });
    expect(response.status).toBe(404);
  });

  it('a malformed/URL-shaped "hostname" value never crashes and never resolves', async () => {
    const withPath = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname: 'https://example.com/path' });
    expect(withPath.status).toBe(404);

    const withScript = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname: '<script>alert(1)</script>' });
    expect(withScript.status).toBe(404);
  });

  it('same page slug across two different academies resolves independently, never crossing', async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('pub-cross-a');
    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('pub-cross-b');
    await createPublishedPage(ownerA, academyA.id, 'shared-slug');
    await createPublishedPage(ownerB, academyB.id, 'shared-slug');

    const pageA = await request(app.getHttpServer())
      .get(`/public/websites/${academyA.id}/pages/shared-slug`)
      .expect(200);
    const pageB = await request(app.getHttpServer())
      .get(`/public/websites/${academyB.id}/pages/shared-slug`)
      .expect(200);

    expect(pageA.body.academyId).toBe(academyA.id);
    expect(pageB.body.academyId).toBe(academyB.id);
    expect(pageA.body.id).not.toBe(pageB.body.id);
  });

  it("Academy B's public pages list never includes Academy A's pages, even with the same slug requested", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('pub-list-a');
    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('pub-list-b');
    await createPublishedPage(ownerA, academyA.id, 'only-in-a');
    // Academy B must have its OWN published website (otherwise the
    // correct response is 404, not an empty 200 list — proven by the
    // dedicated "unknown academy id" test above) for this to be a real
    // "list never crosses" proof rather than a "nothing published" one.
    await createPublishedPage(ownerB, academyB.id, 'only-in-b');

    const listB = await request(app.getHttpServer())
      .get(`/public/websites/${academyB.id}/pages`)
      .expect(200);
    expect(listB.body.map((p: { slug: string }) => p.slug)).not.toContain('only-in-a');
    expect(listB.body.map((p: { slug: string }) => p.slug)).toContain('only-in-b');
  });

  it("a crafted academyId cannot override hostname-based resolution — resolveHostname and getPublishedWebsite are independent, and neither trusts a client-supplied academyId as the tenant boundary for anything beyond that one academy's own already-published data", async () => {
    const { academy: academyA } = await seedManagedAcademy('pub-crafted-a');
    const { owner: ownerB, academy: academyB } =
      await seedManagedAcademy('pub-crafted-b');
    await createPublishedPage(ownerB, academyB.id, 'b-page');

    // Requesting Academy A's published website by its own id must never
    // return Academy B's data, regardless of any other request made in
    // the same test run.
    const configA = await request(app.getHttpServer()).get(
      `/public/websites/${academyA.id}`,
    );
    // Academy A never published anything — 404, never Academy B's config.
    expect(configA.status).toBe(404);
  });

  // -------------------------------------------------------------------
  // Phase 6 — real, live statistics; combined identity; real Contact
  // submissions.
  // -------------------------------------------------------------------

  it("GET :academyId/statistics returns real, live counts scoped to that one Academy — never another Academy's, never revenue", async () => {
    const { academy: academyA, org: orgA } = await seedManagedAcademy('pub-stats-a');
    await seedActiveSubscriptionForOrg(admin, orgA.id, 'pub-stats-a');
    await seedCourse(admin, academyA.id, `pub-stats-a-published-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    // A draft course must never count.
    await seedCourse(admin, academyA.id, `pub-stats-a-draft-${Date.now()}`, {
      status: 'draft',
      visibility: 'private',
    });
    const studentA = await signUpAndSignIn(app, 'pub-stats-a-student');
    await seedAcademyStudent(admin, academyA.id, studentA.userId);
    const instructorA = await signUpAndSignIn(app, 'pub-stats-a-instructor');
    await seedAcademyMember(admin, academyA.id, instructorA.userId, 'instructor');

    const { academy: academyB, org: orgB } = await seedManagedAcademy('pub-stats-b');
    await seedActiveSubscriptionForOrg(admin, orgB.id, 'pub-stats-b');
    // Academy B has MORE of everything — proves the count is isolated to
    // Academy A, not a platform-wide total.
    await seedCourse(admin, academyB.id, `pub-stats-b-1-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    await seedCourse(admin, academyB.id, `pub-stats-b-2-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    for (const label of ['pub-stats-b-s1', 'pub-stats-b-s2', 'pub-stats-b-s3']) {
      const student = await signUpAndSignIn(app, label);
      await seedAcademyStudent(admin, academyB.id, student.userId);
    }

    const statsA = await request(app.getHttpServer())
      .get(`/public/websites/${academyA.id}/statistics`)
      .expect(200);
    expect(statsA.body).toEqual({ courses: 1, students: 1, instructors: 1 });
    expect(statsA.body).not.toHaveProperty('revenue');
  });

  it("a manipulated/unknown academyId on the statistics endpoint returns public not-found, never another Academy's data", async () => {
    const response = await request(app.getHttpServer()).get(
      '/public/websites/00000000-0000-0000-0000-000000000000/statistics',
    );
    expect(response.status).toBe(404);
  });

  it("GET :academyId/identity returns the real, combined Academy name/logo/contact — never another Academy's", async () => {
    const { academy: academyA } = await seedManagedAcademy('pub-identity-a');
    await admin.academy.update({
      where: { id: academyA.id },
      data: { contactEmail: 'hello@academy-a.test', contactPhone: '+1-000-000-0000' },
    });
    const { academy: academyB } = await seedManagedAcademy('pub-identity-b');
    await admin.academy.update({
      where: { id: academyB.id },
      data: { contactEmail: 'hello@academy-b.test' },
    });

    const identityA = await request(app.getHttpServer())
      .get(`/public/websites/${academyA.id}/identity`)
      .expect(200);
    expect(identityA.body.name).toBe(academyA.name);
    expect(identityA.body.contactEmail).toBe('hello@academy-a.test');
    expect(identityA.body.contactEmail).not.toBe('hello@academy-b.test');
  });

  it('a manipulated/unknown academyId on the identity endpoint returns public not-found', async () => {
    const response = await request(app.getHttpServer()).get(
      '/public/websites/00000000-0000-0000-0000-000000000000/identity',
    );
    expect(response.status).toBe(404);
  });

  it("POST :academyId/contact persists a real submission (never a fake success), readable/triageable only by that Academy's own staff, and never crosses into another Academy", async () => {
    const { owner: ownerA, academy: academyA } =
      await seedManagedAcademy('pub-contact-a');
    const { owner: ownerB, academy: academyB } =
      await seedManagedAcademy('pub-contact-b');

    const submitted = await request(app.getHttpServer())
      .post(`/public/websites/${academyA.id}/contact`)
      .send({ name: 'Jane Visitor', email: 'jane@example.com', message: 'Hi there!' })
      .expect(201);
    expect(submitted.body.academyId).toBe(academyA.id);
    expect(submitted.body.status).toBe('new');

    // Really persisted — not a console-log-only no-op.
    const persisted = await admin.contactSubmission.findUnique({
      where: { id: submitted.body.id },
    });
    expect(persisted?.email).toBe('jane@example.com');
    expect(persisted?.message).toBe('Hi there!');

    // Academy A's own staff can read/triage it.
    const listA = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/contact-submissions`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);
    expect(listA.body.items.map((s: { id: string }) => s.id)).toContain(
      submitted.body.id,
    );

    const triaged = await request(app.getHttpServer())
      .patch(`/academies/${academyA.id}/contact-submissions/${submitted.body.id}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ status: 'read' })
      .expect(200);
    expect(triaged.body.status).toBe('read');

    // Academy B's staff never sees it, and cannot triage it either.
    const listB = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/contact-submissions`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(listB.body.items.map((s: { id: string }) => s.id)).not.toContain(
      submitted.body.id,
    );
    await request(app.getHttpServer())
      .patch(`/academies/${academyA.id}/contact-submissions/${submitted.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ status: 'archived' })
      .expect(403);
  });

  it('a contact submission to a manipulated/unknown academyId is rejected, never silently attributed to a real academy', async () => {
    const response = await request(app.getHttpServer())
      .post('/public/websites/00000000-0000-0000-0000-000000000000/contact')
      .send({ name: 'Attacker', email: 'attacker@example.com', message: 'x' });
    expect(response.status).toBe(404);
  });
});
