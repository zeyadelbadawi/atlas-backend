/**
 * Live Sessions — course-scoped management (real Postgres, RLS enforced).
 *
 * The management routes used to accept ANY teaching-tier academy role for
 * EVERY course: an instructor of course X could schedule, reschedule,
 * cancel, read the attendance (participant names and emails) of, and make
 * themselves the host of a session belonging to course Y in the same
 * academy — and the join path then treated them as Y's host.
 *
 * The rule pinned here:
 *   - the academy's owner/administrator/manager (and the organization
 *     owner) manage every course's sessions in their academy;
 *   - an instructor manages only the sessions of a course they are
 *     assigned to (`course_instructors`); another course's session is the
 *     same 404 as a session that does not exist (the codebase's "not
 *     yours" convention, `assertCanAuthorCourseContent`);
 *   - a host must be a managing-tier member, the organization owner, or an
 *     instructor assigned to THAT course.
 *
 * Every staff actor carries BOTH the organization membership and the
 * academy membership the real grant writes, so a refusal here is this
 * rule, never an incidental guard rejection one layer up.
 *
 * The add-on gate is stubbed to "usable": it has its own coverage
 * (`add-on-access`/`live-session.service` unit specs), and the real
 * `live-sessions` catalog row is a shared, `coming_soon` platform row this
 * suite must not flip for everyone else. Everything else — guards,
 * services, RLS — is the real application.
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
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { AddOnAccessService } from '../src/live-sessions/services/add-on-access.service';

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

const START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 60 * 60 * 1000);

describe('Live Sessions — course-scoped management (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  let owner: Caller;
  let manager: Caller;
  let instructorX: Caller;
  let instructorY: Caller;
  let academyId: string;
  let courseX: string;
  let courseY: string;

  const http = () => request(app.getHttpServer());
  const bearer = (caller: Caller) => ({ Authorization: `Bearer ${caller.accessToken}` });

  function createSession(
    caller: Caller,
    courseId: string,
    extra: Record<string, unknown> = {},
  ) {
    return http()
      .post(`/academies/${academyId}/courses/${courseId}/live-sessions`)
      .set(bearer(caller))
      .send({
        title: 'Live class',
        scheduledStartAt: START.toISOString(),
        scheduledEndAt: END.toISOString(),
        ...extra,
      });
  }

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder.overrideProvider(AddOnAccessService).useValue({
          assertUsable: async () => undefined,
          describe: async () => ({ usable: true, entitled: true }),
        }),
    });
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();

    owner = await signUpAndSignIn(app, 'lscs-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'lscs-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'lscs-sub');
    academyId = (await seedAcademy(admin, org.id, 'lscs-academy')).id;
    await seedAcademyMember(admin, academyId, owner.userId, 'owner');
    courseX = (await seedCourse(admin, academyId, 'LSCS Course X')).id;
    courseY = (await seedCourse(admin, academyId, 'LSCS Course Y')).id;

    manager = await signUpAndSignIn(app, 'lscs-manager');
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academyId, manager.userId, 'manager');

    instructorX = await signUpAndSignIn(app, 'lscs-instructor-x');
    await seedMembership(admin, org.id, instructorX.userId, 'instructor');
    await seedAcademyMember(admin, academyId, instructorX.userId, 'instructor');
    await seedCourseInstructor(admin, courseX, instructorX.userId);

    instructorY = await signUpAndSignIn(app, 'lscs-instructor-y');
    await seedMembership(admin, org.id, instructorY.userId, 'instructor');
    await seedAcademyMember(admin, academyId, instructorY.userId, 'instructor');
    await seedCourseInstructor(admin, courseY, instructorY.userId);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('an instructor manages their OWN course: create (hosting by default), list, read, reschedule, cancel, read attendance', async () => {
    const created = await createSession(instructorX, courseX).expect(201);
    const sessionId = created.body.id as string;
    const stored = await admin.liveSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(stored.hostUserId).toBe(instructorX.userId);

    const list = await http()
      .get(`/academies/${academyId}/courses/${courseX}/live-sessions`)
      .set(bearer(instructorX))
      .expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).toContain(sessionId);

    await http()
      .get(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .expect(200);

    const later = new Date(START.getTime() + 2 * 60 * 60 * 1000);
    await http()
      .patch(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .send({
        scheduledStartAt: later.toISOString(),
        scheduledEndAt: new Date(later.getTime() + 60 * 60 * 1000).toISOString(),
      })
      .expect(200);

    await http()
      .get(`/academies/${academyId}/live-sessions/${sessionId}/attendance`)
      .set(bearer(instructorX))
      .expect(200);

    await http()
      .patch(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .send({ status: 'cancelled' })
      .expect(200);
    const row = await admin.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.status).toBe('cancelled');
  });

  it('an instructor of course X cannot create a session on course Y (404, nothing written)', async () => {
    const before = await admin.liveSession.count({ where: { courseId: courseY } });
    await createSession(instructorX, courseY).expect(404);
    expect(await admin.liveSession.count({ where: { courseId: courseY } })).toBe(before);
  });

  it("an instructor of course X cannot list, read, update, reschedule, cancel, reorder, publish or read the attendance of course Y's session", async () => {
    const created = await createSession(instructorY, courseY).expect(201);
    const sessionId = created.body.id as string;

    await http()
      .get(`/academies/${academyId}/courses/${courseY}/live-sessions`)
      .set(bearer(instructorX))
      .expect(404);
    await http()
      .get(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .expect(404);
    await http()
      .patch(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .send({ title: 'Hijacked' })
      .expect(404);
    const later = new Date(START.getTime() + 3 * 60 * 60 * 1000);
    await http()
      .patch(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .send({
        scheduledStartAt: later.toISOString(),
        scheduledEndAt: new Date(later.getTime() + 60 * 60 * 1000).toISOString(),
      })
      .expect(404);
    await http()
      .patch(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .send({ status: 'cancelled' })
      .expect(404);
    await http()
      .patch(`/academies/${academyId}/live-sessions/${sessionId}/order`)
      .set(bearer(instructorX))
      .send({ order: 5 })
      .expect(404);
    await http()
      .post(`/academies/${academyId}/live-sessions/${sessionId}/publish`)
      .set(bearer(instructorX))
      .expect(404);
    await http()
      .get(`/academies/${academyId}/live-sessions/${sessionId}/attendance`)
      .set(bearer(instructorX))
      .expect(404);

    const row = await admin.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.title).toBe('Live class');
    expect(row.status).toBe('draft');
    expect(row.order).toBe(created.body.order);
    expect(row.scheduledStartAt.getTime()).toBe(START.getTime());
    expect(row.hostUserId).toBe(instructorY.userId);
  });

  it("an instructor of course X cannot make themselves the host of course Y's session", async () => {
    const created = await createSession(instructorY, courseY).expect(201);
    const sessionId = created.body.id as string;

    await http()
      .patch(`/academies/${academyId}/live-sessions/${sessionId}`)
      .set(bearer(instructorX))
      .send({ hostUserId: instructorX.userId })
      .expect(404);

    const row = await admin.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.hostUserId).toBe(instructorY.userId);
  });

  it('a host must be able to run THIS course: an instructor of another course is refused as host, by anyone', async () => {
    // instructor Y assigning instructor X (not assigned to Y) as host of Y.
    await createSession(instructorY, courseY, { hostUserId: instructorX.userId }).expect(
      400,
    );
    // Even the owner cannot hand course Y's session to course X's instructor.
    await createSession(owner, courseY, { hostUserId: instructorX.userId }).expect(400);

    const created = await createSession(owner, courseY, {
      hostUserId: instructorY.userId,
    }).expect(201);
    const stored = await admin.liveSession.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.hostUserId).toBe(instructorY.userId);

    await http()
      .patch(`/academies/${academyId}/live-sessions/${created.body.id}`)
      .set(bearer(owner))
      .send({ hostUserId: instructorX.userId })
      .expect(400);
    // A managing-tier member may host any course.
    await http()
      .patch(`/academies/${academyId}/live-sessions/${created.body.id}`)
      .set(bearer(instructorY))
      .send({ hostUserId: manager.userId })
      .expect(200);
    const row = await admin.liveSession.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.hostUserId).toBe(manager.userId);
  });

  it('a manager manages every course of the academy: both courses, update, attendance, cancel', async () => {
    const onX = await createSession(manager, courseX).expect(201);
    const onY = await createSession(instructorY, courseY).expect(201);

    for (const courseId of [courseX, courseY]) {
      await http()
        .get(`/academies/${academyId}/courses/${courseId}/live-sessions`)
        .set(bearer(manager))
        .expect(200);
    }
    await http()
      .patch(`/academies/${academyId}/live-sessions/${onY.body.id}`)
      .set(bearer(manager))
      .send({ title: 'Renamed by manager' })
      .expect(200);
    await http()
      .get(`/academies/${academyId}/live-sessions/${onY.body.id}/attendance`)
      .set(bearer(manager))
      .expect(200);
    await http()
      .patch(`/academies/${academyId}/live-sessions/${onX.body.id}`)
      .set(bearer(manager))
      .send({ status: 'cancelled' })
      .expect(200);

    // ...and the instructor of X still cannot reach Y's session the manager edited.
    await http()
      .get(`/academies/${academyId}/live-sessions/${onY.body.id}`)
      .set(bearer(instructorX))
      .expect(404);
  });

  it("a course assignment is re-read on every request: un-assigning instructor Y ends their access to Y's sessions at once", async () => {
    const instructorZ = await signUpAndSignIn(app, 'lscs-instructor-z');
    const org = await admin.academy.findUniqueOrThrow({ where: { id: academyId } });
    await seedMembership(admin, org.organizationId, instructorZ.userId, 'instructor');
    await seedAcademyMember(admin, academyId, instructorZ.userId, 'instructor');
    await seedCourseInstructor(admin, courseY, instructorZ.userId);

    const created = await createSession(instructorZ, courseY).expect(201);
    await http()
      .get(`/academies/${academyId}/live-sessions/${created.body.id}`)
      .set(bearer(instructorZ))
      .expect(200);

    await http()
      .delete(
        `/academies/${academyId}/courses/${courseY}/instructors/${instructorZ.userId}`,
      )
      .set(bearer(owner))
      .expect((res) => {
        if (res.status !== 200 && res.status !== 204) {
          throw new Error(`unassign failed: ${res.status} ${JSON.stringify(res.body)}`);
        }
      });

    await http()
      .get(`/academies/${academyId}/live-sessions/${created.body.id}`)
      .set(bearer(instructorZ))
      .expect(404);
    await http()
      .patch(`/academies/${academyId}/live-sessions/${created.body.id}`)
      .set(bearer(instructorZ))
      .send({ title: 'After removal' })
      .expect(404);
  });
});
