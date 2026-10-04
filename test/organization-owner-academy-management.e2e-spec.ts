/**
 * The organization owner manages every academy of the organization — at
 * the service layer too, not only in `AcademyScopeGuard`.
 *
 * The guard has always resolved the organization OWNER to academy role
 * `owner` for every academy in the organization, with no `academy_members`
 * row. The services' own `assertCanManage`-style re-checks read
 * `academy_members` only, so the owner of an academy with no staff row (the
 * seeded "Data Science Academy", or any academy created before its owner's
 * row existed) got through the guard and was then refused with 403 on
 * `GET /academies/:id`, `/website/domain`, and every other managed surface.
 *
 * The matrix below pins the corrected rule in both directions:
 *   - the organization owner with NO academy_members row -> allowed
 *   - an organization MANAGER with no row for this academy -> 403
 *     (the guard refuses; organization membership alone is never enough)
 *   - an organization manager whose row here is `instructor` -> 403 on
 *     the managing-tier surfaces (the fix must not widen the tier)
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';

interface Caller {
  readonly userId: string;
  readonly accessToken: string;
}

async function signUpAndSignIn(app: INestApplication, label: string): Promise<Caller> {
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
  return {
    userId: signIn.body.user.id as string,
    accessToken: signIn.body.accessToken as string,
  };
}

describe('Organization owner manages academies without a staff row (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  let owner: Caller;
  let orgManager: Caller;
  let orgManagerInstructor: Caller;
  let organizationId: string;
  let academyId: string;
  let courseId: string;

  /** Managing-tier reads, each re-checked by a service-level helper. */
  let managedReads: readonly string[];

  const get = (caller: Caller, path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${caller.accessToken}`);

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();

    owner = await signUpAndSignIn(app, 'oo-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'oo-org');
    organizationId = org.id;
    await seedActiveSubscriptionForOrg(admin, org.id, 'oo-sub');
    // NO academy_members row for the owner — exactly the seeded
    // "Data Science Academy" shape.
    academyId = (await seedAcademy(admin, org.id, 'oo-academy')).id;
    courseId = (await seedCourse(admin, academyId, 'OO Draft Course')).id;

    orgManager = await signUpAndSignIn(app, 'oo-org-manager');
    await seedMembership(admin, org.id, orgManager.userId, 'manager');

    orgManagerInstructor = await signUpAndSignIn(app, 'oo-org-mgr-instr');
    await seedMembership(admin, org.id, orgManagerInstructor.userId, 'manager');
    await seedAcademyMember(admin, academyId, orgManagerInstructor.userId, 'instructor');

    managedReads = [
      `/academies/${academyId}`,
      `/academies/${academyId}/website/domain`,
      `/academies/${academyId}/website/configuration`,
      `/academies/${academyId}/website/pages`,
      `/academies/${academyId}/website/faq-entries`,
      `/academies/${academyId}/certificate-template`,
      `/academies/${academyId}/contact-submissions`,
      `/academies/${academyId}/courses/${courseId}/completion-rule`,
    ];
  });

  afterAll(async () => {
    // The organization cascades to its academies, memberships and content.
    if (organizationId) {
      await admin.organization.delete({ where: { id: organizationId } }).catch(() => {});
    }
    await admin?.$disconnect();
    await app?.close();
  });

  it('the fixture really has no academy_members row for the organization owner', async () => {
    const row = await admin.academyMember.findFirst({
      where: { academyId, userId: owner.userId },
    });
    expect(row).toBeNull();
  });

  it('the organization owner reads every managed surface (200)', async () => {
    for (const path of managedReads) {
      const res = await get(owner, path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
    const me = await get(owner, `/academies/${academyId}/me`).expect(200);
    expect(me.body).toMatchObject({ role: 'owner' });
  });

  it('the organization owner writes: academy settings, website, courses', async () => {
    const description = `Managed by the organization owner ${Date.now()}`;
    const patched = await request(app.getHttpServer())
      .patch(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ description })
      .expect(200);
    expect(patched.body.description).toBe(description);

    await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Owner Course',
        slug: `owner-course-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);

    // The audit trail attributes the write to the implicit academy owner.
    const audit = await admin.auditLogEntry.findFirst({
      where: { academyId, actorUserId: owner.userId, action: 'academy.updated' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.role).toBe('owner');
  });

  it('the RLS helpers apply the same rule: organization owner yes, organization manager no', async () => {
    const helpers = async (userId: string) => {
      const [row] = await admin.$queryRaw<
        { member: boolean; moderator: boolean; students: boolean; author: boolean }[]
      >`SELECT is_academy_member(${academyId}, ${userId}) AS member,
               is_academy_moderator(${academyId}, ${userId}) AS moderator,
               can_manage_academy_students(${academyId}, ${userId}) AS students,
               can_author_course_content(${courseId}, ${userId}) AS author`;
      return row;
    };
    expect(await helpers(owner.userId)).toEqual({
      member: true,
      moderator: true,
      students: true,
      author: true,
    });
    expect(await helpers(orgManager.userId)).toEqual({
      member: false,
      moderator: false,
      students: false,
      author: false,
    });
    // An instructor row is membership, never the managing tier.
    expect(await helpers(orgManagerInstructor.userId)).toEqual({
      member: true,
      moderator: false,
      students: false,
      author: false,
    });
  });

  it('an organization manager with no row for this academy is refused (403)', async () => {
    for (const path of managedReads) {
      const res = await get(orgManager, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    await request(app.getHttpServer())
      .patch(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${orgManager.accessToken}`)
      .send({ description: 'not allowed' })
      .expect(403);
  });

  it('an organization manager who is only an instructor here stays out of the managing tier (403)', async () => {
    for (const path of [
      `/academies/${academyId}`,
      `/academies/${academyId}/website/configuration`,
      `/academies/${academyId}/certificate-template`,
    ]) {
      const res = await get(orgManagerInstructor, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    await request(app.getHttpServer())
      .patch(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${orgManagerInstructor.accessToken}`)
      .send({ description: 'not allowed' })
      .expect(403);
  });
});
