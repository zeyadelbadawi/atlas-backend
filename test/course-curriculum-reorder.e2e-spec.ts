/**
 * Course curriculum reordering — concurrency, consistency and authorization
 * (Task 8). Covers the unified unit item reorder (`…/items/order`), the
 * section reorder, the legacy lessons-only reorder and lesson creation's
 * append position, all against the shared per-unit ordinal space.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAssignment,
  seedCourse,
  seedCourseInstructor,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
  seedQuiz,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(app: INestApplication, label: string) {
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

describe('Course curriculum — reorder concurrency & consistency (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ids = (body: { id: string }[]) => body.map((i) => i.id);

  async function arrange(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-acad`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course`);
    const unit = await seedCourseSection(admin, course.id, 'Unit 1', 0);
    // Lesson @0, quiz @1, assignment @2 — one shared ordinal space.
    const lesson = await seedCourseLesson(admin, unit.id, course.id, 'L', 0);
    const quiz = await seedQuiz(admin, course.id, 'Q', { sectionId: unit.id });
    await admin.quiz.update({ where: { id: quiz.id }, data: { order: 1 } });
    const assignment = await seedAssignment(admin, course.id, 'A', {
      sectionId: unit.id,
    });
    await admin.assignment.update({ where: { id: assignment.id }, data: { order: 2 } });
    const base = `/academies/${academy.id}/courses/${course.id}`;
    const items = `${base}/sections/${unit.id}/items`;
    return { owner, org, academy, course, unit, lesson, quiz, assignment, base, items };
  }

  it('items/order persists a mixed-type reorder, writes an audit entry, and survives a re-read', async () => {
    const { owner, unit, lesson, quiz, assignment, items } = await arrange('ro-happy');

    await request(app.getHttpServer())
      .patch(`${items}/order`)
      .set(auth(owner.accessToken))
      .send({
        orderedIds: [assignment.id, lesson.id, quiz.id],
        expectedOrderedIds: [lesson.id, quiz.id, assignment.id],
      })
      .expect(204);

    const reread = await request(app.getHttpServer())
      .get(items)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(ids(reread.body)).toEqual([assignment.id, lesson.id, quiz.id]);
    expect(reread.body.map((i: { order: number }) => i.order)).toEqual([0, 1, 2]);

    const audit = await admin.auditLogEntry.findFirst({
      where: { action: 'course.curriculum.items_reordered', targetId: unit.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(owner.userId);
    expect(audit?.changes).toEqual({
      order: {
        from: [lesson.id, quiz.id, assignment.id],
        to: [assignment.id, lesson.id, quiz.id],
      },
    });
  });

  it('items/order rejects a non-permutation (missing, extra, duplicate) with 400 and changes nothing', async () => {
    const { owner, lesson, quiz, assignment, items } = await arrange('ro-perm');
    const bad = [
      [lesson.id, quiz.id], // missing
      [lesson.id, quiz.id, assignment.id, 'not-a-real-id'], // extra
    ];
    for (const orderedIds of bad) {
      await request(app.getHttpServer())
        .patch(`${items}/order`)
        .set(auth(owner.accessToken))
        .send({ orderedIds })
        .expect(400);
    }
    // Duplicates are refused by the DTO itself.
    await request(app.getHttpServer())
      .patch(`${items}/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [lesson.id, lesson.id, quiz.id] })
      .expect(400);

    const reread = await request(app.getHttpServer())
      .get(items)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(ids(reread.body)).toEqual([lesson.id, quiz.id, assignment.id]);
  });

  it('items/order rejects an item from another unit, another course and another academy', async () => {
    const a = await arrange('ro-foreign');
    // Another unit in the same course.
    const unit2 = await seedCourseSection(admin, a.course.id, 'Unit 2', 1);
    const otherUnitLesson = await seedCourseLesson(admin, unit2.id, a.course.id, 'X', 0);
    // Another course in the same academy.
    const course2 = await seedCourse(admin, a.academy.id, 'ro-foreign-c2');
    const c2unit = await seedCourseSection(admin, course2.id, 'C2U', 0);
    const otherCourseLesson = await seedCourseLesson(
      admin,
      c2unit.id,
      course2.id,
      'Y',
      0,
    );
    // Another academy entirely.
    const b = await arrange('ro-foreign-b');

    for (const foreign of [otherUnitLesson.id, otherCourseLesson.id, b.lesson.id]) {
      await request(app.getHttpServer())
        .patch(`${a.items}/order`)
        .set(auth(a.owner.accessToken))
        .send({ orderedIds: [a.lesson.id, a.quiz.id, a.assignment.id, foreign] })
        .expect(400);
      // Swapping one of ours for a foreign id (same length) is refused too.
      await request(app.getHttpServer())
        .patch(`${a.items}/order`)
        .set(auth(a.owner.accessToken))
        .send({ orderedIds: [a.lesson.id, a.quiz.id, foreign] })
        .expect(400);
    }

    // A unit id from another course, addressed under this course → 404.
    await request(app.getHttpServer())
      .patch(`${a.base}/sections/${c2unit.id}/items/order`)
      .set(auth(a.owner.accessToken))
      .send({ orderedIds: [otherCourseLesson.id] })
      .expect(404);

    // Another academy's owner cannot reorder this unit at all.
    await request(app.getHttpServer())
      .patch(`${a.items}/order`)
      .set(auth(b.owner.accessToken))
      .send({ orderedIds: [a.assignment.id, a.quiz.id, a.lesson.id] })
      .expect((r) => {
        if (![403, 404].includes(r.status)) {
          throw new Error(`expected 403/404, got ${r.status}`);
        }
      });
    // …nor by addressing it through their own academy path.
    await request(app.getHttpServer())
      .patch(`${b.base}/sections/${a.unit.id}/items/order`)
      .set(auth(b.owner.accessToken))
      .send({ orderedIds: [a.assignment.id, a.quiz.id, a.lesson.id] })
      .expect(404);

    const db = await admin.courseLesson.findUnique({ where: { id: a.lesson.id } });
    expect(db?.order).toBe(0);
  });

  it('only an assigned instructor may reorder: unassigned instructor gets 403, assigned succeeds', async () => {
    const { academy, course, lesson, quiz, assignment, items, base } =
      await arrange('ro-instr');
    const unassigned = await signUpAndSignIn(app, 'ro-instr-unassigned');
    await seedAcademyMember(admin, academy.id, unassigned.userId, 'instructor');

    await request(app.getHttpServer())
      .patch(`${items}/order`)
      .set(auth(unassigned.accessToken))
      .send({ orderedIds: [quiz.id, lesson.id, assignment.id] })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`${base}/sections/order`)
      .set(auth(unassigned.accessToken))
      .send({
        orderedIds: [
          (await admin.courseSection.findFirst({ where: { courseId: course.id } }))!.id,
        ],
      })
      .expect(403);

    const assigned = await signUpAndSignIn(app, 'ro-instr-assigned');
    await seedAcademyMember(admin, academy.id, assigned.userId, 'instructor');
    await seedCourseInstructor(admin, course.id, assigned.userId);
    await request(app.getHttpServer())
      .patch(`${items}/order`)
      .set(auth(assigned.accessToken))
      .send({ orderedIds: [quiz.id, lesson.id, assignment.id] })
      .expect(204);
  });

  it('refuses a reorder built on a stale view with 409 stale_resource_version (items and sections)', async () => {
    const { owner, course, unit, lesson, quiz, assignment, items, base } =
      await arrange('ro-stale');

    // Someone else reorders first.
    await request(app.getHttpServer())
      .patch(`${items}/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [quiz.id, lesson.id, assignment.id] })
      .expect(204);

    // A client still holding the original order is refused, not applied.
    const stale = await request(app.getHttpServer())
      .patch(`${items}/order`)
      .set(auth(owner.accessToken))
      .send({
        orderedIds: [lesson.id, assignment.id, quiz.id],
        expectedOrderedIds: [lesson.id, quiz.id, assignment.id],
      })
      .expect(409);
    expect(stale.body.error.code).toBe('stale_resource_version');
    expect(stale.body.error.messageKey).toBe('errors.concurrency.staleVersion');

    // A stale view that misses a newly attached item is a 409 too, not a 400.
    const late = await seedQuiz(admin, course.id, 'late');
    await request(app.getHttpServer())
      .post(`${items}/attach`)
      .set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: late.id })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`${items}/order`)
      .set(auth(owner.accessToken))
      .send({
        orderedIds: [lesson.id, quiz.id, assignment.id],
        expectedOrderedIds: [quiz.id, lesson.id, assignment.id],
      })
      .expect(409);

    const reread = await request(app.getHttpServer())
      .get(items)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(ids(reread.body)).toEqual([quiz.id, lesson.id, assignment.id, late.id]);

    // Sections: same contract.
    const unit2 = await seedCourseSection(admin, course.id, 'Unit 2', 1);
    await request(app.getHttpServer())
      .patch(`${base}/sections/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [unit2.id, unit.id], expectedOrderedIds: [unit.id, unit2.id] })
      .expect(204);
    const staleSections = await request(app.getHttpServer())
      .patch(`${base}/sections/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [unit.id, unit2.id], expectedOrderedIds: [unit.id, unit2.id] })
      .expect(409);
    expect(staleSections.body.error.code).toBe('stale_resource_version');
    const sectionAudit = await admin.auditLogEntry.findFirst({
      where: { action: 'course_section.reordered', targetId: course.id },
    });
    expect(sectionAudit).not.toBeNull();
  });

  it('createLesson appends after the last item of the unit across all types', async () => {
    const { owner, lesson, quiz, assignment, unit, base, items } =
      await arrange('ro-append');
    // Push the assignment far out so a "max lesson order + 1" bug would show.
    await admin.assignment.update({ where: { id: assignment.id }, data: { order: 7 } });

    const created = await request(app.getHttpServer())
      .post(`${base}/sections/${unit.id}/lessons`)
      .set(auth(owner.accessToken))
      .send({ title: 'Appended', contentType: 'text' })
      .expect(201);
    expect(created.body.order).toBe(8);

    const reread = await request(app.getHttpServer())
      .get(items)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(ids(reread.body)).toEqual([
      lesson.id,
      quiz.id,
      assignment.id,
      created.body.id,
    ]);
  });

  it('legacy lessons/order keeps non-lesson items in place and renumbers the unit without collisions', async () => {
    const { owner, unit, course, lesson, quiz, assignment, base, items } =
      await arrange('ro-legacy');
    const lesson2 = await seedCourseLesson(admin, unit.id, course.id, 'L2', 3);
    // Unit: L(0) Q(1) A(2) L2(3) → swap lessons via the legacy endpoint.
    await request(app.getHttpServer())
      .patch(`${base}/sections/${unit.id}/lessons/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [lesson2.id, lesson.id] })
      .expect(204);

    const reread = await request(app.getHttpServer())
      .get(items)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(ids(reread.body)).toEqual([lesson2.id, quiz.id, assignment.id, lesson.id]);
    expect(reread.body.map((i: { order: number }) => i.order)).toEqual([0, 1, 2, 3]);

    // Still refuses a non-lesson id in the lessons-only list.
    await request(app.getHttpServer())
      .patch(`${base}/sections/${unit.id}/lessons/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [lesson2.id, quiz.id] })
      .expect(400);
  });

  it('concurrent reorders serialize and always end in one consistent permutation', async () => {
    const { owner, unit, course, lesson, quiz, assignment, items } =
      await arrange('ro-race');
    const extra = await seedCourseLesson(admin, unit.id, course.id, 'L3', 3);
    const original = [lesson.id, quiz.id, assignment.id, extra.id];
    const permutations = [
      [extra.id, assignment.id, quiz.id, lesson.id],
      [quiz.id, lesson.id, extra.id, assignment.id],
      [assignment.id, extra.id, lesson.id, quiz.id],
      [lesson.id, extra.id, quiz.id, assignment.id],
    ];

    // Last-write-wins clients (no expectedOrderedIds): all succeed, and the
    // final state is exactly ONE of the submitted permutations, contiguous.
    const results = await Promise.all(
      permutations.map((orderedIds) =>
        request(app.getHttpServer())
          .patch(`${items}/order`)
          .set(auth(owner.accessToken))
          .send({ orderedIds }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([204, 204, 204, 204]);
    const after = await request(app.getHttpServer())
      .get(items)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(permutations.map((p) => p.join())).toContain(ids(after.body).join());
    expect(after.body.map((i: { order: number }) => i.order)).toEqual([0, 1, 2, 3]);

    // Clients that all saw the same order: exactly one wins, the rest 409.
    const seen = ids(after.body);
    const contenders = permutations.filter((p) => p.join() !== seen.join());
    const raced = await Promise.all(
      contenders.map((orderedIds) =>
        request(app.getHttpServer())
          .patch(`${items}/order`)
          .set(auth(owner.accessToken))
          .send({ orderedIds, expectedOrderedIds: seen }),
      ),
    );
    const statuses = raced.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 204)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(contenders.length - 1);
    const winner = contenders[raced.findIndex((r) => r.status === 204)];
    const final = await request(app.getHttpServer())
      .get(items)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(ids(final.body)).toEqual(winner);
    expect(new Set(ids(final.body))).toEqual(new Set(original));
  });
});
