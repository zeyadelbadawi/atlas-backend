/**
 * Learner exceptions — W-EXC, end to end against real Postgres with FORCE
 * RLS, the real `AppModule` and the real outbox.
 *
 * A `QuizStudentOverride` is an accommodation granted to ONE student on
 * ONE quiz. Until this change it emitted nothing, so the person it exists
 * for was never told. Three claims need a database to prove, and none of
 * them can be proved by a unit test:
 *
 *  1. THE RIGHT PERSON, AND ONLY THEM. The recipient is the override's own
 *     `studentId`, read server-side. Every case below asserts that a
 *     SECOND learner in the same academy and a learner in a DIFFERENT
 *     academy receive nothing at all — because "told the wrong learner
 *     they have extra time" is the failure that matters here, and a spec
 *     that only checks the intended recipient cannot see it.
 *  2. THE SCHEDULED MESSAGE IS A DIFFERENT MESSAGE. One catalogue key,
 *     two copies. The scheduled one names the date and must NOT invite
 *     the learner to go and use an accommodation that is not open yet.
 *  3. THE SWEEP SENDS ONCE. The activation job re-asks the same question
 *     every five minutes forever; the dedupe key is the transition
 *     instant, not the tick. This suite ticks it repeatedly and asserts
 *     the row count does not move — the single most important property of
 *     the feature.
 *
 * WHY THE QUEUE IS STUBBED OUT: as in `p64-comm-events-2.e2e-spec.ts` —
 * the real worker and its 60-second sweep would claim these rows mid
 * assertion, so the processor and the scheduler (and only those two) are
 * inert, and the activation sweep and the dispatch pipeline are called
 * directly, exactly the way the processor calls them.
 *
 * THE CLOCK: `PLANS_CLOCK`, the same pinnable clock the lifecycle suites
 * use. `run(now)` also takes the instant explicitly (as
 * `TenantLifecycleService.run` does), so most cases state the instant they
 * mean; one case deliberately calls `run()` with no argument to prove the
 * injected clock is the one the production path reads.
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
  seedCourseSection,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
} from './utils/db-admin';
import { PLANS_CLOCK, type Clock } from '../src/plans/utils/clock';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { QuizExceptionActivationService } from '../src/communications/services/quiz-exception-activation.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import {
  StubEmailProvider,
  STUB_PROVIDER_NAME,
} from '../src/communications/providers/stub-email.provider';
import type {
  EmailSendInput,
  EmailSendResult,
} from '../src/identity/services/email-provider.interface';

jest.setTimeout(180000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const DISPATCH_ATTEMPT = { made: 0, max: 6 } as const;
const PASSWORD = 'correct-horse-battery';
const HOUR = 60 * 60 * 1000;

const GRANTED = 'assessment.exception.granted';
const ACTIVATED = 'assessment.exception.activated';
const REVOKED = 'assessment.exception.revoked';

/** Real time until pinned; pinned time until reset — copied from the lifecycle suite. */
class FakeClock implements Clock {
  private fixed: Date | null = null;
  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }
  set(at: Date): void {
    this.fixed = new Date(at);
  }
  reset(): void {
    this.fixed = null;
  }
}

