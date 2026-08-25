/**
 * Instructor Operations e2e suite (master plan §21 Phase P7, §10). Exercises
 * `InstructorController`'s real HTTP surface — dashboard, teaching courses,
 * course overview, roster, student progress, quiz-attempt roster,
 * submission review, and grading. Includes the mandatory master plan §18
 * scenario 5 test: an instructor not assigned to a course cannot grade its
 * submissions, regardless of the course id supplied.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAssignment,
  seedCourse,
  seedCourseInstructor,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
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

describe('Instructor Operations (e2e)', () => {
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

  async function seedTeachingFixture(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const instructor = await signUpAndSignIn(app, `${label}-instr`);
    const student = await signUpAndSignIn(app, `${label}-student`);

    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    await seedCourseInstructor(admin, course.id, instructor.userId);

    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const assignment = await seedAssignment(admin, course.id, `${label} assignment`, {
      status: 'published',
    });
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ response: 'My real answer.' })
      .expect(201);

    return { owner, instructor, student, org, academy, course, assignment };
  }

  it('an unassigned instructor gets an empty dashboard and an empty teaching-course list', async () => {
    const outsider = await signUpAndSignIn(app, 'instr-outsider');

    const dashboard = await request(app.getHttpServer())
      .get('/instructor/dashboard')
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(200);
    expect(dashboard.body).toMatchObject({ assignedCoursesCount: 0, totalStudents: 0 });

    const courses = await request(app.getHttpServer())
      .get('/instructor/courses')
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(200);
    expect(courses.body.items).toEqual([]);
  });

  it('the real instructor sees the course in their dashboard/teaching-course list, with a real enrolled-student count', async () => {
    const { instructor, course } = await seedTeachingFixture('instr-dash');

    const dashboard = await request(app.getHttpServer())
      .get('/instructor/dashboard')
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(dashboard.body.assignedCoursesCount).toBe(1);
    expect(dashboard.body.totalStudents).toBe(1);
    expect(dashboard.body.pendingGradingCount).toBe(1);

    const courses = await request(app.getHttpServer())
      .get('/instructor/courses')
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(courses.body.items.map((c: { courseId: string }) => c.courseId)).toContain(
      course.id,
    );
  });

  it('the course overview reports a real enrolled-student count and pending-grading count', async () => {
    const { instructor, course } = await seedTeachingFixture('instr-overview');

    const overview = await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(overview.body).toMatchObject({
      courseId: course.id,
      enrolledCount: 1,
      pendingGradingCount: 1,
    });
  });

  it('the course roster lists the real enrolled student', async () => {
    const { instructor, student, course } = await seedTeachingFixture('instr-roster');

    const roster = await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}/students`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(roster.body.items).toHaveLength(1);
    expect(roster.body.items[0].studentId).toBe(student.userId);
  });

  it('an instructor not assigned to the course gets 404 for the roster, not the real data', async () => {
    const { course } = await seedTeachingFixture('instr-roster-denied');
    const outsider = await signUpAndSignIn(app, 'instr-roster-denied-outsider');

    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}/students`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(404);
  });

  it('the instructor can list and view submissions, then grade one — score/feedback persist and gradingStatus flips to graded', async () => {
    const { instructor, student, course, assignment } =
      await seedTeachingFixture('instr-grade');

    const list = await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}/assignments/${assignment.id}/submissions`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    const submissionId = list.body.items[0].id;
    expect(list.body.items[0].studentName).toBeTruthy();
    expect(list.body.items[0].gradingStatus).toBe('ungraded');

    const detail = await request(app.getHttpServer())
      .get(
        `/instructor/courses/${course.id}/assignments/${assignment.id}/submissions/${submissionId}`,
      )
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(detail.body.studentId).toBe(student.userId);

    const graded = await request(app.getHttpServer())
      .post(
        `/instructor/courses/${course.id}/assignments/${assignment.id}/submissions/${submissionId}/grade`,
      )
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .send({ score: 88, feedback: 'Solid work.' })
      .expect(201);
    expect(graded.body.gradingStatus).toBe('graded');
    expect(graded.body.grade).toMatchObject({ score: 88, feedback: 'Solid work.' });

    // A student's own, existing (P6) submission read never gains grading fields.
    const studentView = await request(app.getHttpServer())
      .get(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(studentView.body).not.toHaveProperty('grade');
    expect(studentView.body).not.toHaveProperty('gradingStatus');
  });

  it('master plan §18 scenario 5: an instructor NOT assigned to Course X cannot grade its submissions, regardless of which course id is supplied', async () => {
    const { course, assignment } = await seedTeachingFixture('instr-scenario5-target');
    const listResp = await admin.assignmentSubmission.findFirstOrThrow({
      where: { assignmentId: assignment.id },
    });

    const unassignedInstructor = await signUpAndSignIn(app, 'instr-scenario5-outsider');
    // Give the outsider a real teaching assignment on an UNRELATED course,
    // so this proves "not assigned to Course X specifically", not merely
    // "never an instructor of anything".
    const otherOrg = await seedOrganizationWithOwner(
      admin,
      unassignedInstructor.userId,
      'instr-scenario5-other-org',
    );
    const otherAcademy = await seedAcademy(
      admin,
      otherOrg.id,
      'instr-scenario5-other-academy',
    );
    const otherCourse = await seedCourse(
      admin,
      otherAcademy.id,
      'instr-scenario5-other-course',
      {
        status: 'published',
        visibility: 'public',
      },
    );
    await seedCourseInstructor(admin, otherCourse.id, unassignedInstructor.userId);

    // Attempt 1: grade via Course X's real id — must fail.
    await request(app.getHttpServer())
      .post(
        `/instructor/courses/${course.id}/assignments/${assignment.id}/submissions/${listResp.id}/grade`,
      )
      .set('Authorization', `Bearer ${unassignedInstructor.accessToken}`)
      .send({ score: 100 })
      .expect(404);

    // Attempt 2: the same submission id, addressed via the outsider's OWN
    // (unrelated) course id — must still fail, never resolve cross-course.
    await request(app.getHttpServer())
      .post(
        `/instructor/courses/${otherCourse.id}/assignments/${assignment.id}/submissions/${listResp.id}/grade`,
      )
      .set('Authorization', `Bearer ${unassignedInstructor.accessToken}`)
      .send({ score: 100 })
      .expect(404);

    // The submission is genuinely still ungraded — no partial/side-effect write occurred.
    const stillUngraded = await admin.assignmentSubmission.findUniqueOrThrow({
      where: { id: listResp.id },
    });
    expect(stillUngraded.gradingStatus).toBe('ungraded');
  });

  it('the quiz-attempt roster lists every student real attempt for a course quiz the instructor teaches', async () => {
    const { instructor, student, course } =
      await seedTeachingFixture('instr-quiz-roster');
    const quiz = await seedQuiz(admin, course.id, 'Quiz', { status: 'published' });
    const question = await seedQuizQuestion(admin, quiz.id, 'Q?', 'single_choice', 0);
    const option = await seedQuizQuestionOption(admin, question.id, 'A', true);

    const attempt = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${attempt.body.id}/submit`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ answers: [{ questionId: question.id, selectedOptionIds: [option.id] }] })
      .expect(201);

    const roster = await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(roster.body.items).toHaveLength(1);
    expect(roster.body.items[0].studentName).toBeTruthy();
    // Never leaks the correctness flag — same P6 contract, still respected here.
    expect(JSON.stringify(roster.body)).not.toContain('isCorrect');
  });

  it('an instructor reuses the real P6 QuizService/AssignmentService read endpoints for a DRAFT course they teach (frontend reuse contract)', async () => {
    const owner = await signUpAndSignIn(app, 'instr-draft-owner');
    const instructor = await signUpAndSignIn(app, 'instr-draft-instr');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'instr-draft-org');
    const academy = await seedAcademy(admin, org.id, 'instr-draft-academy');
    const draftCourse = await seedCourse(admin, academy.id, 'instr-draft-course', {
      status: 'draft',
      visibility: 'private',
    });
    await seedCourseInstructor(admin, draftCourse.id, instructor.userId);
    const assignment = await seedAssignment(admin, draftCourse.id, 'Draft assignment', {
      status: 'published',
    });

    const assignments = await request(app.getHttpServer())
      .get(`/courses/${draftCourse.id}/assignments`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(assignments.body.items.map((a: { id: string }) => a.id)).toContain(
      assignment.id,
    );

    // A student who is neither enrolled nor an instructor still can't reach it.
    const outsider = await signUpAndSignIn(app, 'instr-draft-outsider');
    await request(app.getHttpServer())
      .get(`/courses/${draftCourse.id}/assignments`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(404);
  });
});
