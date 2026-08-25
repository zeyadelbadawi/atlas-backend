/**
 * Instructor Operations & Community tenant-isolation suite —
 * P7-TENANT-001..005 (master plan §18), extending the permanent
 * tenant-isolation suite established in `tenant-isolation.e2e-spec.ts`
 * (P2) through `learning-tenant-isolation.e2e-spec.ts` (P6) — one file per
 * phase, same pattern. Exercised through the real HTTP surface; the pure
 * DB-level RLS proof lives in `rls-instructor-community.e2e-spec.ts`.
 * Scenario 5 itself (an instructor not assigned to a course cannot grade
 * its submissions) is the mandatory §18 test, covered in
 * `instructor.e2e-spec.ts`; this file's own contribution is the
 * cross-ORGANIZATION shape of the same invariant, applied to every new P7
 * resource.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseInstructor,
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

describe('Instructor Operations & Community tenant isolation (e2e) — P7-TENANT-001..005', () => {
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

  async function seedOrgAFixture(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const instructor = await signUpAndSignIn(app, `${label}-instr`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    await seedCourseInstructor(admin, course.id, instructor.userId);
    return { owner, instructor, org, academy, course };
  }

  it('P7-TENANT-001: an Organization B instructor cannot read Organization A course roster by guessing its course id', async () => {
    const { course } = await seedOrgAFixture('t7-001-a');
    const orgBInstructor = await signUpAndSignIn(app, 't7-001-b-instr');
    const orgBOrg = await seedOrganizationWithOwner(
      admin,
      orgBInstructor.userId,
      't7-001-b-org',
    );
    const orgBAcademy = await seedAcademy(admin, orgBOrg.id, 't7-001-b-academy');
    const orgBCourse = await seedCourse(admin, orgBAcademy.id, 't7-001-b-course', {
      status: 'published',
      visibility: 'public',
    });
    await seedCourseInstructor(admin, orgBCourse.id, orgBInstructor.userId);

    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}/students`)
      .set('Authorization', `Bearer ${orgBInstructor.accessToken}`)
      .expect(404);
  });

  it("P7-TENANT-002: Organization B instructor's teaching-course list never includes Organization A's course, even with a wide page size", async () => {
    const { course } = await seedOrgAFixture('t7-002-a');
    const orgBInstructor = await signUpAndSignIn(app, 't7-002-b-instr');
    const orgBOrg = await seedOrganizationWithOwner(
      admin,
      orgBInstructor.userId,
      't7-002-b-org',
    );
    const orgBAcademy = await seedAcademy(admin, orgBOrg.id, 't7-002-b-academy');
    const orgBCourse = await seedCourse(admin, orgBAcademy.id, 't7-002-b-course', {
      status: 'published',
      visibility: 'public',
    });
    await seedCourseInstructor(admin, orgBCourse.id, orgBInstructor.userId);

    const list = await request(app.getHttpServer())
      .get('/instructor/courses')
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${orgBInstructor.accessToken}`)
      .expect(200);
    const ids = list.body.items.map((c: { courseId: string }) => c.courseId);
    expect(ids).toContain(orgBCourse.id);
    expect(ids).not.toContain(course.id);
  });

  it("P7-TENANT-003: Organization B's academy owner cannot manage Organization A's course announcements by direct course id", async () => {
    const { course } = await seedOrgAFixture('t7-003-a');
    const orgBOwner = await signUpAndSignIn(app, 't7-003-b-owner');
    const orgBOrg = await seedOrganizationWithOwner(
      admin,
      orgBOwner.userId,
      't7-003-b-org',
    );
    const orgBAcademy = await seedAcademy(admin, orgBOrg.id, 't7-003-b-academy');
    await seedAcademyMember(admin, orgBAcademy.id, orgBOwner.userId, 'owner');

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements`)
      .set('Authorization', `Bearer ${orgBOwner.accessToken}`)
      .send({ title: 'Cross-tenant write', body: 'Should never land' })
      .expect(403);
  });

  it("P7-TENANT-004: Organization B's staff member cannot update Organization A's blog post by guessing its id — invisible to them, not merely forbidden", async () => {
    const { owner } = await seedOrgAFixture('t7-004-a');
    const post = await request(app.getHttpServer())
      .post('/blog-posts')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Org A post', slug: `t7-004-${Date.now()}`, content: 'x' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/blog-posts/${post.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const orgBStaff = await signUpAndSignIn(app, 't7-004-b-staff');
    const orgBOrg = await seedOrganizationWithOwner(
      admin,
      orgBStaff.userId,
      't7-004-b-org',
    );
    const orgBAcademy = await seedAcademy(admin, orgBOrg.id, 't7-004-b-academy');
    await seedAcademyMember(admin, orgBAcademy.id, orgBStaff.userId, 'administrator');

    // Cross-academy: not merely unowned but genuinely invisible under
    // `blog_posts_published_select` (academy-scoped) — 404, not 403,
    // matching this codebase's established "draft/unreachable content
    // looks like it doesn't exist" precedent (P6's `assertActiveEnrollment`
    // doc comment) applied here to cross-tenant content.
    await request(app.getHttpServer())
      .patch(`/blog-posts/${post.body.id}`)
      .set('Authorization', `Bearer ${orgBStaff.accessToken}`)
      .send({ title: 'Hijacked' })
      .expect(404);

    const stillOriginal = await admin.blogPost.findUniqueOrThrow({
      where: { id: post.body.id },
    });
    expect(stillOriginal.title).toBe('Org A post');
  });

  it("P7-TENANT-005: Organization B's instructor cannot reach Organization A's course forum by direct course id", async () => {
    const { course } = await seedOrgAFixture('t7-005-a');
    const orgBInstructor = await signUpAndSignIn(app, 't7-005-b-instr');
    const orgBOrg = await seedOrganizationWithOwner(
      admin,
      orgBInstructor.userId,
      't7-005-b-org',
    );
    const orgBAcademy = await seedAcademy(admin, orgBOrg.id, 't7-005-b-academy');
    const orgBCourse = await seedCourse(admin, orgBAcademy.id, 't7-005-b-course', {
      status: 'published',
      visibility: 'public',
    });
    await seedCourseInstructor(admin, orgBCourse.id, orgBInstructor.userId);

    await request(app.getHttpServer())
      .get(`/courses/${course.id}/forum`)
      .set('Authorization', `Bearer ${orgBInstructor.accessToken}`)
      .expect(404);
  });
});
