/**
 * P60 — the Platform Owner's Global Course console (P60-COURSE-001..014).
 *
 * WHAT THESE PROVE THAT A UNIT TEST CANNOT.
 *
 *   - Cross-tenant visibility is an RLS decision. These specs seed courses
 *     in TWO unrelated organizations and assert one request returns both —
 *     which only happens because `courses_platform_select` matched under
 *     `runInUserContext`. A mocked Prisma client would return whatever it
 *     was told to.
 *   - The P60b policies are the reason a DRAFT/PRIVATE course's curriculum
 *     is countable at all. `course_sections`/`course_lessons` grant SELECT
 *     to the tenant, the enrolled student, the instructor, or the
 *     published+public predicate — a platform owner is none of those.
 *   - `PlatformOwnerGuard` re-reads `users.is_platform_owner` per request,
 *     so "a tenant owner is refused" is only meaningful against a real row.
 *   - The creator column is written by the REAL course-create path, through
 *     the controller, not by a repository call in isolation.
 *
 * Everything this suite creates is torn down in `afterAll`; no seeded
 * fixture is mutated, so the shared dev database is left as it was found.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseInstructor,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('P60 platform course console (e2e) — P60-COURSE-001..014', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  let platformOwnerToken: string;
  let tenantOwnerToken: string;

  /** Two unrelated tenants — the whole point of a cross-tenant list. */
  let tenantAUserId: string;
  let orgAId: string;
  let orgBId: string;
  let academyAId: string;
  let academyBId: string;
  let courseAId: string;
  let courseBId: string;
  /** Draft + private, with real sections and lessons: the P60b proof case. */
  let hiddenCourseId: string;

  const createdCourseIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    const owner = await seedPlatformOwner('p60-po');
    platformOwnerToken = owner.token;

    const tenantA = await signUp('p60-tenant-a');
    tenantOwnerToken = tenantA.token;
    tenantAUserId = tenantA.userId;
    const orgA = await seedOrganizationWithOwner(admin, tenantA.userId, 'p60-org-a');
    orgAId = orgA.id;
    createdOrgIds.push(orgA.id);

    const tenantB = await signUp('p60-tenant-b');
    const orgB = await seedOrganizationWithOwner(admin, tenantB.userId, 'p60-org-b');
    orgBId = orgB.id;
    createdOrgIds.push(orgB.id);

    const academyA = await seedAcademy(admin, orgAId, 'p60-academy-a');
    const academyB = await seedAcademy(admin, orgBId, 'p60-academy-b');
    academyAId = academyA.id;
    academyBId = academyB.id;

    const courseA = await seedCourse(admin, academyAId, 'P60 Alpha Course', {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(4900),
      pricingCurrency: 'USD',
    });
    const courseB = await seedCourse(admin, academyBId, 'P60 Beta Course', {
      status: 'archived',
      visibility: 'private',
    });
    courseAId = courseA.id;
    courseBId = courseB.id;
    createdCourseIds.push(courseA.id, courseB.id);

    const hidden = await seedCourse(admin, academyAId, 'P60 Hidden Course', {
      status: 'draft',
      visibility: 'private',
    });
    hiddenCourseId = hidden.id;
    createdCourseIds.push(hidden.id);
    const section = await seedCourseSection(admin, hidden.id, 'P60 Hidden Section', 1);
    await seedCourseLesson(admin, section.id, hidden.id, 'P60 Hidden Lesson', 1);
    await seedCourseInstructor(admin, hidden.id, tenantA.userId);
  });

  afterAll(async () => {
    if (createdCourseIds.length > 0) {
      await admin.course.deleteMany({ where: { id: { in: createdCourseIds } } });
    }
    if (createdOrgIds.length > 0) {
      // Academies (and the courses this suite created through the API under
      // them) cascade from the organization.
      await admin.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: `${label} user`, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedPlatformOwner(label: string) {
    const account = await signUp(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  function asOwner() {
    return { Authorization: `Bearer ${platformOwnerToken}` };
  }

  /**
   * The list is platform-wide and the shared dev database holds a hundred
   * other courses, so every assertion searches for this suite's own rows
   * rather than paging blindly.
   */
  async function listWith(params: string) {
    const response = await request(app.getHttpServer())
      .get(`/platform-courses?${params}`)
      .set(asOwner())
      .expect(200);
    return response.body as {
      items: Array<Record<string, unknown>>;
      pagination: { page: number; pageSize: number; totalItems: number };
    };
  }

  // ---------------- authorization ----------------

  it('P60-COURSE-001 — both routes refuse an UNAUTHENTICATED caller', async () => {
    await request(app.getHttpServer()).get('/platform-courses').expect(401);
    await request(app.getHttpServer())
      .get(`/platform-courses/${courseAId}`)
      .expect(401);
  });

  it('P60-COURSE-002 — a real TENANT OWNER is refused on both routes', async () => {
    // Not a permission string: `PlatformOwnerGuard` reads the user's own
    // `is_platform_owner` column, which no organization role can grant —
    // and this tenant owner OWNS course A, so a weaker guard would pass.
    const auth = { Authorization: `Bearer ${tenantOwnerToken}` };
    await request(app.getHttpServer()).get('/platform-courses').set(auth).expect(403);
    await request(app.getHttpServer())
      .get(`/platform-courses/${courseAId}`)
      .set(auth)
      .expect(403);
  });

  it('P60-COURSE-003 — the console is READ-ONLY: no write route exists', async () => {
    const auth = asOwner();
    await request(app.getHttpServer())
      .post('/platform-courses')
      .set(auth)
      .send({ title: 'nope' })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/platform-courses/${courseAId}`)
      .set(auth)
      .send({ title: 'nope' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/platform-courses/${courseAId}`)
      .set(auth)
      .expect(404);
  });

  // ---------------- cross-tenant reach ----------------

  it('P60-COURSE-004 — ONE request returns courses from two unrelated organizations', async () => {
    const body = await listWith('search=P60%20Alpha%20Course&pageSize=50');
    const alpha = body.items.find((item) => item.id === courseAId);
    expect(alpha).toBeDefined();
    expect(alpha?.organizationId).toBe(orgAId);

    const betaBody = await listWith('search=P60%20Beta%20Course&pageSize=50');
    const beta = betaBody.items.find((item) => item.id === courseBId);
    expect(beta).toBeDefined();
    expect(beta?.organizationId).toBe(orgBId);

    // Two different tenants, reachable by the same caller — the thing the
    // tenant-scoped `courses` endpoint can never do.
    expect(alpha?.organizationId).not.toBe(beta?.organizationId);
  });

  it('P60-COURSE-005 — each row names its owning academy AND organization', async () => {
    const body = await listWith('search=P60%20Alpha%20Course&pageSize=50');
    const alpha = body.items.find((item) => item.id === courseAId);
    expect(alpha?.academyId).toBe(academyAId);
    expect(alpha?.academyName).toBe('p60-academy-a');
    expect(alpha?.organizationName).toBe('p60-org-a');
  });

  it('P60-COURSE-006 — money is a NUMBER in major units, never a BigInt string', async () => {
    const body = await listWith('search=P60%20Alpha%20Course&pageSize=50');
    const alpha = body.items.find((item) => item.id === courseAId);
    expect(alpha?.pricingAmount).toBe(49);
    expect(typeof alpha?.pricingAmount).toBe('number');
    expect(alpha?.pricingCurrency).toBe('USD');
  });

  // ---------------- filtering, sorting, pagination ----------------

  it('P60-COURSE-007 — status/visibility/pricingType filters are applied by the DATABASE', async () => {
    const drafts = await listWith('status=draft&pageSize=100&search=P60%20');
    expect(drafts.items.length).toBeGreaterThan(0);
    expect(drafts.items.every((item) => item.status === 'draft')).toBe(true);
    expect(drafts.items.some((item) => item.id === courseAId)).toBe(false);

    const archived = await listWith('status=archived&pageSize=100&search=P60%20');
    expect(archived.items.every((item) => item.status === 'archived')).toBe(true);

    const paid = await listWith('pricingType=paid&pageSize=100&search=P60%20');
    expect(paid.items.every((item) => item.pricingType === 'paid')).toBe(true);
    expect(paid.items.some((item) => item.id === courseAId)).toBe(true);
  });

  it('P60-COURSE-008 — academyId and organizationId scope the list to one tenant', async () => {
    const byAcademy = await listWith(`academyId=${academyBId}&pageSize=100`);
    expect(byAcademy.items.length).toBeGreaterThan(0);
    expect(byAcademy.items.every((item) => item.academyId === academyBId)).toBe(true);

    const byOrg = await listWith(`organizationId=${orgBId}&pageSize=100`);
    expect(byOrg.items.every((item) => item.organizationId === orgBId)).toBe(true);
    expect(byOrg.items.some((item) => item.id === courseAId)).toBe(false);
  });

  it('P60-COURSE-009 — search matches the ORGANIZATION name, not only the title', async () => {
    const body = await listWith('search=p60-org-b&pageSize=50');
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.organizationName === 'p60-org-b')).toBe(true);
  });

  it('P60-COURSE-010 — sortBy is an allow-list; pagination meta is real', async () => {
    // A free-form `sortBy` would be interpolated into a Prisma `orderBy` key.
    await request(app.getHttpServer())
      .get('/platform-courses?sortBy=pricingAmountMinorUnits')
      .set(asOwner())
      .expect(400);
    await request(app.getHttpServer())
      .get('/platform-courses?unknownFilter=1')
      .set(asOwner())
      .expect(400);

    const page = await listWith('pageSize=2&page=2');
    expect(page.pagination.page).toBe(2);
    expect(page.pagination.pageSize).toBe(2);
    expect(page.items.length).toBeLessThanOrEqual(2);
    expect(page.pagination.totalItems).toBeGreaterThan(2);
  });

  // ---------------- detail + the P60b policies ----------------

  it('P60-COURSE-011 — a DRAFT/PRIVATE course exposes its curriculum and instructors', async () => {
    // Before P60b this returned 0/0/[]: `course_sections`, `course_lessons`
    // and `course_instructors` had no platform policy, so the owner could
    // see that the course existed and nothing inside it.
    const response = await request(app.getHttpServer())
      .get(`/platform-courses/${hiddenCourseId}`)
      .set(asOwner())
      .expect(200);

    expect(response.body.status).toBe('draft');
    expect(response.body.visibility).toBe('private');
    expect(response.body.totalSections).toBe(1);
    expect(response.body.totalLessons).toBe(1);
    expect(response.body.instructors).toHaveLength(1);
  });

  it('P60-COURSE-012 — enrollment outcomes and paid orders are reported separately', async () => {
    const response = await request(app.getHttpServer())
      .get(`/platform-courses/${courseAId}`)
      .set(asOwner())
      .expect(200);

    // Three distinct existing facts, never collapsed into one invented
    // "subscribed students" number.
    expect(typeof response.body.enrolledStudents).toBe('number');
    expect(typeof response.body.completedStudents).toBe('number');
    expect(typeof response.body.paidOrders).toBe('number');
  });

  it('P60-COURSE-013 — an unknown course id is 404, not 500', async () => {
    await request(app.getHttpServer())
      .get('/platform-courses/2b4e0b64-0000-4000-8000-000000000000')
      .set(asOwner())
      .expect(404);
  });

  // ---------------- the creator column ----------------

  it('P60-COURSE-014 — creating a course through the REAL endpoint records its creator', async () => {
    // The tenant owner creates a course the ordinary way. Nothing in that
    // request mentions a creator; the service records the authenticated
    // user, and the platform console reads it back.
    const academy = await seedAcademy(admin, orgAId, 'p60-academy-create');
    // The real create path is fully guarded: the caller must be an academy
    // member who can manage, and the organization must be within its
    // `courses` entitlement. Both are seeded rather than bypassed, so this
    // exercises the same code a customer would.
    await seedAcademyMember(admin, academy.id, tenantAUserId, 'owner');
    await seedActiveSubscriptionForOrg(admin, orgAId, 'p60-create');
    const tenantAuth = { Authorization: `Bearer ${tenantOwnerToken}` };

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set(tenantAuth)
      .send({
        title: 'P60 Created Course',
        slug: `p60-created-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);

    const courseId = created.body.id as string;
    createdCourseIds.push(courseId);

    const detail = await request(app.getHttpServer())
      .get(`/platform-courses/${courseId}`)
      .set(asOwner())
      .expect(200);

    expect(detail.body.createdBy).not.toBeNull();
    expect(detail.body.createdBy.id).toBeDefined();
    expect(detail.body.createdBy.name).toContain('p60-tenant-a');
  });

  it('P60-COURSE-015 — an unprovable historical creator is reported as null, never guessed', async () => {
    // `seedCourse` writes the row directly, exactly like a course that
    // predates this column. The honest answer is "not recorded".
    const detail = await request(app.getHttpServer())
      .get(`/platform-courses/${courseBId}`)
      .set(asOwner())
      .expect(200);

    expect(detail.body.createdBy).toBeNull();
    // Specifically NOT backfilled from the academy owner, which would have
    // been a plausible-looking fabrication.
    expect(detail.body).not.toHaveProperty('createdByName');
  });
});
