/**
 * Direct PostgreSQL/RLS proof for `course_categories`/`courses`/
 * `course_instructors`/`course_sections`/`course_lessons` — mirrors
 * `rls-academies.e2e-spec.ts` exactly: every test talks to Postgres
 * directly through the app's own `PrismaService` (connected as the
 * restricted `atlas_app` role) and `TenancyContextService`. No guard, no
 * service, no HTTP request is involved anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — course_categories / courses / course_instructors / course_sections / course_lessons (direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createUser(label: string): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label },
    });
    return { id: user.id };
  }

  async function createOrgOwnedBy(ownerId: string, slugLabel: string) {
    return prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const org = await tx.organization.create({
        data: {
          id,
          name: slugLabel,
          slug: `${slugLabel}-${Date.now()}`,
          ownerUserId: ownerId,
        },
      });
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
      });
      return org;
    });
  }

  async function createAcademyIn(organizationId: string, slugLabel: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academy.create({
        data: { organizationId, name: slugLabel, slug: `${slugLabel}-${Date.now()}` },
      }),
    );
  }

  async function createCourseIn(
    organizationId: string,
    academyId: string,
    slugLabel: string,
  ) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.course.create({
        data: { academyId, title: slugLabel, slug: `${slugLabel}-${Date.now()}` },
      }),
    );
  }

  it('SELECT: an active tenant context only ever sees its own course row', async () => {
    const owner1 = await createUser('rls-course-select-owner1');
    const owner2 = await createUser('rls-course-select-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-course-select-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-course-select-org2');
    const academy1 = await createAcademyIn(org1.id, 'rls-course-select-a1');
    const academy2 = await createAcademyIn(org2.id, 'rls-course-select-a2');
    const course1 = await createCourseIn(org1.id, academy1.id, 'rls-course-select-c1');
    const course2 = await createCourseIn(org2.id, academy2.id, 'rls-course-select-c2');

    const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.course.findMany({ where: { id: { in: [course1.id, course2.id] } } }),
    );
    expect(visible.map((c) => c.id)).toEqual([course1.id]);
  });

  it('SELECT: with no session variable set at all, every course row is invisible (fail-closed)', async () => {
    const owner = await createUser('rls-course-noctx-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-course-noctx-org');
    const academy = await createAcademyIn(org.id, 'rls-course-noctx-a');
    const course = await createCourseIn(org.id, academy.id, 'rls-course-noctx-c');

    const rows = await prisma.course.findMany({ where: { id: course.id } });
    expect(rows).toEqual([]);
  });

  it("SELECT (transitive, two hops): course_sections/course_lessons are visible only through their course's owning organization context", async () => {
    const owner1 = await createUser('rls-curriculum-select-owner1');
    const owner2 = await createUser('rls-curriculum-select-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-curriculum-select-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-curriculum-select-org2');
    const academy1 = await createAcademyIn(org1.id, 'rls-curriculum-select-a1');
    const course1 = await createCourseIn(
      org1.id,
      academy1.id,
      'rls-curriculum-select-c1',
    );

    const section = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.courseSection.create({
        data: { courseId: course1.id, title: 'Section', order: 0 },
      }),
    );
    const lesson = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.courseLesson.create({
        data: {
          sectionId: section.id,
          courseId: course1.id,
          title: 'Lesson',
          order: 0,
          contentType: 'text',
        },
      }),
    );

    const visibleInOwnOrg = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      Promise.all([
        tx.courseSection.findUnique({ where: { id: section.id } }),
        tx.courseLesson.findUnique({ where: { id: lesson.id } }),
      ]),
    );
    expect(visibleInOwnOrg[0]?.id).toBe(section.id);
    expect(visibleInOwnOrg[1]?.id).toBe(lesson.id);

    const visibleInOtherOrg = await tenancyContext.runInTenantContext(org2.id, (tx) =>
      Promise.all([
        tx.courseSection.findUnique({ where: { id: section.id } }),
        tx.courseLesson.findUnique({ where: { id: lesson.id } }),
      ]),
    );
    expect(visibleInOtherOrg[0]).toBeNull();
    expect(visibleInOtherOrg[1]).toBeNull();
  });

  it("ATTACK (blocked): cannot create a course under a different organization's academy than the active tenant context", async () => {
    const owner1 = await createUser('rls-atk-course-owner1');
    const owner2 = await createUser('rls-atk-course-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-course-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-course-org2');
    const academy2 = await createAcademyIn(org2.id, 'rls-atk-course-a2');

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.course.create({
          data: {
            academyId: academy2.id,
            title: 'Attacker Course',
            slug: `rls-atk-course-${Date.now()}`,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("ATTACK (blocked): cannot insert a course_section under another organization's course", async () => {
    const owner1 = await createUser('rls-atk-section-owner1');
    const owner2 = await createUser('rls-atk-section-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-section-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-section-org2');
    const academy2 = await createAcademyIn(org2.id, 'rls-atk-section-a2');
    const course2 = await createCourseIn(org2.id, academy2.id, 'rls-atk-section-c2');

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.courseSection.create({
          data: { courseId: course2.id, title: 'Attacker Section', order: 0 },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (blocked): cannot update a course belonging to a different organization', async () => {
    const owner1 = await createUser('rls-atk-update-owner1');
    const owner2 = await createUser('rls-atk-update-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-update-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-update-org2');
    const academy2 = await createAcademyIn(org2.id, 'rls-atk-update-a2');
    const course2 = await createCourseIn(org2.id, academy2.id, 'rls-atk-update-c2');

    const affected = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.course.updateMany({ where: { id: course2.id }, data: { title: 'Hijacked' } }),
    );
    expect(affected.count).toBe(0);

    const stillIntact = await tenancyContext.runInTenantContext(org2.id, (tx) =>
      tx.course.findUniqueOrThrow({ where: { id: course2.id } }),
    );
    expect(stillIntact.title).not.toBe('Hijacked');
  });

  it("ATTACK (blocked): cannot delete a course_section belonging to a different organization's course", async () => {
    const owner1 = await createUser('rls-atk-delete-owner1');
    const owner2 = await createUser('rls-atk-delete-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-delete-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-delete-org2');
    const academy2 = await createAcademyIn(org2.id, 'rls-atk-delete-a2');
    const course2 = await createCourseIn(org2.id, academy2.id, 'rls-atk-delete-c2');
    const section2 = await tenancyContext.runInTenantContext(org2.id, (tx) =>
      tx.courseSection.create({
        data: { courseId: course2.id, title: 'Section', order: 0 },
      }),
    );

    const affected = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.courseSection.deleteMany({ where: { id: section2.id } }),
    );
    expect(affected.count).toBe(0);

    const stillExists = await tenancyContext.runInTenantContext(org2.id, (tx) =>
      tx.courseSection.findUnique({ where: { id: section2.id } }),
    );
    expect(stillExists).not.toBeNull();
  });

  it('ATTACK (blocked): cannot insert a course_instructor row for a course in a different organization', async () => {
    const owner1 = await createUser('rls-atk-instructor-owner1');
    const owner2 = await createUser('rls-atk-instructor-owner2');
    const instructor = await createUser('rls-atk-instructor-target');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-instructor-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-instructor-org2');
    const academy2 = await createAcademyIn(org2.id, 'rls-atk-instructor-a2');
    const course2 = await createCourseIn(org2.id, academy2.id, 'rls-atk-instructor-c2');

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.courseInstructor.create({
          data: { courseId: course2.id, userId: instructor.id },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('LEGITIMATE (allowed): creating a full curriculum (course → section → lesson) within the active tenant context', async () => {
    const owner = await createUser('rls-legit-course-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-legit-course-org');
    const academy = await createAcademyIn(org.id, 'rls-legit-course-a');
    const course = await createCourseIn(org.id, academy.id, 'rls-legit-course-c');

    const section = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.courseSection.create({
        data: { courseId: course.id, title: 'Section', order: 0 },
      }),
    );
    const lesson = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.courseLesson.create({
        data: {
          sectionId: section.id,
          courseId: course.id,
          title: 'Lesson',
          order: 0,
          contentType: 'text',
        },
      }),
    );

    expect(section.courseId).toBe(course.id);
    expect(lesson.sectionId).toBe(section.id);
  });
});
