/**
 * Website Builder & Theme Engine e2e suite (master plan §21 Phase P9,
 * §10). Exercises `WebsiteController`'s real HTTP surface — configuration
 * get/update/publish, page CRUD, section reorder — including the
 * security-critical server-side section validation and course/page
 * reference checks.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
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

describe('Website Builder & Theme Engine (e2e)', () => {
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

  it('GET configuration lazily bootstraps a draft configuration and the six core pages on first read', async () => {
    const { owner, academy } = await seedManagedAcademy('bootstrap');

    const config = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(config.body).toMatchObject({ academyId: academy.id, status: 'draft' });
    expect(config.body.brand.primaryColor).toEqual(expect.any(String));

    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const coreTypes = pages.body.items
      .filter((p: { pageType: string }) => p.pageType === 'core')
      .map((p: { coreType: string }) => p.coreType)
      .sort();
    expect(coreTypes).toEqual(
      ['about', 'contact', 'courseDetails', 'courses', 'faqs', 'home'].sort(),
    );

    // Idempotent — a second read returns the exact same configuration row, not a fresh one.
    const second = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(second.body.updatedAt).toBe(config.body.updatedAt);
  });

  it('updates brand as a partial merge — unspecified colors are preserved, not reset', async () => {
    const { owner, academy } = await seedManagedAcademy('brand-merge');
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const first = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ brand: { primaryColor: '200 80% 50%' } })
      .expect(200);
    expect(first.body.brand.primaryColor).toBe('200 80% 50%');
    const preservedSecondary = first.body.brand.secondaryColor;

    const second = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ brand: { accentColor: '10 90% 40%' } })
      .expect(200);
    expect(second.body.brand.primaryColor).toBe('200 80% 50%');
    expect(second.body.brand.secondaryColor).toBe(preservedSecondary);
    expect(second.body.brand.accentColor).toBe('10 90% 40%');
  });

  it('rejects an invalid HSL color on brand update', async () => {
    const { owner, academy } = await seedManagedAcademy('brand-invalid');
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ brand: { primaryColor: 'not-a-color' } })
      .expect(400);
  });

  it('rejects an unregistered themeKey', async () => {
    const { owner, academy } = await seedManagedAcademy('theme-invalid');
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ themeKey: 'not-a-real-theme' })
      .expect(400);
  });

  it('navigation referencing a real page id succeeds; referencing a fabricated page id is rejected', async () => {
    const { owner, academy } = await seedManagedAcademy('nav-ref');
    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const homePage = pages.body.items.find(
      (p: { coreType: string }) => p.coreType === 'home',
    );

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        navigation: [{ id: 'nav-1', label: 'Home', pageId: homePage.id, order: 0 }],
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        navigation: [
          { id: 'nav-1', label: 'Home', pageId: 'fabricated-page-id', order: 0 },
        ],
      })
      .expect(400);
  });

  it('publish sets status to published deterministically and records publishedAt', async () => {
    const { owner, academy } = await seedManagedAcademy('publish');
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const published = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(published.body.status).toBe('published');
    expect(published.body.publishedAt).toEqual(expect.any(String));
  });

  it('creates a custom page, rejects a reserved slug, and rejects a duplicate slug', async () => {
    const { owner, academy } = await seedManagedAcademy('page-create');

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Pricing', slug: 'pricing' })
      .expect(201);
    expect(created.body).toMatchObject({
      pageType: 'custom',
      title: 'Pricing',
      slug: 'pricing',
    });
    expect(created.body.coreType).toBeUndefined();

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Home Clone', slug: 'home' })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Pricing Again', slug: 'pricing' })
      .expect(409);
  });

  it('rejects an invalid slug format on page creation', async () => {
    const { owner, academy } = await seedManagedAcademy('page-slug-format');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Bad', slug: 'Not Valid Slug!' })
      .expect(400);
  });

  it('a well-formed sections array persists; a malformed or unregistered section type is rejected server-side', async () => {
    const { owner, academy } = await seedManagedAcademy('sections');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Landing', slug: 'landing' })
      .expect(201);

    const validSections = [
      {
        id: 'sec-1',
        type: 'hero',
        enabled: true,
        visibility: { desktop: true, tablet: true, mobile: true },
        config: { title: 'Welcome to our academy' },
      },
    ];

    const updated = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sections: validSections })
      .expect(200);
    expect(updated.body.sections).toHaveLength(1);
    expect(updated.body.sections[0].config.title).toBe('Welcome to our academy');

    // Unregistered section type.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-x',
            type: 'maliciousInjectedType',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { html: '<script>alert(1)</script>' },
          },
        ],
      })
      .expect(400);

    // Missing required field for a registered type.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-y',
            type: 'hero',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: {},
          },
        ],
      })
      .expect(400);

    // Duplicate section ids within one page.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sections: [...validSections, { ...validSections[0] }] })
      .expect(400);

    // A CTA URL using a disallowed scheme is rejected (stored-XSS boundary).
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-cta',
            type: 'cta',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: {
              title: 'Join now',
              cta: { label: 'Go', url: 'javascript:alert(1)' },
            },
          },
        ],
      })
      .expect(400);
  });

  it('a featuredCourses section referencing a real course in this academy is accepted; a fabricated or cross-academy course id is rejected', async () => {
    const { owner, academy } = await seedManagedAcademy('course-ref');
    const otherAcademySeed = await seedManagedAcademy('course-ref-other');
    const realCourse = await seedCourse(admin, academy.id, 'Intro to Testing');
    const otherAcademyCourse = await seedCourse(
      admin,
      otherAcademySeed.academy.id,
      'Other Academy Course',
    );

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Courses Landing', slug: 'courses-landing' })
      .expect(201);

    const baseSection = (courseIds: string[]) => [
      {
        id: 'sec-fc',
        type: 'featuredCourses',
        enabled: true,
        visibility: { desktop: true, tablet: true, mobile: true },
        config: {
          title: 'Our courses',
          mode: 'selected',
          courseIds,
          layout: 'grid',
          count: 3,
          showPrice: true,
          showInstructor: true,
        },
      },
    ];

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sections: baseSection([realCourse.id]) })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sections: baseSection(['fabricated-course-id']) })
      .expect(400);

    // A real course, but owned by a DIFFERENT academy — must never be
    // accepted, even though the id genuinely exists in the database.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sections: baseSection([otherAcademyCourse.id]) })
      .expect(400);
  });

  it('a faq/testimonials section referencing a real, same-academy CMS library entry is accepted; a fabricated libraryEntryId is rejected (P10)', async () => {
    const { owner, academy } = await seedManagedAcademy('cms-ref');

    const faqEntry = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);
    const testimonialEntry = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/testimonial-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ quote: { en: 'Q', ar: 'س' }, authorName: 'Jane' })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'CMS Ref Page', slug: 'cms-ref-page' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-faq',
            type: 'faq',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { items: [], libraryEntryIds: [faqEntry.body.id] },
          },
          {
            id: 'sec-testimonials',
            type: 'testimonials',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { items: [], libraryEntryIds: [testimonialEntry.body.id] },
          },
        ],
      })
      .expect(200);

    // Draft entries (never published) are still legitimate references —
    // the reference validator never status-gates a library entry.
    const draftFaqEntry = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Draft Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-faq-draft',
            type: 'faq',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { items: [], libraryEntryIds: [draftFaqEntry.body.id] },
          },
        ],
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-faq-bad',
            type: 'faq',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { items: [], libraryEntryIds: ['fabricated-faq-id'] },
          },
        ],
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-testimonials-bad',
            type: 'testimonials',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { items: [], libraryEntryIds: ['fabricated-testimonial-id'] },
          },
        ],
      })
      .expect(400);
  });

  it('reorders sections by the full ordered id list, and rejects a mismatched/partial ordering', async () => {
    const { owner, academy } = await seedManagedAcademy('reorder');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Reorder Page', slug: 'reorder-page' })
      .expect(201);

    const sections = [
      {
        id: 'a',
        type: 'about',
        enabled: true,
        visibility: { desktop: true, tablet: true, mobile: true },
        config: { title: 'About', body: 'Body text' },
      },
      {
        id: 'b',
        type: 'contact',
        enabled: true,
        visibility: { desktop: true, tablet: true, mobile: true },
        config: { showForm: true },
      },
    ];
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sections })
      .expect(200);

    const reordered = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${created.body.id}/sections/reorder`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ orderedIds: ['b', 'a'] })
      .expect(201);
    expect(reordered.body.sections.map((s: { id: string }) => s.id)).toEqual(['b', 'a']);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${created.body.id}/sections/reorder`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ orderedIds: ['a'] })
      .expect(409);
  });

  it('a custom page can be deleted; a core page cannot', async () => {
    const { owner, academy } = await seedManagedAcademy('delete');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Temp', slug: 'temp' })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const homePage = pages.body.items.find(
      (p: { coreType: string }) => p.coreType === 'home',
    );

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/pages/${homePage.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });

  it('visibility can be toggled on a toggleable core page, but the courseDetails core page rejects a visibility change', async () => {
    const { owner, academy } = await seedManagedAcademy('visibility');
    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const homePage = pages.body.items.find(
      (p: { coreType: string }) => p.coreType === 'home',
    );
    const courseDetailsPage = pages.body.items.find(
      (p: { coreType: string }) => p.coreType === 'courseDetails',
    );

    const toggled = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${homePage.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visible: false })
      .expect(200);
    expect(toggled.body.visible).toBe(false);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${courseDetailsPage.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visible: false })
      .expect(403);
  });

  it('a plain org member (no academy role) can read the website surface but cannot write to it', async () => {
    const { academy, org } = await seedManagedAcademy('authz');
    const plainMember = await signUpAndSignIn(app, 'website-authz-member');
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: plainMember.userId, role: 'member' },
    });

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .send({ themeKey: 'bold-creative' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .send({ title: 'X', slug: 'x-page' })
      .expect(403);
  });
});
