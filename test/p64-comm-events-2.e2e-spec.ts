/**
 * P64 Communications C3, SECOND PASS — the remaining transactional events
 * (plan §8 B1-B4, C1, D1-D2, E4-E6, H1), end to end against real
 * Postgres with FORCE RLS, the real `AppModule` and the stub provider.
 *
 * Shaped exactly like `p64-comm-events.e2e-spec.ts`, which proves the
 * first nine, and for the same three reasons:
 *
 *  1. THE CATALOGUE KEYS behave: one outbox row and one feed row per
 *     event, nothing at all when the producer's transaction rolls back,
 *     one row on a repeat, an `engagement` key a preference CAN silence,
 *     a `security`/`transactional` key no preference can, and a
 *     suppressed address that is never mailed whatever the catalogue says.
 *  2. THE PRODUCERS are actually wired. A catalogue entry with no call
 *     site is a promise nobody keeps and a unit test cannot tell — so the
 *     self-enrollment, course-order, lesson-completion, device and
 *     announcement paths are driven through their real HTTP endpoints and
 *     the rows they leave behind are read back with the admin client.
 *  3. THE ORDER-EXPIRY TRANSITION now COMMITS. It did not before this
 *     change: the lazy `status = 'expired'` UPDATE lived in the same
 *     interactive transaction as the `ConflictException` that reports it,
 *     so Postgres rolled it back every time and the order stayed
 *     `pending_payment` with a past `expiresAt` forever. The assertion
 *     below is on the ROW, not on the notification.
 *
 * WHY THE QUEUE IS STUBBED OUT: as in `p64-comm-outbox.e2e-spec.ts` —
 * the real worker and its 60-second sweep would claim these rows mid
 * assertion, so the processor and the scheduler (and only those two) are
 * inert and the dispatch pipeline is called directly, the way the
 * processor calls it.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
  seedPaymentMethod,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { CommunicationService } from '../src/communications/services/communication.service';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import type { EmitInput } from '../src/communications/services/communication.service';
import {
  StubEmailProvider,
  STUB_PROVIDER_NAME,
} from '../src/communications/providers/stub-email.provider';
import type {
  EmailSendInput,
  EmailSendResult,
} from '../src/identity/services/email-provider.interface';
import { hashEmail } from '../src/communications/services/suppression.service';
import { QuizAttemptEngineService } from '../src/learning/services/quiz-attempt-engine.service';

jest.setTimeout(120000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const DISPATCH_ATTEMPT = { made: 0, max: 6 } as const;
const PASSWORD = 'correct-horse-battery';

/** Fixed instants so an expected dedupe string reads as the shape it is. */
const AT_MS = 1790000005555;
const OCCURRED_ON = '2026-09-25';

