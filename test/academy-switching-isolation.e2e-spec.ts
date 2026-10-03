/**
 * W5 — academy switching isolation (finding F12: intra-organization IDOR).
 *
 * One organization, two academies (A and B). Before W5, `AcademyScopeGuard`
 * admitted ANY organization member to every academy of the organization,
 * so the manager of A could read B's courses (drafts included), media,
 * stats, live sessions and communication settings. This spec is the
 * authorization matrix over every endpoint W5 fixed, plus the academy
 * list filter and `GET /academies/:id/me`:
 *   - another academy's staff in the same organization -> 403
 *   - the organization owner (no academy_members row at all) -> 200
 *   - an INACTIVE member of the academy -> 403, on the very next request
 *     after the row flips (no cached role)
 *   - an active member of the academy -> 200 within their tier
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseCategory,
  seedMediaAsset,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';

/** The API's error envelope (`{ error: { messageKey } }`), or a bare body. */
function messageKeyOf(body: {
  error?: { messageKey?: string };
  messageKey?: string;
}): string | undefined {
  return body.error?.messageKey ?? body.messageKey;
}

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

describe('W5 — academy switching isolation (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  let owner: Caller;
  let managerOfA: Caller;
  let instructorOfB: Caller;
  let managerOfB: Caller;
  let inactiveManagerOfB: Caller;
  let organizationId: string;
  let academyA: string;
  let academyB: string;
  let courseB: string;
  let categoryB: string;
  let mediaB: string;

  /** Every endpoint W5 fixed, for academy B. `ok` is the status an authorized caller gets. */
  let endpoints: { readonly path: string; readonly ok: number; readonly tier: string }[];

  const get = (caller: Caller, path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${caller.accessToken}`);

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();

    owner = await signUpAndSignIn(app, 'w5-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'w5-org');
    organizationId = org.id;
    academyA = (await seedAcademy(admin, org.id, 'w5-academy-a')).id;
    academyB = (await seedAcademy(admin, org.id, 'w5-academy-b')).id;

    // The manager of A holds an organization membership with the full
    // organization-wide manager permission set — exactly what the staff
    // grant writes — but staffs only A.
    managerOfA = await signUpAndSignIn(app, 'w5-manager-a');
    await seedMembership(admin, org.id, managerOfA.userId, 'manager');
    await seedAcademyMember(admin, academyA, managerOfA.userId, 'manager');

    managerOfB = await signUpAndSignIn(app, 'w5-manager-b');
    await seedMembership(admin, org.id, managerOfB.userId, 'manager');
    await seedAcademyMember(admin, academyB, managerOfB.userId, 'manager');

    instructorOfB = await signUpAndSignIn(app, 'w5-instructor-b');
    await seedMembership(admin, org.id, instructorOfB.userId, 'instructor');
    await seedAcademyMember(admin, academyB, instructorOfB.userId, 'instructor');

    inactiveManagerOfB = await signUpAndSignIn(app, 'w5-inactive-b');
    await seedMembership(admin, org.id, inactiveManagerOfB.userId, 'manager');
    const inactiveRow = await seedAcademyMember(
      admin,
      academyB,
      inactiveManagerOfB.userId,
      'manager',
    );
    await admin.academyMember.update({
      where: { id: inactiveRow.id },
      data: { status: 'inactive' },
    });

    categoryB = (await seedCourseCategory(admin, academyB, 'W5 Category')).id;
    courseB = (
      await seedCourse(admin, academyB, 'W5 Draft Course B', { categoryId: categoryB })
    ).id;
    mediaB = (await seedMediaAsset(admin, academyB, 1024n)).id;

    endpoints = [
      { path: `/academies/${academyB}/stats`, ok: 200, tier: 'managing' },
      {
        path: `/academies/${academyB}/communication-settings`,
        ok: 200,
        tier: 'managing',
      },
      { path: `/academies/${academyB}/courses`, ok: 200, tier: 'staff' },
      { path: `/academies/${academyB}/courses/${courseB}`, ok: 200, tier: 'staff' },
      { path: `/academies/${academyB}/course-categories`, ok: 200, tier: 'staff' },
      {
        path: `/academies/${academyB}/course-categories/${categoryB}`,
        ok: 200,
        tier: 'staff',
      },
      { path: `/academies/${academyB}/media`, ok: 200, tier: 'staff' },
      { path: `/academies/${academyB}/media/${mediaB}`, ok: 200, tier: 'staff' },
      { path: `/academies/${academyB}/live-sessions/status`, ok: 200, tier: 'teaching' },
      {
        path: `/academies/${academyB}/courses/${courseB}/live-sessions`,
        ok: 200,
        tier: 'teaching',
      },
      // No live session is seeded: an authorized caller passes the guard
      // and reaches the service's own 404; an unauthorized one never does.
      {
        path: `/academies/${academyB}/live-sessions/${randomUUID()}`,
        ok: 404,
        tier: 'teaching',
      },
      // `GET :id/live-sessions/connection` is not listed: the
      // `:id/live-sessions/:liveSessionId` route above shadows it (it answers
      // 404 for "connection" as a session id), so it is unreachable today.
      { path: `/academies/${academyB}/me`, ok: 200, tier: 'staff' },
    ];
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('authorization matrix over every fixed endpoint (academy B)', () => {
    it('the manager of ANOTHER academy in the same organization is refused everywhere', async () => {
      for (const endpoint of endpoints) {
        const res = await get(managerOfA, endpoint.path);
        expect({ path: endpoint.path, status: res.status }).toEqual({
          path: endpoint.path,
          status: 403,
        });
        // The draft course title must never leak in an error body.
        expect(JSON.stringify(res.body)).not.toContain('W5 Draft Course B');
      }
    });

    it('the organization owner (no academy_members row) is admitted everywhere', async () => {
      for (const endpoint of endpoints) {
        const res = await get(owner, endpoint.path);
        expect({ path: endpoint.path, status: res.status }).toEqual({
          path: endpoint.path,
          status: endpoint.ok,
        });
      }
    });

    it('an INACTIVE member of the academy is refused everywhere', async () => {
      for (const endpoint of endpoints) {
        const res = await get(inactiveManagerOfB, endpoint.path);
        expect({ path: endpoint.path, status: res.status }).toEqual({
          path: endpoint.path,
          status: 403,
        });
      }
    });

    it("the academy's own manager is admitted everywhere", async () => {
      for (const endpoint of endpoints) {
        const res = await get(managerOfB, endpoint.path);
        expect({ path: endpoint.path, status: res.status }).toEqual({
          path: endpoint.path,
          status: endpoint.ok,
        });
      }
    });

    it("the academy's instructor reaches the staff/teaching tiers but not the managing tier", async () => {
      for (const endpoint of endpoints) {
        const res = await get(instructorOfB, endpoint.path);
        const expected = endpoint.tier === 'managing' ? 403 : endpoint.ok;
        expect({ path: endpoint.path, status: res.status }).toEqual({
          path: endpoint.path,
          status: expected,
        });
      }
    });

    it('the course list content itself is scoped: B data is returned only to B callers', async () => {
      const ownerList = await get(owner, `/academies/${academyB}/courses`).expect(200);
      expect(
        (ownerList.body.items as { id: string }[]).some(
          (course) => course.id === courseB,
        ),
      ).toBe(true);
      const managerAList = await get(managerOfA, `/academies/${academyA}/courses`).expect(
        200,
      );
      expect(
        (managerAList.body.items as { id: string }[]).some(
          (course) => course.id === courseB,
        ),
      ).toBe(false);
    });
  });

  describe('revocation is immediate (no cached role)', () => {
    it('a member flipped to inactive is refused on the very next request, and restored when re-activated', async () => {
      const member = await signUpAndSignIn(app, 'w5-revoked');
      await seedMembership(admin, organizationId, member.userId, 'manager');
      const row = await seedAcademyMember(admin, academyB, member.userId, 'manager');

      await get(member, `/academies/${academyB}/me`).expect(200);
      await get(member, `/academies/${academyB}/courses`).expect(200);

      await admin.academyMember.update({
        where: { id: row.id },
        data: { status: 'inactive' },
      });
      await get(member, `/academies/${academyB}/me`).expect(403);
      await get(member, `/academies/${academyB}/courses`).expect(403);

      await admin.academyMember.update({
        where: { id: row.id },
        data: { status: 'active' },
      });
      await get(member, `/academies/${academyB}/me`).expect(200);

      await admin.academyMember.delete({ where: { id: row.id } });
      await get(member, `/academies/${academyB}/me`).expect(403);
    });
  });

  describe('GET /academies — only the academies the caller staffs', () => {
    const list = (caller: Caller) =>
      get(caller, `/academies?organizationId=${organizationId}&pageSize=100`).expect(200);
    const ids = (body: { items: { id: string }[] }) => body.items.map((item) => item.id);

    it('the organization owner sees every academy of the organization, as owner', async () => {
      const res = await list(owner);
      expect(ids(res.body)).toEqual(expect.arrayContaining([academyA, academyB]));
      expect(res.body.pagination.totalItems).toBe(2);
      for (const item of res.body.items as { viewerRole?: string }[]) {
        expect(item.viewerRole).toBe('owner');
      }
    });

    it('the manager of A sees only A, with their role', async () => {
      const res = await list(managerOfA);
      expect(ids(res.body)).toEqual([academyA]);
      expect(res.body.pagination.totalItems).toBe(1);
      expect(res.body.items[0].viewerRole).toBe('manager');
    });

    it('an inactive member does not see the academy at all', async () => {
      const res = await list(inactiveManagerOfB);
      expect(ids(res.body)).toEqual([]);
      expect(res.body.pagination.totalItems).toBe(0);
    });

    it('an outsider is refused', async () => {
      const outsider = await signUpAndSignIn(app, 'w5-outsider');
      await get(outsider, `/academies?organizationId=${organizationId}`).expect(403);
    });
  });

  describe('GET /academies/:id/me', () => {
    it('owner: role owner from the organization, owner permissions, the academy summary', async () => {
      const res = await get(owner, `/academies/${academyB}/me`).expect(200);
      expect(res.body).toMatchObject({
        academy: {
          id: academyB,
          organizationId,
          name: expect.stringContaining('w5-academy-b'),
        },
        role: 'owner',
        roleSource: 'organization_owner',
      });
      expect(res.body.permissions).toEqual(
        expect.arrayContaining(['tenant.dashboard.view']),
      );
    });

    it('manager of B: role manager from the academy membership, no tenant.* permissions', async () => {
      const res = await get(managerOfB, `/academies/${academyB}/me`).expect(200);
      expect(res.body).toMatchObject({
        academy: { id: academyB },
        role: 'manager',
        roleSource: 'academy_membership',
      });
      expect(res.body.permissions).toEqual(expect.arrayContaining(['course.view']));
      expect(
        (res.body.permissions as string[]).some((permission) =>
          permission.startsWith('tenant.'),
        ),
      ).toBe(false);
    });

    it('instructor of B: instructor permissions only', async () => {
      const res = await get(instructorOfB, `/academies/${academyB}/me`).expect(200);
      expect(res.body.role).toBe('instructor');
      expect(res.body.permissions).not.toContain('course.manage');
      expect(res.body.permissions).toContain('instructor.dashboard.view');
    });

    it('a deleted (archived) academy answers 404 errors.academy.notFound', async () => {
      const doomed = (await seedAcademy(admin, organizationId, 'w5-doomed')).id;
      await get(owner, `/academies/${doomed}/me`).expect(200);
      await admin.academy.update({
        where: { id: doomed },
        data: { status: 'archived', archivedAt: new Date() },
      });
      const res = await get(owner, `/academies/${doomed}/me`).expect(404);
      expect(messageKeyOf(res.body)).toBe('errors.academy.notFound');
    });

    it('manager of A asking about B, and an unknown academy id, get the same 403', async () => {
      const crossAcademy = await get(managerOfA, `/academies/${academyB}/me`).expect(403);
      const unknown = await get(managerOfA, `/academies/${randomUUID()}/me`).expect(403);
      expect(messageKeyOf(crossAcademy.body)).toBe('errors.tenancy.notAMember');
      expect(messageKeyOf(unknown.body)).toBe('errors.tenancy.notAMember');
    });
  });
});