describe('P64 W-EXC — learner exception notifications (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let dispatcher: CommunicationDispatchService;
  let activation: QuizExceptionActivationService;
  let stubEmailProvider: StubEmailProvider;
  let sent: EmailSendInput[];
  let sendSpy: jest.SpyInstance;
  const clock = new FakeClock();

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(PLANS_CLOCK)
          .useValue(clock)
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    stubEmailProvider = testApp.stubEmailProvider;
    dispatcher = app.get(CommunicationDispatchService, { strict: false });
    activation = app.get(QuizExceptionActivationService, { strict: false });

    // The sweep and the dispatcher both run under a real platform owner.
    await admin.user.create({
      data: {
        email: uniqueTestEmail('exc-platform-owner'),
        name: 'exception platform owner',
        isPlatformOwner: true,
      },
    });

    // Only OUTBOX sends count — the dispatcher tags every one with `key:`;
    // registration verification emails must not be mistaken for them.
    sent = [];
    sendSpy = jest
      .spyOn(stubEmailProvider, 'send')
      .mockImplementation(async (input: EmailSendInput) => {
        if ((input.tags ?? []).some((tag) => tag.startsWith('key:'))) sent.push(input);
        return {
          providerMessageId: `spy-${sendSpy.mock.calls.length}`,
          provider: STUB_PROVIDER_NAME,
        } satisfies EmailSendResult;
      });
  });

  /**
   * Every quiz this run seeds, so its overrides can be removed in
   * `afterAll`.
   *
   * Unusual for this suite's neighbours, which leave their fixtures
   * behind — but an exception fixture is not inert. Each one sits with a
   * near-future `available_from`, so for the next day of REAL time every
   * activation tick (this file's and anyone else's) would evaluate it.
   * Deleting the overrides costs nothing and keeps the shared development
   * database from accumulating permanent sweep work.
   */
  const seededQuizIds: string[] = [];

  afterAll(async () => {
    sendSpy.mockRestore();
    clock.reset();
    await admin.quizStudentOverride.deleteMany({
      where: { quizId: { in: seededQuizIds } },
    });
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    sent.length = 0;
    sendSpy.mockClear();
    clock.reset();
    await flushRateLimitKeys();
  });

  // --- fixtures ---------------------------------------------------------

  async function account(label: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  async function learnerAccount(label: string, academyId: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /** An academy, its owner, a published free course and one published quiz. */
  async function academyWorld(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    await seedCourseSection(admin, course.id, `${label}-s`, 0);
    const quiz = await seedQuiz(admin, course.id, `${label} unit quiz`, {
      status: 'published',
    });
    const question = await seedQuizQuestion(admin, quiz.id, 'Q?', 'single_choice', 0);
    await seedQuizQuestionOption(admin, question.id, 'A', true);
    seededQuizIds.push(quiz.id);
    return { owner, org, academy, course, quiz };
  }

  async function enrol(learner: { auth: Record<string, string> }, courseId: string) {
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(learner.auth)
      .send({ courseId })
      .expect(201);
  }

  function grant(
    world: {
      owner: { auth: Record<string, string> };
      course: { id: string };
      quiz: { id: string };
    },
    body: Record<string, unknown>,
    expected = 200,
  ) {
    return request(app.getHttpServer())
      .put(`/review/courses/${world.course.id}/quizzes/${world.quiz.id}/overrides`)
      .set(world.owner.auth)
      .send(body)
      .expect(expected);
  }

  function revoke(
    world: {
      owner: { auth: Record<string, string> };
      course: { id: string };
      quiz: { id: string };
    },
    studentId: string,
    expected = 204,
  ) {
    return request(app.getHttpServer())
      .delete(
        `/review/courses/${world.course.id}/quizzes/${world.quiz.id}/overrides/${studentId}`,
      )
      .set(world.owner.auth)
      .expect(expected);
  }

  /** Every learner-exception outbox row this person holds, oldest first. */
  function exceptionRows(userId: string, key?: string) {
    return admin.communicationOutbox.findMany({
      where: {
        recipientUserId: userId,
        key: key ?? { startsWith: 'assessment.exception.' },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  function feedRows(userId: string) {
    return admin.notification.findMany({
      where: { userId, dedupeKey: { startsWith: 'quiz_override.' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Puts one outbox row back in the state `emit` left it in, right before
   * this suite dispatches it by hand — see the same helper in
   * `p64-comm-lifecycle-sequences.e2e-spec.ts` for why (another backend
   * running against this shared database can claim the row first).
   */
  async function rearm(outboxId: string): Promise<void> {
    await admin.communicationOutbox.update({
      where: { id: outboxId },
      data: { state: 'pending', attempts: 0, availableAt: new Date(), lastError: null },
    });
    await admin.communicationDelivery.deleteMany({ where: { outboxId } });
  }

  async function deliver(outboxId: string) {
    await rearm(outboxId);
    return dispatcher.dispatch(outboxId, DISPATCH_ATTEMPT);
  }

  // =====================================================================
  // 1. granted — the learner who owns the override, and nobody else
  // =====================================================================

  describe('granting an exception that is active now', () => {
    it('tells its own student, and tells no one else at all', async () => {
      const a = await academyWorld('exc-g1');
      const b = await academyWorld('exc-g1-other');
      const mine = await learnerAccount('exc-g1-mine', a.academy.id);
      const classmate = await learnerAccount('exc-g1-classmate', a.academy.id);
      const stranger = await learnerAccount('exc-g1-stranger', b.academy.id);
      await enrol(mine, a.course.id);
      await enrol(classmate, a.course.id);
      await enrol(stranger, b.course.id);

      await grant(a, {
        studentId: mine.userId,
        timeMultiplier: 1.5,
        extraAttempts: 2,
        reason: 'Documented accommodation',
      });

      const rows = await exceptionRows(mine.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe(GRANTED);
      expect(rows[0].entityType).toBe('quiz_student_override');
      expect(rows[0].category).toBe('engagement');
      expect(rows[0].channels).toEqual({ inApp: true, email: 'preference' });
      expect(rows[0].dedupeKey).toBe(
        `quiz_override.granted:${rows[0].entityId}:${
          (rows[0].values as { grantedAtMs: number }).grantedAtMs
        }`,
      );
      const values = rows[0].values as Record<string, unknown>;
      expect(values.quizTitle).toBe(a.quiz.title);
      expect(values.scheduled).toBe(false);
      expect(values.timeMultiplier).toBe('1.5');
      expect(values.extraAttempts).toBe(2);

      // The row the message is about really is this student's.
      const override = await admin.quizStudentOverride.findUnique({
        where: { id: rows[0].entityId as string },
      });
      expect(override?.studentId).toBe(mine.userId);

      // NOBODY ELSE. Not the classmate, not another academy's learner,
      // and not the reviewer who clicked the button.
      for (const other of [
        classmate.userId,
        stranger.userId,
        a.owner.userId,
        b.owner.userId,
      ]) {
        expect(await exceptionRows(other)).toHaveLength(0);
        expect(await feedRows(other)).toHaveLength(0);
      }
    });

    it('writes the ACTIVE copy into the in-app feed', async () => {
      const a = await academyWorld('exc-g2');
      const mine = await learnerAccount('exc-g2-mine', a.academy.id);
      await enrol(mine, a.course.id);

      await grant(a, { studentId: mine.userId, timeMultiplier: 2 });

      const feed = await feedRows(mine.userId);
      expect(feed).toHaveLength(1);
      expect(feed[0].messageKey).toBe('notifications:events.exceptionGranted.message');
      expect(feed[0].titleKey).toBe('notifications:events.exceptionGranted.title');
      expect(feed[0].actionUrl).toBe(
        `/my/courses/${a.course.id}/activities/${a.quiz.id}`,
      );
    });

    it('never puts the reviewer’s private reason in front of the learner', async () => {
      const a = await academyWorld('exc-g3');
      const mine = await learnerAccount('exc-g3-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const secret = 'Student is undergoing chemotherapy this term';

      await grant(a, { studentId: mine.userId, timeMultiplier: 1.5, reason: secret });

      const rows = await exceptionRows(mine.userId);
      expect(JSON.stringify(rows[0].values)).not.toContain('chemotherapy');
      const outcome = await deliver(rows[0].id);
      expect(outcome).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].text).not.toContain(secret);
      expect(sent[0].html).not.toContain(secret);
    });

    it('re-granting the identical exception is one message, editing it is two', async () => {
      const a = await academyWorld('exc-g4');
      const mine = await learnerAccount('exc-g4-mine', a.academy.id);
      await enrol(mine, a.course.id);

      await grant(a, { studentId: mine.userId, timeMultiplier: 1.5 });
      const first = await exceptionRows(mine.userId, GRANTED);
      expect(first).toHaveLength(1);

      // An EDIT is genuinely new news — a learner planning around 1.5x
      // must be told it is now 2x.
      await grant(a, { studentId: mine.userId, timeMultiplier: 2 });
      const second = await exceptionRows(mine.userId, GRANTED);
      expect(second).toHaveLength(2);
      expect(second[1].dedupeKey).not.toBe(second[0].dedupeKey);
      expect((second[1].values as { timeMultiplier: string }).timeMultiplier).toBe('2');
    });
  });

  // =====================================================================
  // 2. granted — scheduled for later
  // =====================================================================

  describe('granting an exception scheduled for later', () => {
    it('says when it starts, and does NOT tell the learner to use it now', async () => {
      const a = await academyWorld('exc-s1');
      const mine = await learnerAccount('exc-s1-mine', a.academy.id);
      const classmate = await learnerAccount('exc-s1-classmate', a.academy.id);
      await enrol(mine, a.course.id);
      await enrol(classmate, a.course.id);

      const availableFrom = new Date(Date.now() + 2 * HOUR);
      await grant(a, {
        studentId: mine.userId,
        timeMultiplier: 1.5,
        availableFrom: availableFrom.toISOString(),
        availableUntil: new Date(Date.now() + 48 * HOUR).toISOString(),
      });

      const rows = await exceptionRows(mine.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe(GRANTED);
      const values = rows[0].values as Record<string, unknown>;
      expect(values.scheduled).toBe(true);
      expect(values.availableFromLabel).toBe(
        `${availableFrom.toISOString().slice(0, 10)} ${availableFrom
          .toISOString()
          .slice(11, 16)} UTC`,
      );

      // The feed gets the OTHER copy — same key, different sentence.
      const feed = await feedRows(mine.userId);
      expect(feed).toHaveLength(1);
      expect(feed[0].messageKey).toBe('notifications:events.exceptionScheduled.message');
      expect(feed[0].titleKey).toBe('notifications:events.exceptionScheduled.title');

      // And so does the email.
      expect(await deliver(rows[0].id)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(mine.email);
      expect(sent[0].text).toContain(values.availableFromLabel);
      expect(sent[0].text.toLowerCase()).toContain('nothing for you to do yet');
      expect(sent[0].text.toLowerCase()).not.toContain('it is active now');
      expect(sent[0].text.toLowerCase()).not.toContain('applies to your next attempt');

      expect(await exceptionRows(classmate.userId)).toHaveLength(0);
    });
  });

  // =====================================================================
  // 3. the activation sweep
  // =====================================================================

  describe('the activation sweep', () => {
    it('fires once when the window opens, and a repeated tick sends nothing', async () => {
      const a = await academyWorld('exc-a1');
      const b = await academyWorld('exc-a1-other');
      const scheduledLearner = await learnerAccount('exc-a1-mine', a.academy.id);
      const activeLearner = await learnerAccount('exc-a1-active', a.academy.id);
      const stranger = await learnerAccount('exc-a1-stranger', b.academy.id);
      await enrol(scheduledLearner, a.course.id);
      await enrol(activeLearner, a.course.id);
      await enrol(stranger, b.course.id);

      const start = Date.now();
      const availableFrom = new Date(start + 2 * HOUR);
      await grant(a, {
        studentId: scheduledLearner.userId,
        timeMultiplier: 1.5,
        extraAttempts: 1,
        availableFrom: availableFrom.toISOString(),
      });
      // A classmate with an exception that was ALREADY open — the sweep
      // must never announce an activation for one of these.
      await grant(a, { studentId: activeLearner.userId, timeMultiplier: 2 });
      // Another academy's learner, also scheduled: proves the sweep is
      // global but the MESSAGE is not.
      await grant(b, {
        studentId: stranger.userId,
        availableFrom: availableFrom.toISOString(),
      });

      // Before the window opens, nothing at all.
      //
      // Asserted on THIS learner's rows, never on the tick's global
      // counters: the sweep is genuinely global, and on a shared
      // development database it legitimately finds other fixtures' rows
      // (and dedupes them). A count of "how many rows the sweep saw" is
      // therefore not this spec's to claim.
      await tick(new Date(start + HOUR));
      expect(await exceptionRows(scheduledLearner.userId, ACTIVATED)).toHaveLength(0);

      // The window opens.
      const first = await tick(new Date(start + 3 * HOUR));
      expect(first.emitted).toBeGreaterThanOrEqual(1);
      expect(first.due).toBeGreaterThanOrEqual(2);
      const activated = await exceptionRows(scheduledLearner.userId, ACTIVATED);
      expect(activated).toHaveLength(1);
      expect(activated[0].dedupeKey).toBe(
        `quiz_override.activated:${activated[0].entityId}:${availableFrom.getTime()}`,
      );
      expect((activated[0].values as { quizTitle: string }).quizTitle).toBe(a.quiz.title);

      // THE PROPERTY. Six more ticks across the next twelve hours.
      for (let i = 1; i <= 6; i++) {
        const again = await tick(new Date(start + (3 + i * 2) * HOUR));
        // Nothing new was written on ANY tick after the first — not for
        // this learner and not for anyone else the sweep looked at.
        expect(again.emitted).toBe(0);
        expect(again.deduped).toBeGreaterThanOrEqual(2);
      }
      expect(await exceptionRows(scheduledLearner.userId, ACTIVATED)).toHaveLength(1);
      expect(
        await admin.notification.count({
          where: {
            userId: scheduledLearner.userId,
            dedupeKey: { startsWith: 'quiz_override.activated:' },
          },
        }),
      ).toBe(1);

      // The learner whose exception was open from the start is never told
      // it "became active".
      expect(await exceptionRows(activeLearner.userId, ACTIVATED)).toHaveLength(0);

      // The other academy's learner got their OWN activation and nothing
      // of this one.
      const strangerRows = await exceptionRows(stranger.userId, ACTIVATED);
      expect(strangerRows).toHaveLength(1);
      expect((strangerRows[0].values as { quizTitle: string }).quizTitle).toBe(
        b.quiz.title,
      );
    });

    it('never announces an activation for a window that was ALREADY open', async () => {
      // The case the `available_from > updated_at` guard exists for: a
      // reviewer who backdates the start. The grant message already read
      // "it is active now", so an activation notice is the same news a
      // second time — and, unlike a scheduled one, it was never promised.
      const a = await academyWorld('exc-a6');
      const mine = await learnerAccount('exc-a6-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const start = Date.now();

      await grant(a, {
        studentId: mine.userId,
        timeMultiplier: 1.5,
        availableFrom: new Date(start - HOUR).toISOString(),
      });
      const granted = await exceptionRows(mine.userId, GRANTED);
      expect(granted).toHaveLength(1);
      expect((granted[0].values as { scheduled: boolean }).scheduled).toBe(false);

      await tick(new Date(start + 3 * HOUR));
      expect(await exceptionRows(mine.userId, ACTIVATED)).toHaveLength(0);
    });

    it('reads the injected clock when no instant is passed', async () => {
      // The production path: the processor calls `run()` with nothing.
      const a = await academyWorld('exc-a2');
      const mine = await learnerAccount('exc-a2-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const start = Date.now();
      const availableFrom = new Date(start + 2 * HOUR);
      await grant(a, {
        studentId: mine.userId,
        availableFrom: availableFrom.toISOString(),
      });

      clock.set(new Date(start + HOUR));
      await activation.run();
      expect(await exceptionRows(mine.userId, ACTIVATED)).toHaveLength(0);

      clock.set(new Date(start + 3 * HOUR));
      await activation.run();
      expect(await exceptionRows(mine.userId, ACTIVATED)).toHaveLength(1);
    });

    it('announces a MOVED window again, because the date the learner has is wrong', async () => {
      const a = await academyWorld('exc-a3');
      const mine = await learnerAccount('exc-a3-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const start = Date.now();

      await grant(a, {
        studentId: mine.userId,
        availableFrom: new Date(start + 2 * HOUR).toISOString(),
      });
      await tick(new Date(start + 3 * HOUR));
      expect(await exceptionRows(mine.userId, ACTIVATED)).toHaveLength(1);

      // The reviewer moves it. The grant message says so; the activation
      // must say so again when the NEW window opens.
      await grant(a, {
        studentId: mine.userId,
        availableFrom: new Date(start + 5 * HOUR).toISOString(),
      });
      await tick(new Date(start + 6 * HOUR));
      const rows = await exceptionRows(mine.userId, ACTIVATED);
      expect(rows).toHaveLength(2);
      expect(rows[0].dedupeKey).not.toBe(rows[1].dedupeKey);
    });

    it('stays silent for a window that opened and closed while it was down', async () => {
      const a = await academyWorld('exc-a4');
      const mine = await learnerAccount('exc-a4-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const start = Date.now();

      await grant(a, {
        studentId: mine.userId,
        availableFrom: new Date(start + 1 * HOUR).toISOString(),
        availableUntil: new Date(start + 2 * HOUR).toISOString(),
      });

      // The sweep catches up three hours late: the window is already shut,
      // so "your exception has just become active" would be false.
      await tick(new Date(start + 3 * HOUR));
      expect(await exceptionRows(mine.userId, ACTIVATED)).toHaveLength(0);
    });

    it('sends the activation email to the student who owns the exception', async () => {
      const a = await academyWorld('exc-a5');
      const mine = await learnerAccount('exc-a5-mine', a.academy.id);
      const classmate = await learnerAccount('exc-a5-classmate', a.academy.id);
      await enrol(mine, a.course.id);
      await enrol(classmate, a.course.id);
      const start = Date.now();

      await grant(a, {
        studentId: mine.userId,
        timeMultiplier: 1.5,
        availableFrom: new Date(start + HOUR).toISOString(),
      });
      await tick(new Date(start + 2 * HOUR));

      const rows = await exceptionRows(mine.userId, ACTIVATED);
      expect(rows).toHaveLength(1);
      expect(await deliver(rows[0].id)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(mine.email);
      expect(sent[0].to).not.toBe(classmate.email);
      expect(sent[0].text).toContain(a.quiz.title);
    });
  });

  // =====================================================================
  // 4. revoked
  // =====================================================================

  describe('revoking an exception', () => {
    it('tells the student it is gone, and tells nobody else', async () => {
      const a = await academyWorld('exc-r1');
      const b = await academyWorld('exc-r1-other');
      const mine = await learnerAccount('exc-r1-mine', a.academy.id);
      const classmate = await learnerAccount('exc-r1-classmate', a.academy.id);
      const stranger = await learnerAccount('exc-r1-stranger', b.academy.id);
      await enrol(mine, a.course.id);
      await enrol(classmate, a.course.id);
      await enrol(stranger, b.course.id);

      await grant(a, { studentId: mine.userId, timeMultiplier: 1.5 });
      const overrideId = (await exceptionRows(mine.userId, GRANTED))[0].entityId;

      await revoke(a, mine.userId);

      const rows = await exceptionRows(mine.userId, REVOKED);
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe(overrideId);
      expect((rows[0].values as { quizTitle: string }).quizTitle).toBe(a.quiz.title);
      expect(rows[0].dedupeKey).toBe(
        `quiz_override.revoked:${overrideId}:${
          (rows[0].values as { revokedAtMs: number }).revokedAtMs
        }`,
      );

      for (const other of [classmate.userId, stranger.userId, a.owner.userId]) {
        expect(await exceptionRows(other, REVOKED)).toHaveLength(0);
      }

      expect(await deliver(rows[0].id)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(mine.email);
      expect(sent[0].text.toLowerCase()).toContain('removed');
    });

    it('says nothing when there was no exception to remove', async () => {
      const a = await academyWorld('exc-r2');
      const mine = await learnerAccount('exc-r2-mine', a.academy.id);
      await enrol(mine, a.course.id);

      await revoke(a, mine.userId);
      expect(await exceptionRows(mine.userId)).toHaveLength(0);

      // And a second revoke of an exception already removed adds nothing.
      await grant(a, { studentId: mine.userId, timeMultiplier: 1.5 });
      await revoke(a, mine.userId);
      await revoke(a, mine.userId);
      expect(await exceptionRows(mine.userId, REVOKED)).toHaveLength(1);
    });

    it('stops the activation sweep from announcing a window it no longer has', async () => {
      const a = await academyWorld('exc-r3');
      const mine = await learnerAccount('exc-r3-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const start = Date.now();

      await grant(a, {
        studentId: mine.userId,
        availableFrom: new Date(start + 2 * HOUR).toISOString(),
      });
      await revoke(a, mine.userId);

      await tick(new Date(start + 3 * HOUR));
      expect(await exceptionRows(mine.userId, ACTIVATED)).toHaveLength(0);
    });
  });

  // =====================================================================
  // 5. tenancy
  // =====================================================================

  describe('tenancy', () => {
    it('a reviewer of another academy cannot grant — and nothing is emitted', async () => {
      const a = await academyWorld('exc-t1');
      const b = await academyWorld('exc-t1-other');
      const mine = await learnerAccount('exc-t1-mine', a.academy.id);
      await enrol(mine, a.course.id);

      // B's owner aiming at A's course: the review guard refuses.
      await request(app.getHttpServer())
        .put(`/review/courses/${a.course.id}/quizzes/${a.quiz.id}/overrides`)
        .set(b.owner.auth)
        .send({ studentId: mine.userId, timeMultiplier: 4 })
        .expect(404);

      // B's owner aiming at their OWN quiz but A's learner: no enrollment.
      await request(app.getHttpServer())
        .put(`/review/courses/${b.course.id}/quizzes/${b.quiz.id}/overrides`)
        .set(b.owner.auth)
        .send({ studentId: mine.userId, timeMultiplier: 4 })
        .expect(404);

      expect(await exceptionRows(mine.userId)).toHaveLength(0);
      expect(await feedRows(mine.userId)).toHaveLength(0);
    });
  });

  /** One activation tick at `at`, with the clock pinned there too. */
  async function tick(at: Date) {
    clock.set(at);
    const result = await activation.run(at);
    clock.reset();
    return result;
  }
});
