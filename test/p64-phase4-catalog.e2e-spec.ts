/**
 * P64 Phase 4 — Public Catalog v2 e2e suite.
 *
 * Exercises the new public catalog filters wired through
 * `GET /public/websites/:academyId/courses` →
 * `PublicWebsiteService.getPublicCourses` → `CoursesRepository.findManyPublished`:
 *   - full-text-ish search that now spans title / shortDescription / description
 *   - `level` and `language` filters
 *   - `priceMin` / `priceMax` money-range filter (minor units, BigInt-safe)
 *   - `ids` (mode:'selected') bounded fetch for Featured blocks
 *   - the catalog metadata fields now returned on each course
 *
 * The invariant inherited from the P11 public suite still holds here: only
 * published + public courses of THIS academy are ever served. Each assertion
 * seeds a decoy (draft / private / other-academy) to prove scoping.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseCategory,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { uniqueTestEmail } from './utils/test-app';
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

describe('Public Catalog v2 (e2e)', () => {
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

  /** A serving-eligible academy (active subscription) whose public catalog is reachable. */
  async function seedServingAcademy(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    return { owner, org, academy };
  }

  function courses(academyId: string, queryString = '') {
    const suffix = queryString ? `?${queryString}` : '';
    return request(app.getHttpServer()).get(
      `/public/websites/${academyId}/courses${suffix}`,
    );
  }

  it('returns the catalog metadata fields (level, language, outcomes, requirements) on each published course', async () => {
    const { academy } = await seedServingAcademy('cat-meta');
    const stamp = Date.now();
    await seedCourse(admin, academy.id, `Meta Rich ${stamp}`, {
      status: 'published',
      visibility: 'public',
      level: 'intermediate',
      language: 'en',
      outcomes: ['Build APIs', 'Ship to prod'],
      requirements: ['Basic JS'],
      shortDescription: 'A rich course',
    });

    const res = await courses(academy.id).expect(200);
    expect(res.body.items).toHaveLength(1);
    const [course] = res.body.items;
    expect(course.level).toBe('intermediate');
    expect(course.language).toBe('en');
    expect(course.outcomes).toEqual(['Build APIs', 'Ship to prod']);
    expect(course.requirements).toEqual(['Basic JS']);
  });

  it('search spans the long description, not just the title', async () => {
    const { academy } = await seedServingAcademy('cat-search');
    const stamp = Date.now();
    // Title has no match; only the description carries the term.
    await seedCourse(admin, academy.id, `Alpha ${stamp}`, {
      status: 'published',
      visibility: 'public',
      description: 'This module covers kubernetes autoscaling in depth.',
    });
    await seedCourse(admin, academy.id, `Beta ${stamp}`, {
      status: 'published',
      visibility: 'public',
      description: 'A gentle intro to spreadsheets.',
    });

    const res = await courses(academy.id, 'search=kubernetes').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe(`Alpha ${stamp}`);
  });

  it('filters by level', async () => {
    const { academy } = await seedServingAcademy('cat-level');
    const stamp = Date.now();
    await seedCourse(admin, academy.id, `Begin ${stamp}`, {
      status: 'published',
      visibility: 'public',
      level: 'beginner',
    });
    await seedCourse(admin, academy.id, `Adv ${stamp}`, {
      status: 'published',
      visibility: 'public',
      level: 'advanced',
    });

    const res = await courses(academy.id, 'level=advanced').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe(`Adv ${stamp}`);
    expect(res.body.items[0].level).toBe('advanced');
  });

  it('filters by language', async () => {
    const { academy } = await seedServingAcademy('cat-lang');
    const stamp = Date.now();
    await seedCourse(admin, academy.id, `English ${stamp}`, {
      status: 'published',
      visibility: 'public',
      language: 'en',
    });
    await seedCourse(admin, academy.id, `Arabic ${stamp}`, {
      status: 'published',
      visibility: 'public',
      language: 'ar',
    });

    const res = await courses(academy.id, 'language=ar').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe(`Arabic ${stamp}`);
  });

  it('filters by price range (minor units, BigInt-safe)', async () => {
    const { academy } = await seedServingAcademy('cat-price');
    const stamp = Date.now();
    await seedCourse(admin, academy.id, `Cheap ${stamp}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 1000n, // 10.00
      pricingCurrency: 'USD',
    });
    await seedCourse(admin, academy.id, `Mid ${stamp}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 5000n, // 50.00
      pricingCurrency: 'USD',
    });
    await seedCourse(admin, academy.id, `Pricey ${stamp}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 20000n, // 200.00
      pricingCurrency: 'USD',
    });

    const res = await courses(academy.id, 'priceMin=2000&priceMax=10000').expect(200);
    const titles = res.body.items.map((c: { title: string }) => c.title).sort();
    expect(titles).toEqual([`Mid ${stamp}`]);
  });

  it('sorts by price ascending', async () => {
    const { academy } = await seedServingAcademy('cat-sort');
    const stamp = Date.now();
    await seedCourse(admin, academy.id, `High ${stamp}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 9000n,
      pricingCurrency: 'USD',
    });
    await seedCourse(admin, academy.id, `Low ${stamp}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 1000n,
      pricingCurrency: 'USD',
    });

    const res = await courses(academy.id, 'sortBy=price&sortDirection=asc').expect(200);
    const titles = res.body.items.map((c: { title: string }) => c.title);
    expect(titles).toEqual([`Low ${stamp}`, `High ${stamp}`]);
  });

  it('fetches exactly the requested ids (mode:selected), still scoped to published+public', async () => {
    const { academy } = await seedServingAcademy('cat-ids');
    const stamp = Date.now();
    const a = await seedCourse(admin, academy.id, `Pick A ${stamp}`, {
      status: 'published',
      visibility: 'public',
    });
    const b = await seedCourse(admin, academy.id, `Pick B ${stamp}`, {
      status: 'published',
      visibility: 'public',
    });
    // A draft with a known id must NEVER be returned even when explicitly requested.
    const draft = await seedCourse(admin, academy.id, `Draft ${stamp}`, {
      status: 'draft',
      visibility: 'private',
    });
    await seedCourse(admin, academy.id, `Not Requested ${stamp}`, {
      status: 'published',
      visibility: 'public',
    });

    const res = await courses(academy.id, `ids=${a.id},${draft.id},${b.id}`).expect(200);
    const ids = res.body.items.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("never serves draft, private, or another academy's courses", async () => {
    const { academy } = await seedServingAcademy('cat-scope-a');
    const stamp = Date.now();
    await seedCourse(admin, academy.id, `Public ${stamp}`, {
      status: 'published',
      visibility: 'public',
    });
    await seedCourse(admin, academy.id, `Draft ${stamp}`, {
      status: 'draft',
      visibility: 'public',
    });
    await seedCourse(admin, academy.id, `Private ${stamp}`, {
      status: 'published',
      visibility: 'private',
    });

    const { academy: other } = await seedServingAcademy('cat-scope-b');
    await seedCourse(admin, other.id, `Other ${stamp}`, {
      status: 'published',
      visibility: 'public',
    });

    const res = await courses(academy.id).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe(`Public ${stamp}`);
  });

  // ---- recommendations ----

  it('recommends same-academy courses, same category first, excluding the course itself', async () => {
    const { academy } = await seedServingAcademy('cat-recs');
    const stamp = Date.now();
    const cat = await seedCourseCategory(admin, academy.id, `recs-cat-${stamp}`);
    const source = await seedCourse(admin, academy.id, `Source ${stamp}`, {
      status: 'published',
      visibility: 'public',
      categoryId: cat.id,
    });
    const sameCat = await seedCourse(admin, academy.id, `SameCat ${stamp}`, {
      status: 'published',
      visibility: 'public',
      categoryId: cat.id,
    });
    const otherCat = await seedCourse(admin, academy.id, `OtherCat ${stamp}`, {
      status: 'published',
      visibility: 'public',
    });
    // A draft must never be recommended.
    await seedCourse(admin, academy.id, `DraftRec ${stamp}`, {
      status: 'draft',
      visibility: 'public',
    });

    const res = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${source.id}/recommendations`)
      .expect(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(source.id); // never itself
    expect(ids).toContain(sameCat.id);
    expect(ids).toContain(otherCat.id);
    expect(ids).toHaveLength(2);
    // Same-category course leads.
    expect(ids[0]).toBe(sameCat.id);
  });

  it('recommendations for a draft/unknown course return 404', async () => {
    const { academy } = await seedServingAcademy('cat-recs-hidden');
    const stamp = Date.now();
    const draft = await seedCourse(admin, academy.id, `Hidden ${stamp}`, {
      status: 'draft',
      visibility: 'public',
    });
    await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${draft.id}/recommendations`)
      .expect(404);
    await request(app.getHttpServer())
      .get(
        `/public/websites/${academy.id}/courses/00000000-0000-0000-0000-000000000000/recommendations`,
      )
      .expect(404);
  });

  it('P64 Phase 4 — a catalog card can say duration, preview and rating without a second request', async () => {
    // Published lessons only for duration and preview — a draft preview is
    // not something a visitor can open, so it must not earn the badge —
    // and approved reviews only for the rating, so the card never disagrees
    // with the details page's own rating endpoint.
    const owner = await signUpAndSignIn(app, 'cat-agg-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'cat-agg-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'cat-agg');
    const academy = await seedAcademy(admin, org.id, 'cat-agg-academy');
    const course = await seedCourse(admin, academy.id, 'Aggregates Course', {
      status: 'published',
      visibility: 'public',
    });
    const section = await seedCourseSection(admin, course.id, 'S', 0);
    const l1 = await seedCourseLesson(admin, section.id, course.id, 'L1', 0, {
      status: 'published',
    });
    const l2 = await seedCourseLesson(admin, section.id, course.id, 'L2', 1, {
      status: 'published',
    });
    const draft = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      'Draft preview',
      2,
      {
        status: 'draft',
      },
    );
    await admin.courseLesson.update({
      where: { id: l1.id },
      data: { durationSeconds: 300 },
    });
    await admin.courseLesson.update({
      where: { id: l2.id },
      data: { durationSeconds: 120 },
    });
    await admin.courseLesson.update({
      where: { id: draft.id },
      data: { isPreview: true, durationSeconds: 999 },
    });

    const a = await signUpAndSignIn(app, 'cat-agg-a');
    const b = await signUpAndSignIn(app, 'cat-agg-b');
    for (const [u, rating, status] of [
      [a, 5, 'approved'],
      [b, 3, 'approved'],
    ] as const) {
      await seedAcademyStudent(admin, academy.id, u.userId);
      await seedEnrollment(admin, u.userId, course.id, academy.id, {
        status: 'enrolled',
      });
      await admin.courseReview.create({
        data: {
          courseId: course.id,
          academyId: academy.id,
          studentId: u.userId,
          rating,
          status,
        },
      });
    }
    const c = await signUpAndSignIn(app, 'cat-agg-c');
    await seedAcademyStudent(admin, academy.id, c.userId);
    await seedEnrollment(admin, c.userId, course.id, academy.id, { status: 'enrolled' });
    await admin.courseReview.create({
      data: {
        courseId: course.id,
        academyId: academy.id,
        studentId: c.userId,
        rating: 1,
        status: 'pending',
      },
    });

    const list = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses`)
      .expect(200);
    const item = list.body.items.find((x: { id: string }) => x.id === course.id);
    expect(item.stats.durationSeconds).toBe(420);
    expect(item.stats.hasPreview).toBe(false);
    expect(item.stats.averageRating).toBe(4);
    expect(item.stats.totalReviews).toBe(2);

    // Publishing the preview lesson earns the badge — and only then.
    await admin.courseLesson.update({
      where: { id: draft.id },
      data: { status: 'published' },
    });
    const details = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}`)
      .expect(200);
    expect(details.body.stats.hasPreview).toBe(true);
    expect(details.body.stats.durationSeconds).toBe(1419);
    expect(details.body.stats.averageRating).toBe(4);
  });
});
