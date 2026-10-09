/**
 * Organization-owner-only academy administration (real Postgres, RLS
 * enforced): deleting an academy, changing its slug/status, and removing a
 * staff member.
 *
 * DELETING / RE-ADDRESSING THE ACADEMY. `archive` and the `slug`/`status`
 * fields of `PATCH /academies/:id` used to accept the whole managing tier
 * (owner/administrator/manager), so a Manager could take the academy's
 * public website offline, release its custom domain and free the plan's
 * academy allowance, or move its public address. They are now the
 * organization owner's alone (`AcademiesService.assertIsOrganizationOwner`);
 * every other Manager edit keeps working — including re-saving the form,
 * which re-sends the unchanged slug.
 *
 * REMOVING STAFF. `DELETE /academies/:id/members/:userId` did not exist:
 * the owner could add Managers and Instructors but never take access away.
 * The route is organization-owner-only; one removal marks the academy row
 * `inactive`, revokes that user's course assignments in THIS academy, ends
 * their organization membership when no other academy of the organization
 * still needs it, and writes one audit row. Every guard re-reads membership
 * per request, so the removed person is refused on the very next call —
 * which these tests prove from the removed person's own token.
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
  seedCourseInstructor,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../src/tenancy/constants/organization-permissions.constants';

interface Caller {
  readonly userId: string;
  readonly email: string;
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
    email,
    accessToken: signIn.body.accessToken as string,
  };
}

/** A short, valid, unused academy slug (the DTO caps slugs at 50 characters). */
function freshSlug(label: string): string {
  return `aoa-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

describe('Organization-owner-only academy administration (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  const http = () => request(app.getHttpServer());
  const bearer = (caller: Caller) => ({ Authorization: `Bearer ${caller.accessToken}` });

  /** Grants staff access the way `addManager`/`addInstructor` do: both rows. */
  async function grantStaff(
    organizationId: string,
    academyId: string,
    caller: Caller,
    academyRole: 'administrator' | 'manager' | 'instructor',
  ): Promise<void> {
    const orgRole = academyRole === 'instructor' ? 'instructor' : 'manager';
    const existing = await admin.organizationMembership.findFirst({
      where: { organizationId, userId: caller.userId },
    });
    if (!existing) {
      await admin.organizationMembership.create({
        data: {
          organizationId,
          userId: caller.userId,
          role: orgRole,
          permissions: [
            ...(orgRole === 'manager'
              ? ORGANIZATION_MANAGER_PERMISSIONS
              : ORGANIZATION_INSTRUCTOR_PERMISSIONS),
          ],
        },
      });
    }
    await seedAcademyMember(admin, academyId, caller.userId, academyRole);
  }

  async function world(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, `${label}-sub`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const manager = await signUpAndSignIn(app, `${label}-manager`);
    await grantStaff(org.id, academy.id, manager, 'manager');
    const administrator = await signUpAndSignIn(app, `${label}-administrator`);
    await grantStaff(org.id, academy.id, administrator, 'administrator');
    const instructor = await signUpAndSignIn(app, `${label}-instructor`);
    await grantStaff(org.id, academy.id, instructor, 'instructor');
    return { owner, org, academy, manager, administrator, instructor };
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('deleting (archiving) the academy', () => {
    it('a Manager and an Administrator get 403 on both delete routes, and the academy is untouched', async () => {
      const w = await world('aoa-del-refused');
      for (const caller of [w.manager, w.administrator]) {
        await http().delete(`/academies/${w.academy.id}`).set(bearer(caller)).expect(403);
        await http()
          .post(`/academies/${w.academy.id}/delete`)
          .set(bearer(caller))
          .send({ confirm: true, reason: 'other' })
          .expect(403);
      }
      const row = await admin.academy.findUniqueOrThrow({ where: { id: w.academy.id } });
      expect(row.status).not.toBe('archived');
      expect(row.archivedAt).toBeNull();
    });

    it('the organization owner deletes it through either route', async () => {
      const w = await world('aoa-del-owner');
      await http()
        .post(`/academies/${w.academy.id}/delete`)
        .set(bearer(w.owner))
        .send({ confirm: true, reason: 'testing_only' })
        .expect(204);
      const row = await admin.academy.findUniqueOrThrow({ where: { id: w.academy.id } });
      expect(row.status).toBe('archived');

      const second = await seedAcademy(admin, w.org.id, 'aoa-del-owner-second');
      await http().delete(`/academies/${second.id}`).set(bearer(w.owner)).expect(204);
      expect(
        (await admin.academy.findUniqueOrThrow({ where: { id: second.id } })).status,
      ).toBe('archived');
    });
  });

  describe('changing the slug or status', () => {
    it('a Manager or Administrator cannot change the slug or the status (403), but every other edit — re-sending the current slug and status included — still works', async () => {
      const w = await world('aoa-slug');
      const before = await admin.academy.findUniqueOrThrow({
        where: { id: w.academy.id },
      });
      const otherStatus = before.status === 'active' ? 'draft' : 'active';

      for (const caller of [w.manager, w.administrator]) {
        await http()
          .patch(`/academies/${w.academy.id}`)
          .set(bearer(caller))
          .send({ slug: freshSlug('moved') })
          .expect(403);
        await http()
          .patch(`/academies/${w.academy.id}`)
          .set(bearer(caller))
          .send({ status: otherStatus })
          .expect(403);
        // The settings form's real save: the current slug comes along.
        await http()
          .patch(`/academies/${w.academy.id}`)
          .set(bearer(caller))
          .send({
            slug: before.slug,
            status: before.status,
            description: `Edited by ${caller.userId}`,
          })
          .expect(200);
      }

      const after = await admin.academy.findUniqueOrThrow({
        where: { id: w.academy.id },
      });
      expect(after.slug).toBe(before.slug);
      expect(after.status).toBe(before.status);
      expect(after.description).toBe(`Edited by ${w.administrator.userId}`);
    });

    it('the organization owner changes both', async () => {
      const w = await world('aoa-slug-owner');
      const before = await admin.academy.findUniqueOrThrow({
        where: { id: w.academy.id },
      });
      const otherStatus = before.status === 'active' ? 'draft' : 'active';
      const newSlug = freshSlug('owner');
      await http()
        .patch(`/academies/${w.academy.id}`)
        .set(bearer(w.owner))
        .send({ slug: newSlug, status: otherStatus })
        .expect(200);
      const after = await admin.academy.findUniqueOrThrow({
        where: { id: w.academy.id },
      });
      expect(after.slug).toBe(newSlug);
      expect(after.status).toBe(otherStatus);
    });
  });

  describe('removing a staff member — DELETE /academies/:id/members/:userId', () => {
    it('only the organization owner may remove: a Manager, an Administrator and an Instructor get 403 and nothing changes', async () => {
      const w = await world('aoa-rm-refused');
      for (const caller of [w.manager, w.administrator, w.instructor]) {
        await http()
          .delete(`/academies/${w.academy.id}/members/${w.instructor.userId}`)
          .set(bearer(caller))
          .expect(403);
      }
      await http()
        .delete(`/academies/${w.academy.id}/members/${w.manager.userId}`)
        .set(bearer(w.administrator))
        .expect(403);
      const rows = await admin.academyMember.findMany({
        where: { academyId: w.academy.id },
      });
      expect(rows.every((row) => row.status === 'active')).toBe(true);
    });

    it('the organization owner can never be removed — not even by themselves (409)', async () => {
      const w = await world('aoa-rm-owner');
      await http()
        .delete(`/academies/${w.academy.id}/members/${w.owner.userId}`)
        .set(bearer(w.owner))
        .expect(409);
      const ownerRow = await admin.academyMember.findFirstOrThrow({
        where: { academyId: w.academy.id, userId: w.owner.userId },
      });
      expect(ownerRow.status).toBe('active');
      expect(
        await admin.organizationMembership.count({
          where: { organizationId: w.org.id, userId: w.owner.userId, role: 'owner' },
        }),
      ).toBe(1);
    });

    it('removing an instructor: academy row inactive, this academy’s course assignments revoked, organization membership ended, audited — and their next request is refused', async () => {
      const w = await world('aoa-rm-instructor');
      const course = await seedCourse(admin, w.academy.id, 'AOA Course');
      await seedCourseInstructor(admin, course.id, w.instructor.userId);

      // Reachable before.
      await http()
        .get(`/academies/${w.academy.id}/me`)
        .set(bearer(w.instructor))
        .expect(200);
      await http()
        .get(`/instructor/courses/${course.id}`)
        .set(bearer(w.instructor))
        .expect(200);
      await http()
        .get(`/organizations/${w.org.id}/subscription`)
        .set(bearer(w.instructor))
        .expect(200);

      await http()
        .delete(`/academies/${w.academy.id}/members/${w.instructor.userId}`)
        .set(bearer(w.owner))
        .expect(204);

      const row = await admin.academyMember.findFirstOrThrow({
        where: { academyId: w.academy.id, userId: w.instructor.userId },
      });
      expect(row.status).toBe('inactive');
      expect(
        await admin.courseInstructor.count({ where: { userId: w.instructor.userId } }),
      ).toBe(0);
      expect(
        await admin.organizationMembership.count({
          where: { organizationId: w.org.id, userId: w.instructor.userId },
        }),
      ).toBe(0);
      const audit = await admin.auditLogEntry.findFirst({
        where: { action: 'academy.member.removed', targetId: row.id },
      });
      expect(audit).not.toBeNull();
      expect(audit!.actorUserId).toBe(w.owner.userId);

      // The SAME access token, the very next request: refused everywhere.
      await http()
        .get(`/academies/${w.academy.id}/me`)
        .set(bearer(w.instructor))
        .expect(403);
      await http()
        .get(`/instructor/courses/${course.id}`)
        .set(bearer(w.instructor))
        .expect(404);
      await http()
        .get(`/organizations/${w.org.id}/subscription`)
        .set(bearer(w.instructor))
        .expect(403);

      // The roster still shows the row, as inactive.
      const members = await http()
        .get(`/academies/${w.academy.id}/members`)
        .set(bearer(w.owner))
        .expect(200);
      const listed = members.body.items.find(
        (m: { userId?: string; id: string }) =>
          m.userId === w.instructor.userId || m.id === row.id,
      );
      expect(listed?.status).toBe('inactive');

      // Removing again is a 404 — there is nothing left to remove.
      await http()
        .delete(`/academies/${w.academy.id}/members/${w.instructor.userId}`)
        .set(bearer(w.owner))
        .expect(404);
    });

    it('removing a manager ends their academy access at once', async () => {
      const w = await world('aoa-rm-manager');
      await http().get(`/academies/${w.academy.id}`).set(bearer(w.manager)).expect(200);
      await http()
        .delete(`/academies/${w.academy.id}/members/${w.manager.userId}`)
        .set(bearer(w.owner))
        .expect(204);
      await http().get(`/academies/${w.academy.id}`).set(bearer(w.manager)).expect(403);
      await http()
        .patch(`/academies/${w.academy.id}`)
        .set(bearer(w.manager))
        .send({ description: 'after removal' })
        .expect(403);
    });

    it('staff of a second academy in the same organization keep that academy, its course assignments and their organization membership', async () => {
      const w = await world('aoa-rm-two');
      const academyB = await seedAcademy(admin, w.org.id, 'aoa-rm-two-b');
      await seedAcademyMember(admin, academyB.id, w.instructor.userId, 'instructor');
      const courseA = await seedCourse(admin, w.academy.id, 'AOA Two A');
      const courseB = await seedCourse(admin, academyB.id, 'AOA Two B');
      await seedCourseInstructor(admin, courseA.id, w.instructor.userId);
      await seedCourseInstructor(admin, courseB.id, w.instructor.userId);

      await http()
        .delete(`/academies/${w.academy.id}/members/${w.instructor.userId}`)
        .set(bearer(w.owner))
        .expect(204);

      expect(
        await admin.courseInstructor.findMany({
          where: { userId: w.instructor.userId },
          select: { courseId: true },
        }),
      ).toEqual([{ courseId: courseB.id }]);
      expect(
        await admin.organizationMembership.count({
          where: { organizationId: w.org.id, userId: w.instructor.userId },
        }),
      ).toBe(1);

      await http()
        .get(`/academies/${w.academy.id}/me`)
        .set(bearer(w.instructor))
        .expect(403);
      await http()
        .get(`/academies/${academyB.id}/me`)
        .set(bearer(w.instructor))
        .expect(200);
      await http()
        .get(`/instructor/courses/${courseA.id}`)
        .set(bearer(w.instructor))
        .expect(404);
      await http()
        .get(`/instructor/courses/${courseB.id}`)
        .set(bearer(w.instructor))
        .expect(200);
    });

    it('a user who is not staff of this academy is a 404, and a non-UUID id is a 400', async () => {
      const w = await world('aoa-rm-unknown');
      const stranger = await signUpAndSignIn(app, 'aoa-rm-unknown-stranger');
      await http()
        .delete(`/academies/${w.academy.id}/members/${stranger.userId}`)
        .set(bearer(w.owner))
        .expect(404);
      await http()
        .delete(`/academies/${w.academy.id}/members/not-a-uuid`)
        .set(bearer(w.owner))
        .expect(400);
    });

    it('a removed instructor can be added back by the owner: the same row is reactivated', async () => {
      const w = await world('aoa-rm-readd');
      await http()
        .delete(`/academies/${w.academy.id}/members/${w.instructor.userId}`)
        .set(bearer(w.owner))
        .expect(204);
      // A verified account, so the add is a plain "added" (no setup link).
      await admin.user.update({
        where: { id: w.instructor.userId },
        data: { emailVerifiedAt: new Date() },
      });

      const lookup = await http()
        .get(`/academies/${w.academy.id}/member-lookup`)
        .query({ email: w.instructor.email, role: 'instructor' })
        .set(bearer(w.owner))
        .expect(200);
      expect(lookup.body.status).toBe('new');

      await http()
        .post(`/academies/${w.academy.id}/instructors`)
        .set(bearer(w.owner))
        .send({ email: w.instructor.email, name: 'AOA Re-added Instructor' })
        .expect(201);
      const rows = await admin.academyMember.findMany({
        where: { academyId: w.academy.id, userId: w.instructor.userId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('active');
      expect(rows[0].role).toBe('instructor');
      await http()
        .get(`/academies/${w.academy.id}/me`)
        .set(bearer(w.instructor))
        .expect(200);
    });
  });
});