/** Every new key, the values its dedupe rule reads, and the string it must produce. */
const NEW_KEYS: ReadonlyArray<{
  readonly key: EmitInput['key'];
  readonly values: Record<string, unknown>;
  readonly dedupe: (entityId: string) => string;
  readonly email: 'always' | 'preference' | 'never';
}> = [
  {
    key: 'enrollment.self_enrolled',
    values: { courseId: 'c1', courseTitle: 'Algebra', academyName: 'Falcon' },
    dedupe: (id) => `enrollment.self_enrolled:${id}`,
    email: 'always',
  },
  {
    key: 'course.order.created',
    values: { courseTitle: 'Algebra', amount: '49.00', currency: 'AED' },
    dedupe: (id) => `course_order_created:${id}`,
    email: 'never',
  },
  {
    key: 'course.order.expired',
    values: { courseTitle: 'Algebra', courseId: 'c1' },
    dedupe: (id) => `course_order_expired:${id}`,
    email: 'never',
  },
  {
    key: 'assessment.quiz.auto_submitted',
    values: { quizTitle: 'Unit 1', reason: 'timeout', courseId: 'c1', quizId: 'q1' },
    dedupe: (id) => `quiz_attempt.auto_submitted:${id}`,
    email: 'preference',
  },
  {
    key: 'assessment.attempt.invalidated',
    values: { quizTitle: 'Unit 1', invalidatedAtMs: AT_MS, courseId: 'c1', quizId: 'q1' },
    dedupe: (id) => `quiz_attempt.invalidated:${id}:${AT_MS}`,
    email: 'preference',
  },
  {
    key: 'course.completed',
    values: { completedAtMs: AT_MS, courseId: 'c1', courseTitle: 'Algebra' },
    dedupe: (id) => `course.completed:${id}:${AT_MS}`,
    email: 'preference',
  },
  {
    key: 'device.registered',
    values: { deviceLabel: 'Chrome on macOS' },
    dedupe: (id) => `device.registered:${id}`,
    email: 'never',
  },
  {
    key: 'device.removed',
    values: { deviceLabel: 'Chrome on macOS' },
    dedupe: (id) => `device.removed:${id}`,
    email: 'always',
  },
  {
    key: 'device.limit_reached',
    values: { occurredOn: OCCURRED_ON, maxDevices: 2 },
    dedupe: (id) => `device.limit_reached:${id}:${OCCURRED_ON}`,
    email: 'never',
  },
  {
    key: 'session.taken_over',
    values: { takenOverAtMs: AT_MS, deviceLabel: 'Chrome on macOS' },
    dedupe: (id) => `session.taken_over:${id}:${AT_MS}`,
    email: 'never',
  },
  {
    key: 'announcement.published',
    values: { title: 'Exam week', academyName: 'Falcon', courseId: 'c1' },
    dedupe: (id) => `announcement.published:${id}`,
    email: 'never',
  },
];

describe('P64 Communications C3 (second pass) — devices, commerce, learning, announcements (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let tenancy: TenancyContextService;
  let communications: CommunicationService;
  let dispatcher: CommunicationDispatchService;
  let stubEmailProvider: StubEmailProvider;
  let sent: EmailSendInput[];
  let sendSpy: jest.SpyInstance;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    stubEmailProvider = testApp.stubEmailProvider;
    tenancy = app.get(TenancyContextService, { strict: false });
    communications = app.get(CommunicationService, { strict: false });
    dispatcher = app.get(CommunicationDispatchService, { strict: false });

    // Only OUTBOX sends (the dispatcher tags every one with `key:`) —
    // these specs register accounts, whose verification emails would
    // otherwise be counted as "emails this row produced".
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

  afterAll(async () => {
    sendSpy.mockRestore();
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    sent.length = 0;
    sendSpy.mockClear();
    await flushRateLimitKeys();
  });

  // --- fixtures ---------------------------------------------------------

  function createUser(
    label: string,
    overrides: { preferences?: Record<string, unknown>; email?: string } = {},
  ) {
    return admin.user.create({
      data: {
        email: overrides.email ?? uniqueTestEmail(label),
        passwordHash: 'x',
        name: label,
        preferences: overrides.preferences as never,
      },
    });
  }

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

  /** An academy with an owner, an active subscription and one published free course with one lesson. */
  async function academyWorld(
    label: string,
    course: { pricingType?: 'free' | 'paid' } = {},
  ) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const paid = course.pricingType === 'paid';
    const courseRow = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: paid ? 'paid' : 'free',
      ...(paid ? { pricingAmountMinorUnits: BigInt(4900), pricingCurrency: 'USD' } : {}),
    });
    const section = await seedCourseSection(admin, courseRow.id, `${label}-s`, 0);
    const lesson = await seedCourseLesson(
      admin,
      section.id,
      courseRow.id,
      `${label}-l`,
      0,
      {
        status: 'published',
      },
    );
    return { owner, org, academy, course: courseRow, section, lesson };
  }

  /** A learner registered THROUGH an academy and signed in on its surface (so a device is registered). */
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

  function emit(input: EmitInput) {
    return tenancy.runInUserContext(input.recipientUserId, (tx) =>
      communications.emit(tx, input),
    );
  }

  function outboxFor(userId: string, key?: string) {
    return admin.communicationOutbox.findMany({
      where: { recipientUserId: userId, ...(key ? { key } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  // =====================================================================
  // 1. the catalogue keys themselves
  // =====================================================================

  describe('every new key writes exactly one outbox row and one feed row', () => {
    it.each(NEW_KEYS.map((spec) => [spec.key, spec] as const))(
      '%s',
      async (_key, spec) => {
        const user = await createUser('evt2-emit');
        const entity = { type: 'fixture', id: randomUUID() } as const;

        const result = await emit({
          key: spec.key,
          recipientUserId: user.id,
          entity,
          values: spec.values,
        });

        expect(result.created).toBe(true);
        const rows = await outboxFor(user.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe(spec.key);
        expect(rows[0].state).toBe('pending');
        expect(rows[0].dedupeKey).toBe(spec.dedupe(entity.id));
        expect(rows[0].channels).toEqual({ inApp: true, email: spec.email });
        expect(
          await admin.notification.count({
            where: { userId: user.id, dedupeKey: rows[0].dedupeKey },
          }),
        ).toBe(1);
        // Emitting never sends.
        expect(sent).toHaveLength(0);
      },
    );

    it.each(NEW_KEYS.map((spec) => [spec.key, spec] as const))(
      '%s dedupes on a repeat',
      async (_key, spec) => {
        const user = await createUser('evt2-dedupe');
        const entity = { type: 'fixture', id: randomUUID() } as const;
        const input = {
          key: spec.key,
          recipientUserId: user.id,
          entity,
          values: spec.values,
        };

        const first = await emit(input);
        const second = await emit(input);

        expect(first.created).toBe(true);
        expect(second).toEqual({ created: false, outboxId: null });
        expect(await outboxFor(user.id)).toHaveLength(1);
        expect(await admin.notification.count({ where: { userId: user.id } })).toBe(1);
      },
    );

    it('a rolled-back producer transaction leaves neither row', async () => {
      const user = await createUser('evt2-rollback');
      const entity = { type: 'enrollment', id: randomUUID() } as const;
      const boom = new Error('the business rule failed after the emit');

      await expect(
        tenancy.runInUserContext(user.id, async (tx) => {
          const result = await communications.emit(tx, {
            key: 'enrollment.self_enrolled',
            recipientUserId: user.id,
            entity,
            values: { courseId: 'c1', courseTitle: 'Algebra' },
          });
          expect(result.created).toBe(true);
          throw boom;
        }),
      ).rejects.toThrow(boom);

      expect(
        await admin.communicationOutbox.count({ where: { entityId: entity.id } }),
      ).toBe(0);
      expect(await admin.notification.count({ where: { userId: user.id } })).toBe(0);
    });

    it('the emit survives a collision INSIDE a transaction that carries on writing', async () => {
      // The savepoint contract: a deduped emit must leave the caller's
      // transaction usable, or the producer silently loses every write it
      // had already made and still reports success.
      const user = await createUser('evt2-savepoint');
      const entity = { type: 'student_device', id: randomUUID() } as const;
      await emit({
        key: 'device.removed',
        recipientUserId: user.id,
        entity,
        values: { deviceLabel: 'Chrome on macOS' },
      });

      const name = `renamed-${randomUUID().slice(0, 8)}`;
      await tenancy.runInUserContext(user.id, async (tx) => {
        const second = await communications.emit(tx, {
          key: 'device.removed',
          recipientUserId: user.id,
          entity,
          values: { deviceLabel: 'Chrome on macOS' },
        });
        expect(second.created).toBe(false);
        // The write AFTER the collision is the whole point.
        await tx.user.update({ where: { id: user.id }, data: { name } });
      });

      expect((await admin.user.findUnique({ where: { id: user.id } }))?.name).toBe(name);
      expect(await outboxFor(user.id)).toHaveLength(1);
    });
  });

  describe('channel policy', () => {
    it('an engagement key IS silenced by the recipient preference', async () => {
      const user = await createUser('evt2-pref-off', {
        preferences: {
          notifications: { categories: { engagement: { email: false } } },
        },
      });
      const emitted = await emit({
        key: 'course.completed',
        recipientUserId: user.id,
        entity: { type: 'enrollment', id: randomUUID() },
        values: { completedAtMs: AT_MS, courseId: 'c1', courseTitle: 'Algebra' },
      });

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe(
        'in_app_only',
      );
      expect(sent).toHaveLength(0);
      // …but the FEED row is still there. Silencing email is not silencing Atlas.
      expect(await admin.notification.count({ where: { userId: user.id } })).toBe(1);
    });

    it('the same engagement key IS emailed when the preference is on', async () => {
      const user = await createUser('evt2-pref-on');
      const emitted = await emit({
        key: 'course.completed',
        recipientUserId: user.id,
        entity: { type: 'enrollment', id: randomUUID() },
        values: { completedAtMs: AT_MS, courseId: 'c1', courseTitle: 'Algebra' },
      });

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(user.email);
    });

    it.each([
      ['enrollment.self_enrolled', 'transactional'],
      ['device.removed', 'security'],
    ] as const)('no preference can silence %s (%s)', async (key, _category) => {
      const user = await createUser('evt2-locked', {
        preferences: {
          notifications: {
            email: false,
            categories: { engagement: { email: false, digest: 'off' } },
          },
        },
      });
      const emitted = await emit({
        key,
        recipientUserId: user.id,
        entity: { type: 'fixture', id: randomUUID() },
        values: { courseId: 'c1', courseTitle: 'Algebra', deviceLabel: 'Chrome' },
      });

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(user.email);
    });

    it('`device.limit_reached` writes the feed row and mails nobody', async () => {
      const user = await createUser('evt2-inapp-only');
      const emitted = await emit({
        key: 'device.limit_reached',
        recipientUserId: user.id,
        entity: { type: 'academy', id: randomUUID() },
        values: { occurredOn: OCCURRED_ON, maxDevices: 2 },
      });

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe(
        'in_app_only',
      );
      expect(sent).toHaveLength(0);
      const deliveries = await admin.communicationDelivery.findMany({
        where: { outboxId: emitted.outboxId! },
      });
      expect(deliveries.map((d) => d.channel)).toEqual(['in_app']);
    });

    it('a suppressed address is never mailed, whatever the catalogue says', async () => {
      const user = await createUser('evt2-suppressed');
      await admin.communicationSuppression.create({
        data: { emailHash: hashEmail(user.email), reason: 'hard_bounce', source: 'test' },
      });

      const emitted = await emit({
        key: 'device.removed',
        recipientUserId: user.id,
        entity: { type: 'student_device', id: randomUUID() },
        values: { deviceLabel: 'Chrome on macOS' },
      });
      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe(
        'suppressed',
      );
      expect(sent).toHaveLength(0);
    });
  });

  // =====================================================================
  // 2. the producers — a catalogue entry nobody calls tells nobody
  // =====================================================================

  describe('producers are wired to the catalogue', () => {
    it('B1 — signing in on an academy surface registers a device and says so, once', async () => {
      const w = await academyWorld('evt2-b1');
      const student = await learnerAccount('evt2-b1-student', w.academy.id);

      const rows = await outboxFor(student.userId, 'device.registered');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('student_device');
      expect(rows[0].category).toBe('security');
      expect(rows[0].channels).toEqual({ inApp: true, email: 'never' });
      const device = await admin.studentDevice.findFirst({
        where: { userId: student.userId, academyId: w.academy.id },
      });
      expect(rows[0].entityId).toBe(device!.id);
      expect((rows[0].values as { deviceLabel: string }).deviceLabel).toBe(device!.label);

      // A SECOND sign-in with no device cookie registers a SECOND device
      // (a new browser), which is its own row — but the first device is
      // never announced twice.
      const first = rows[0].dedupeKey;
      await flushRateLimitKeys();
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({
          email: student.email,
          password: PASSWORD,
          surface: 'academy',
          academyId: w.academy.id,
        })
        .expect(200);
      const after = await outboxFor(student.userId, 'device.registered');
      expect(after.filter((row) => row.dedupeKey === first)).toHaveLength(1);
    });

    it('B2 — removing a device tells the learner, and a second removal tells them nothing', async () => {
      const w = await academyWorld('evt2-b2');
      const student = await learnerAccount('evt2-b2-student', w.academy.id);
      const device = await admin.studentDevice.findFirstOrThrow({
        where: { userId: student.userId, academyId: w.academy.id },
      });

      await request(app.getHttpServer())
        .delete(`/learning/devices/${device.id}?academyId=${w.academy.id}`)
        .set(student.auth)
        .expect(204);

      const rows = await outboxFor(student.userId, 'device.removed');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe(device.id);
      expect(rows[0].channels).toEqual({ inApp: true, email: 'always' });

      // The device is already revoked, so the second call 404s — and the
      // emit, being inside that transaction, must leave nothing behind.
      await request(app.getHttpServer())
        .delete(`/learning/devices/${device.id}?academyId=${w.academy.id}`)
        .set(student.auth)
        .expect(404);
      expect(await outboxFor(student.userId, 'device.removed')).toHaveLength(1);
    });

    it('C1 — enrolling yourself in a free course sends a receipt, once', async () => {
      const w = await academyWorld('evt2-c1');
      const student = await learnerAccount('evt2-c1-student', w.academy.id);

      const enrolled = await request(app.getHttpServer())
        .post('/enrollments')
        .set(student.auth)
        .send({ courseId: w.course.id })
        .expect(201);

      const rows = await outboxFor(student.userId, 'enrollment.self_enrolled');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('enrollment');
      expect(rows[0].entityId).toBe(enrolled.body.id);
      expect(rows[0].category).toBe('transactional');
      const values = rows[0].values as {
        courseId: string;
        courseTitle: string;
        academyName: string;
      };
      expect(values.courseId).toBe(w.course.id);
      expect(values.courseTitle).toBe(w.course.title);
      // The academy NAME resolves here — and only here among the learner
      // producers — because this path runs in
      // `runInTenantAndUserContext`, so `academies_tenant_select` applies.
      // The learner-only contexts (devices, completion) cannot read it.
      expect(values.academyName).toBe(w.academy.name);
      expect(
        await admin.notification.count({
          where: { userId: student.userId, dedupeKey: rows[0].dedupeKey! },
        }),
      ).toBe(1);

      // Re-clicking Enrol returns the existing enrollment and says nothing.
      await request(app.getHttpServer())
        .post('/enrollments')
        .set(student.auth)
        .send({ courseId: w.course.id })
        .expect(201);
      expect(await outboxFor(student.userId, 'enrollment.self_enrolled')).toHaveLength(1);
    });

    it('C1 — the staff-grant path still says `enrollment.granted`, not the self receipt', async () => {
      // The two share `createEnrollmentInTransaction`; emitting there
      // instead of at the call site would tell a granted learner twice.
      const w = await academyWorld('evt2-c1-grant');
      const student = await learnerAccount('evt2-c1-grant-student', w.academy.id);

      await request(app.getHttpServer())
        .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
        .set(w.owner.auth)
        .send({ courseId: w.course.id })
        .expect(201);

      expect(await outboxFor(student.userId, 'enrollment.granted')).toHaveLength(1);
      expect(await outboxFor(student.userId, 'enrollment.self_enrolled')).toHaveLength(0);
    });

    it('E6 — finishing the last lesson congratulates the learner, once', async () => {
      const w = await academyWorld('evt2-e6');
      const student = await learnerAccount('evt2-e6-student', w.academy.id);
      const server = app.getHttpServer();

      const enrolled = await request(server)
        .post('/enrollments')
        .set(student.auth)
        .send({ courseId: w.course.id })
        .expect(201);

      await request(server)
        .post(`/courses/${w.course.id}/progress/complete-lesson`)
        .set(student.auth)
        .send({ lessonId: w.lesson.id })
        .expect(201);

      const rows = await outboxFor(student.userId, 'course.completed');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('enrollment');
      expect(rows[0].entityId).toBe(enrolled.body.id);
      expect(rows[0].category).toBe('engagement');
      expect(rows[0].channels).toEqual({ inApp: true, email: 'preference' });
      expect((rows[0].values as { courseTitle: string }).courseTitle).toBe(
        w.course.title,
      );

      // Every later recompute sees `completed` already true, so the guard
      // is the TRANSITION and not the state: nothing more is written.
      await request(server).get(`/courses/${w.course.id}/progress`).set(student.auth);
      expect(await outboxFor(student.userId, 'course.completed')).toHaveLength(1);
    });

    it('D1 — starting a course order records it in the feed and mails nobody', async () => {
      const w = await academyWorld('evt2-d1', { pricingType: 'paid' });
      const server = app.getHttpServer();
      await request(server)
        .patch(`/organizations/${w.org.id}/payment-settings`)
        .set(w.owner.auth)
        .send({ paymentCollectionMode: 'atlas_payments' })
        .expect(200);
      const student = await account('evt2-d1-student');

      const order = await request(server)
        .post(`/courses/${w.course.id}/course-orders`)
        .set(student.auth)
        .send({ idempotencyKey: 'evt2-d1-idem' })
        .expect(201);

      const rows = await outboxFor(student.userId, 'course.order.created');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('course_order');
      expect(rows[0].entityId).toBe(order.body.id);
      expect(rows[0].channels).toEqual({ inApp: true, email: 'never' });

      // The idempotent replay returns the same order and says nothing more.
      await request(server)
        .post(`/courses/${w.course.id}/course-orders`)
        .set(student.auth)
        .send({ idempotencyKey: 'evt2-d1-idem' })
        .expect(201);
      expect(await outboxFor(student.userId, 'course.order.created')).toHaveLength(1);
    });

    it('D2 — an expired order is COMMITTED as expired and the learner is told, once', async () => {
      const w = await academyWorld('evt2-d2', { pricingType: 'paid' });
      const server = app.getHttpServer();
      await request(server)
        .patch(`/organizations/${w.org.id}/payment-settings`)
        .set(w.owner.auth)
        .send({ paymentCollectionMode: 'atlas_payments' })
        .expect(200);
      const method = await seedPaymentMethod(admin, 'evt2-d2-method');
      const student = await account('evt2-d2-student');

      const order = await request(server)
        .post(`/courses/${w.course.id}/course-orders`)
        .set(student.auth)
        .send({ idempotencyKey: 'evt2-d2-idem' })
        .expect(201);
      // Push the window into the past, exactly as thirty minutes would.
      await admin.courseOrder.update({
        where: { id: order.body.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await request(server)
        .post(`/course-orders/${order.body.id}/payments`)
        .set(student.auth)
        .send({ methodKey: method.key })
        .expect(409);

      // THE ROW. Before this change the UPDATE was rolled back by the 409
      // it shared a transaction with, so this stayed `draft` forever.
      const row = await admin.courseOrder.findUniqueOrThrow({
        where: { id: order.body.id },
      });
      expect(row.status).toBe('expired');

      const rows = await outboxFor(student.userId, 'course.order.expired');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe(order.body.id);
      expect((rows[0].values as { courseTitle: string }).courseTitle).toBe(
        w.course.title,
      );

      // A second attempt on the already-expired order refuses again and
      // adds nothing.
      await request(server)
        .post(`/course-orders/${order.body.id}/payments`)
        .set(student.auth)
        .send({ methodKey: method.key })
        .expect(409);
      expect(await outboxFor(student.userId, 'course.order.expired')).toHaveLength(1);
    });

    it('E5 — voiding an attempt tells the LEARNER, not the reviewer who clicked', async () => {
      const w = await academyWorld('evt2-e5');
      const student = await learnerAccount('evt2-e5-student', w.academy.id);
      const server = app.getHttpServer();

      await request(server)
        .post('/enrollments')
        .set(student.auth)
        .send({ courseId: w.course.id })
        .expect(201);
      const quiz = await seedQuiz(admin, w.course.id, 'Unit 1 quiz', {
        status: 'published',
      });
      const question = await seedQuizQuestion(admin, quiz.id, 'Q?', 'single_choice', 0);
      const option = await seedQuizQuestionOption(admin, question.id, 'A', true);

      const attempt = await request(server)
        .post(`/courses/${w.course.id}/quizzes/${quiz.id}/attempts`)
        .set(student.auth)
        .expect(201);
      await request(server)
        .post(
          `/courses/${w.course.id}/quizzes/${quiz.id}/attempts/${attempt.body.id}/submit`,
        )
        .set(student.auth)
        .send({ answers: [{ questionId: question.id, selectedOptionIds: [option.id] }] })
        .expect(201);

      await request(server)
        .post(
          `/review/courses/${w.course.id}/quizzes/${quiz.id}/attempts/${attempt.body.id}/invalidate`,
        )
        .set(w.owner.auth)
        .send({ reason: 'Duplicate submission' })
        .expect(200);

      const rows = await outboxFor(student.userId, 'assessment.attempt.invalidated');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('quiz_attempt');
      expect(rows[0].entityId).toBe(attempt.body.id);
      expect(rows[0].category).toBe('engagement');
      const values = rows[0].values as { quizTitle: string; reason: string };
      expect(values.quizTitle).toBe(quiz.title);
      expect(values.reason).toBe('Duplicate submission');
      // The reviewer is not the audience.
      expect(
        await outboxFor(w.owner.userId, 'assessment.attempt.invalidated'),
      ).toHaveLength(0);

      // Voiding an already-voided attempt is a no-op on the row, so it
      // must be a no-op on the communication too.
      await request(server)
        .post(
          `/review/courses/${w.course.id}/quizzes/${quiz.id}/attempts/${attempt.body.id}/invalidate`,
        )
        .set(w.owner.auth)
        .send({ reason: 'Duplicate submission' })
        .expect(200);
      expect(
        await outboxFor(student.userId, 'assessment.attempt.invalidated'),
      ).toHaveLength(1);
    });

    it('E4 — an attempt the clock closed tells the learner, and the sweep is idempotent', async () => {
      const w = await academyWorld('evt2-e4');
      const student = await learnerAccount('evt2-e4-student', w.academy.id);
      const server = app.getHttpServer();

      await request(server)
        .post('/enrollments')
        .set(student.auth)
        .send({ courseId: w.course.id })
        .expect(201);
      const quiz = await seedQuiz(admin, w.course.id, 'Timed unit quiz', {
        status: 'published',
      });
      const question = await seedQuizQuestion(admin, quiz.id, 'Q?', 'single_choice', 0);
      await seedQuizQuestionOption(admin, question.id, 'A', true);

      // An attempt whose deadline is comfortably past the grace window —
      // exactly what the delayed job and the ten-minute sweep find.
      const attempt = await admin.quizAttempt.create({
        data: {
          quizId: quiz.id,
          studentId: student.userId,
          status: 'in_progress',
          attemptNumber: 1,
          startedAt: new Date(Date.now() - 60 * 60 * 1000),
          deadlineAt: new Date(Date.now() - 30 * 60 * 1000),
          questionIds: [question.id],
        },
      });

      const engine = app.get(QuizAttemptEngineService, { strict: false });
      expect(await engine.finalizeOverdueAttempt(attempt.id, student.userId)).toBe(
        'finalized',
      );

      const rows = await outboxFor(student.userId, 'assessment.quiz.auto_submitted');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('quiz_attempt');
      expect(rows[0].entityId).toBe(attempt.id);
      expect(rows[0].dedupeKey).toBe(`quiz_attempt.auto_submitted:${attempt.id}`);
      expect(rows[0].channels).toEqual({ inApp: true, email: 'preference' });
      const values = rows[0].values as { reason: string; quizTitle: string };
      expect(values.reason).toBe('timeout');
      expect(values.quizTitle).toBe(quiz.title);

      // The attempt is finalised, so a second sweep skips it — and even
      // if it did not, `updateIfInProgress` lets only one finaliser win.
      expect(await engine.finalizeOverdueAttempt(attempt.id, student.userId)).toBe(
        'skipped',
      );
      expect(
        await outboxFor(student.userId, 'assessment.quiz.auto_submitted'),
      ).toHaveLength(1);
    });

    it('E4 — a learner pressing Submit is not an auto-submit and says nothing', async () => {
      const w = await academyWorld('evt2-e4b');
      const student = await learnerAccount('evt2-e4b-student', w.academy.id);
      const server = app.getHttpServer();

      await request(server)
        .post('/enrollments')
        .set(student.auth)
        .send({ courseId: w.course.id })
        .expect(201);
      const quiz = await seedQuiz(admin, w.course.id, 'Ordinary quiz', {
        status: 'published',
      });
      const question = await seedQuizQuestion(admin, quiz.id, 'Q?', 'single_choice', 0);
      const option = await seedQuizQuestionOption(admin, question.id, 'A', true);

      const attempt = await request(server)
        .post(`/courses/${w.course.id}/quizzes/${quiz.id}/attempts`)
        .set(student.auth)
        .expect(201);
      await request(server)
        .post(
          `/courses/${w.course.id}/quizzes/${quiz.id}/attempts/${attempt.body.id}/submit`,
        )
        .set(student.auth)
        .send({ answers: [{ questionId: question.id, selectedOptionIds: [option.id] }] })
        .expect(201);

      expect(
        await outboxFor(student.userId, 'assessment.quiz.auto_submitted'),
      ).toHaveLength(0);
    });

    it('H1 — publishing an academy announcement tells its active learners, not its staff', async () => {
      const w = await academyWorld('evt2-h1');
      const learner = await learnerAccount('evt2-h1-learner', w.academy.id);
      const server = app.getHttpServer();

      const created = await request(server)
        .post(`/academies/${w.academy.id}/announcements`)
        .set(w.owner.auth)
        .send({ title: 'Exam week', body: 'Revision timetable inside.' })
        .expect(201);

      // A DRAFT tells nobody.
      expect(await outboxFor(learner.userId, 'announcement.published')).toHaveLength(0);

      await request(server)
        .post(`/academies/${w.academy.id}/announcements/${created.body.id}/publish`)
        .set(w.owner.auth)
        .expect(201);

      const rows = await outboxFor(learner.userId, 'announcement.published');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('announcement');
      expect(rows[0].entityId).toBe(created.body.id);
      expect(rows[0].category).toBe('engagement');
      expect(rows[0].channels).toEqual({ inApp: true, email: 'never' });
      expect((rows[0].values as { title: string }).title).toBe('Exam week');
      // The author is staff, not an audience.
      expect(await outboxFor(w.owner.userId, 'announcement.published')).toHaveLength(0);

      // Publishing again is not a second announcement.
      await request(server)
        .post(`/academies/${w.academy.id}/announcements/${created.body.id}/publish`)
        .set(w.owner.auth)
        .expect(201);
      expect(await outboxFor(learner.userId, 'announcement.published')).toHaveLength(1);
    });

    it('H1 — a COURSE announcement reaches only the learners enrolled in it', async () => {
      const w = await academyWorld('evt2-h1c');
      const enrolledLearner = await learnerAccount('evt2-h1c-in', w.academy.id);
      const otherLearner = await learnerAccount('evt2-h1c-out', w.academy.id);
      const server = app.getHttpServer();

      await request(server)
        .post('/enrollments')
        .set(enrolledLearner.auth)
        .send({ courseId: w.course.id })
        .expect(201);

      const created = await request(server)
        .post(`/courses/${w.course.id}/announcements`)
        .set(w.owner.auth)
        .send({ title: 'Lab moved', body: 'Now on Thursday.' })
        .expect(201);
      await request(server)
        .post(`/courses/${w.course.id}/announcements/${created.body.id}/publish`)
        .set(w.owner.auth)
        .expect(201);

      const rows = await outboxFor(enrolledLearner.userId, 'announcement.published');
      expect(rows).toHaveLength(1);
      const values = rows[0].values as { courseId: string; courseTitle: string };
      expect(values.courseId).toBe(w.course.id);
      expect(values.courseTitle).toBe(w.course.title);
      // A learner of the same academy who is not in the course hears nothing.
      expect(await outboxFor(otherLearner.userId, 'announcement.published')).toHaveLength(
        0,
      );
    });
  });
});
