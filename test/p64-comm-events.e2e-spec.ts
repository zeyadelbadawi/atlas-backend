/**
 * P64 Communications C3 — the transactional events that were silent, and
 * the digest, end to end against real Postgres with FORCE RLS, the real
 * `AppModule` and the stub email provider.
 *
 * Three things are proven here that nothing else can prove:
 *
 *  1. THE NEW CATALOGUE KEYS behave like the migrated ones: one outbox row
 *     and one feed row per event, nothing at all when the producer's
 *     transaction rolls back, one row on a repeat, and a `transactional`
 *     key that no preference can silence.
 *  2. THE PRODUCERS are actually wired. A catalogue entry with no call
 *     site is a promise nobody keeps, and a unit test cannot tell the
 *     difference — so the roster, enrollment, payment-proof and review
 *     paths are driven through their real HTTP endpoints and the rows
 *     they leave behind are read back with the admin client.
 *  3. THE DIGEST batches: two deferred engagement events become ONE email
 *     per window per recipient, rendered in the recipient's language,
 *     dropped entirely if the recipient silenced the category between
 *     batching and sending, and re-running the sweep sends nothing extra.
 *
 * WHY THE QUEUE IS STUBBED OUT: exactly as in `p64-comm-outbox.e2e-spec.ts`
 * — the real worker and its 60-second sweep would claim these rows mid
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
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedPaymentMethod,
  seedOrganizationCommission,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { CommunicationService } from '../src/communications/services/communication.service';
import {
  CommunicationDispatchService,
  digestKind,
  nextLocalHour,
} from '../src/communications/services/communication-dispatch.service';
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
import { DIGEST_LOCAL_HOUR } from '../src/communications/queue/communications.types';

jest.setTimeout(60000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const DISPATCH_ATTEMPT = { made: 0, max: 6 } as const;
const PASSWORD = 'correct-horse-battery';
/** A 1x1 PNG — the smallest thing `submitProof` accepts. */
const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** Fixed instants so an expected dedupe string reads as the shape it is. */
const DECIDED_AT_MS = 1790000005555;
const EXPIRES_AT_MS = 1793000000000;

/** Every C3 key, with the values its dedupe rule reads and the string it must produce. */
const NEW_KEYS: ReadonlyArray<{
  readonly key: EmitInput['key'];
  readonly values: Record<string, unknown>;
  readonly dedupe: (entityId: string) => string;
  readonly email: 'always' | 'never';
}> = [
  {
    key: 'enrollment.granted',
    values: { grantedAtMs: DECIDED_AT_MS, courseId: 'c1', courseTitle: 'Algebra' },
    dedupe: (id) => `enrollment.granted:${id}:${DECIDED_AT_MS}`,
    email: 'always',
  },
  {
    key: 'enrollment.revoked',
    values: { revokedAtMs: DECIDED_AT_MS, courseTitle: 'Algebra' },
    dedupe: (id) => `enrollment.revoked:${id}:${DECIDED_AT_MS}`,
    email: 'always',
  },
  {
    key: 'enrollment.expiry_changed',
    values: { expiresAtMs: EXPIRES_AT_MS, expiresAtDate: '2026-11-25', courseId: 'c1' },
    dedupe: (id) => `enrollment.expiry_changed:${id}:${EXPIRES_AT_MS}`,
    email: 'always',
  },
  {
    key: 'roster.student.approved',
    values: { decidedAtMs: DECIDED_AT_MS, academyName: 'Falcon' },
    dedupe: (id) => `roster.student.approved:${id}:${DECIDED_AT_MS}`,
    email: 'always',
  },
  {
    key: 'roster.student.rejected',
    values: { decidedAtMs: DECIDED_AT_MS, academyName: 'Falcon' },
    dedupe: (id) => `roster.student.rejected:${id}:${DECIDED_AT_MS}`,
    email: 'always',
  },
  {
    key: 'roster.student.blocked',
    values: { decidedAtMs: DECIDED_AT_MS, academyName: 'Falcon' },
    dedupe: (id) => `roster.student.blocked:${id}:${DECIDED_AT_MS}`,
    email: 'always',
  },
  {
    key: 'roster.student.unblocked',
    values: { decidedAtMs: DECIDED_AT_MS, academyName: 'Falcon' },
    dedupe: (id) => `roster.student.unblocked:${id}:${DECIDED_AT_MS}`,
    email: 'always',
  },
  {
    key: 'course.order.proof_submitted',
    values: { courseTitle: 'Algebra', amount: '49.00', currency: 'AED' },
    dedupe: (id) => `course_order_proof_submitted:${id}`,
    email: 'always',
  },
  {
    key: 'review.moderated',
    values: { status: 'approved', courseId: 'c1', courseTitle: 'Algebra' },
    dedupe: (id) => `course_review.moderated:${id}:approved`,
    email: 'never',
  },
];

describe('P64 Communications C3 — new transactional events and digests (e2e)', () => {
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

    // Only OUTBOX sends (the dispatcher tags every one with `key:`) — these
    // specs register accounts, whose verification emails would otherwise
    // be counted as "emails this row produced".
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

  /** An academy with an owner, an active subscription and one published free course. */
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
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);
    await seedCourseLesson(admin, section.id, course.id, `${label}-l`, 0, {
      status: 'published',
    });
    return { owner, org, academy, course };
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

  describe('every C3 key writes exactly one outbox row and one feed row', () => {
    it.each(NEW_KEYS.map((spec) => [spec.key, spec] as const))(
      '%s',
      async (_key, spec) => {
        const user = await createUser('c3-emit');
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
        const user = await createUser('c3-dedupe');
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
      const user = await createUser('c3-rollback');
      const entity = { type: 'enrollment', id: randomUUID() } as const;
      const boom = new Error('the business rule failed after the emit');

      await expect(
        tenancy.runInUserContext(user.id, async (tx) => {
          const result = await communications.emit(tx, {
            key: 'enrollment.revoked',
            recipientUserId: user.id,
            entity,
            values: { revokedAtMs: DECIDED_AT_MS },
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
  });

  describe('channel policy', () => {
    it('a preference can never silence a C3 transactional event', async () => {
      const user = await createUser('c3-pref-locked', {
        preferences: {
          notifications: { email: false, categories: { engagement: { email: false } } },
        },
      });
      const emitted = await emit({
        key: 'enrollment.revoked',
        recipientUserId: user.id,
        entity: { type: 'enrollment', id: randomUUID() },
        values: { revokedAtMs: DECIDED_AT_MS, courseTitle: 'Algebra' },
      });

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(user.email);
    });

    it('`review.moderated` writes the feed row and mails nobody', async () => {
      const user = await createUser('c3-inapp-only');
      const emitted = await emit({
        key: 'review.moderated',
        recipientUserId: user.id,
        entity: { type: 'course_review', id: randomUUID() },
        values: { status: 'rejected', courseId: 'c1', courseTitle: 'Algebra' },
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
      const user = await createUser('c3-suppressed');
      await admin.communicationSuppression.create({
        data: { emailHash: hashEmail(user.email), reason: 'hard_bounce', source: 'test' },
      });

      const emitted = await emit({
        key: 'roster.student.blocked',
        recipientUserId: user.id,
        entity: { type: 'academy_student', id: randomUUID() },
        values: { decidedAtMs: DECIDED_AT_MS, academyName: 'Falcon' },
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
    it('blocking a learner tells the LEARNER, not the staff member who clicked', async () => {
      const w = await academyWorld('c3-block');
      const student = await learnerAccount('c3-block-student', w.academy.id);

      await request(app.getHttpServer())
        .post(`/academies/${w.academy.id}/students/${student.userId}/block`)
        .set(w.owner.auth)
        .send({ reason: 'policy' })
        .expect(200);

      const rows = await outboxFor(student.userId, 'roster.student.blocked');
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('transactional');
      expect(rows[0].academyId).toBe(w.academy.id);
      expect(rows[0].organizationId).toBe(w.org.id);
      expect((rows[0].values as { academyName: string }).academyName).toBe(
        w.academy.name,
      );
      expect(await outboxFor(w.owner.userId, 'roster.student.blocked')).toHaveLength(0);
      expect(
        await admin.notification.count({
          where: { userId: student.userId, dedupeKey: rows[0].dedupeKey! },
        }),
      ).toBe(1);
    });

    it('unblocking tells the learner again, with a different dedupe key', async () => {
      const w = await academyWorld('c3-unblock');
      const student = await learnerAccount('c3-unblock-student', w.academy.id);
      const server = app.getHttpServer();

      await request(server)
        .post(`/academies/${w.academy.id}/students/${student.userId}/block`)
        .set(w.owner.auth)
        .send({})
        .expect(200);
      await request(server)
        .post(`/academies/${w.academy.id}/students/${student.userId}/unblock`)
        .set(w.owner.auth)
        .expect(200);

      // Scoped to the ROSTER keys: `learnerAccount` signs in on the
      // academy surface, which registers a device — and, since W-EVT2,
      // a `device.registered` row of its own (plan §8 B1).
      const rows = (await outboxFor(student.userId)).filter((row) =>
        row.key.startsWith('roster.'),
      );
      expect(rows.map((r) => r.key)).toEqual([
        'roster.student.blocked',
        'roster.student.unblocked',
      ]);
      expect(rows[0].dedupeKey).not.toBe(rows[1].dedupeKey);
    });

    it('a manual enrollment tells the learner which course they were given', async () => {
      const w = await academyWorld('c3-grant');
      const student = await learnerAccount('c3-grant-student', w.academy.id);

      await request(app.getHttpServer())
        .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
        .set(w.owner.auth)
        .send({ courseId: w.course.id })
        .expect(201);

      const rows = await outboxFor(student.userId, 'enrollment.granted');
      expect(rows).toHaveLength(1);
      const values = rows[0].values as { courseId: string; courseTitle: string };
      expect(values.courseId).toBe(w.course.id);
      expect(values.courseTitle).toBe(w.course.title);
      expect(rows[0].entityType).toBe('enrollment');
    });

    it('revoking an enrollment tells the learner, and a second revoke tells them nothing', async () => {
      const w = await academyWorld('c3-revoke');
      const student = await learnerAccount('c3-revoke-student', w.academy.id);
      const server = app.getHttpServer();

      const enrolled = await request(server)
        .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
        .set(w.owner.auth)
        .send({ courseId: w.course.id })
        .expect(201);
      const enrollmentId = enrolled.body.id as string;

      await request(server)
        .post(`/academies/${w.academy.id}/enrollments/${enrollmentId}/revoke`)
        .set(w.owner.auth)
        .send({ reason: 'manual' })
        .expect(200);
      await request(server)
        .post(`/academies/${w.academy.id}/enrollments/${enrollmentId}/revoke`)
        .set(w.owner.auth)
        .send({ reason: 'manual' })
        .expect(200);

      // The second call is a no-op on the enrollment, so it must be a
      // no-op on the communication too.
      expect(await outboxFor(student.userId, 'enrollment.revoked')).toHaveLength(1);
    });

    it('changing the expiry tells the learner once per distinct date', async () => {
      const w = await academyWorld('c3-expiry');
      const student = await learnerAccount('c3-expiry-student', w.academy.id);
      const server = app.getHttpServer();

      const enrolled = await request(server)
        .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
        .set(w.owner.auth)
        .send({ courseId: w.course.id })
        .expect(201);
      const enrollmentId = enrolled.body.id as string;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      for (let i = 0; i < 2; i += 1) {
        await request(server)
          .patch(`/academies/${w.academy.id}/enrollments/${enrollmentId}/expiry`)
          .set(w.owner.auth)
          .send({ expiresAt })
          .expect(200);
      }

      const rows = await outboxFor(student.userId, 'enrollment.expiry_changed');
      expect(rows).toHaveLength(1);
      expect(rows[0].dedupeKey).toBe(
        `enrollment.expiry_changed:${enrollmentId}:${new Date(expiresAt).getTime()}`,
      );

      // Moving it is news again.
      const moved = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      await request(server)
        .patch(`/academies/${w.academy.id}/enrollments/${enrollmentId}/expiry`)
        .set(w.owner.auth)
        .send({ expiresAt: moved })
        .expect(200);
      expect(await outboxFor(student.userId, 'enrollment.expiry_changed')).toHaveLength(
        2,
      );
    });

    it('a REFUSED roster decision leaves no outbox row (the emit is inside the transaction)', async () => {
      const w = await academyWorld('c3-refused');
      const student = await learnerAccount('c3-refused-student', w.academy.id);

      // The learner is already `active`, so approving them is a 409 — and
      // the whole transaction, `emit` included, must roll back.
      await request(app.getHttpServer())
        .post(`/academies/${w.academy.id}/students/${student.userId}/approve`)
        .set(w.owner.auth)
        .expect(409);

      // The ROSTER decision left nothing. The sign-in that created this
      // learner registered a device, and since W-EVT2 that is a row of
      // its own (plan §8 B1) — it is not what this test is about, and
      // counting it would make the assertion mean nothing.
      expect(await outboxFor(student.userId, 'roster.student.approved')).toHaveLength(0);
      expect(
        await admin.notification.count({
          where: { userId: student.userId, type: { not: 'security' } },
        }),
      ).toBe(0);
    });

    it('uploading a payment proof sends the learner a receipt', async () => {
      const owner = await account('c3-proof-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'c3-proof-org');
      await seedActiveSubscriptionForOrg(admin, org.id, 'c3-proof');
      const academy = await seedAcademy(admin, org.id, 'c3-proof-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'C3 Proof Course', {
        status: 'published',
        visibility: 'public',
        pricingType: 'paid',
        pricingAmountMinorUnits: BigInt(4900),
        pricingCurrency: 'USD',
      });
      const server = app.getHttpServer();
      await request(server)
        .patch(`/organizations/${org.id}/payment-settings`)
        .set(owner.auth)
        .send({ paymentCollectionMode: 'atlas_payments' })
        .expect(200);
      await seedOrganizationCommission(admin, org.id);
      const method = await seedPaymentMethod(admin, 'c3-proof-method');
      const student = await account('c3-proof-student');

      const order = await request(server)
        .post(`/courses/${course.id}/course-orders`)
        .set(student.auth)
        .send({ idempotencyKey: 'c3-proof-idem' })
        .expect(201);
      const payment = await request(server)
        .post(`/course-orders/${order.body.id}/payments`)
        .set(student.auth)
        .send({ methodKey: method.key })
        .expect(201);

      await request(server)
        .patch(`/course-orders/${order.body.id}/payments/${payment.body.id}/proof`)
        .set(student.auth)
        .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png' })
        .expect(200);

      const rows = await outboxFor(student.userId, 'course.order.proof_submitted');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('payment_proof');
      expect(rows[0].category).toBe('transactional');
      const values = rows[0].values as { courseTitle: string; amount: string };
      expect(values.courseTitle).toBe(course.title);
      expect(values.amount).toBe('49.00');
      // The receipt promises a REVIEW, never an outcome.
      expect(await outboxFor(student.userId, 'course.order.paid')).toHaveLength(0);
    });

    it('moderating a review tells its AUTHOR, in the feed only', async () => {
      const w = await academyWorld('c3-review');
      const learner = await learnerAccount('c3-review-learner', w.academy.id);
      await seedAcademyStudent(admin, w.academy.id, learner.userId).catch(
        () => undefined,
      );
      await seedEnrollment(admin, learner.userId, w.course.id, w.academy.id, {
        status: 'enrolled',
      });
      const server = app.getHttpServer();

      const created = await request(server)
        .post(`/courses/${w.course.id}/reviews`)
        .set(learner.auth)
        .send({ rating: 5, body: 'Clear and well paced.' })
        .expect(201);

      await request(server)
        .post(`/courses/${w.course.id}/reviews/${created.body.id}/approve`)
        .set(w.owner.auth)
        .expect(201);

      const rows = await outboxFor(learner.userId, 'review.moderated');
      expect(rows).toHaveLength(1);
      expect(rows[0].channels).toEqual({ inApp: true, email: 'never' });
      expect((rows[0].values as { status: string }).status).toBe('approved');
      expect(await outboxFor(w.owner.userId, 'review.moderated')).toHaveLength(0);
    });
  });

  // =====================================================================
  // 3. digests
  // =====================================================================

  describe('digests', () => {
    /** A learner who asked for a DAILY digest of engagement email. */
    function digestLearner(label: string, language?: 'en' | 'ar') {
      return createUser(label, {
        preferences: {
          ...(language ? { language } : {}),
          notifications: { categories: { engagement: { email: true, digest: 'daily' } } },
        },
      });
    }

    /** Emits an engagement event and runs it through the dispatcher. */
    async function defer(userId: string, key: EmitInput['key'], values: object) {
      const emitted = await emit({
        key,
        recipientUserId: userId,
        entity: { type: 'fixture', id: randomUUID() },
        values: values as Record<string, unknown>,
      });
      const outcome = await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);
      return { outboxId: emitted.outboxId!, outcome };
    }

    /** Pulls every open window back into the past so `sendDueDigests` picks it up. */
    async function makeWindowsDue(userId: string) {
      const past = new Date(Date.now() - 60 * 1000);
      await admin.communicationDigest.updateMany({
        where: { recipientUserId: userId, state: 'open' },
        data: { windowEnd: past, windowStart: new Date(past.getTime() - 86_400_000) },
      });
      await admin.communicationOutbox.updateMany({
        where: { recipientUserId: userId, state: 'deferred' },
        data: { availableAt: past },
      });
    }

    it('batches two engagement events into ONE email and marks both dispatched', async () => {
      const user = await digestLearner('c3-digest');
      const a = await defer(user.id, 'assessment.assignment.graded', {
        revision: 1,
        assignmentTitle: 'Week 3 lab report',
        courseId: 'c1',
        assignmentId: 'a1',
      });
      const b = await defer(user.id, 'assessment.quiz.graded', {
        quizTitle: 'Module 2 quiz',
        score: 88,
        courseId: 'c1',
        quizId: 'q1',
      });

      expect([a.outcome, b.outcome]).toEqual(['digested', 'digested']);
      expect(sent).toHaveLength(0);

      const digests = await admin.communicationDigest.findMany({
        where: { recipientUserId: user.id },
      });
      expect(digests).toHaveLength(1);
      expect(digests[0].kind).toBe('learner_engagement_daily');

      await makeWindowsDue(user.id);
      expect(await dispatcher.sendDueDigests()).toBe(1);

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(user.email);
      // The digest lists each item by its own rendered SUBJECT line, in
      // the order the events were emitted.
      expect(sent[0].text).toContain('Your assignment has been graded');
      expect(sent[0].text).toContain('Your quiz has been graded');
      expect(sent[0].subject).toContain('2');

      const rows = await admin.communicationOutbox.findMany({
        where: { id: { in: [a.outboxId, b.outboxId] } },
      });
      expect(rows.map((r) => r.state)).toEqual(['dispatched', 'dispatched']);
      const digest = await admin.communicationDigest.findUnique({
        where: { id: digests[0].id },
      });
      expect(digest!.state).toBe('sent');
      expect(digest!.itemCount).toBe(2);
      expect(
        await admin.communicationDelivery.count({
          where: { outboxId: { in: [a.outboxId, b.outboxId] }, channel: 'email' },
        }),
      ).toBe(2);
    });

    it('re-running the digest sweep sends nothing extra', async () => {
      const user = await digestLearner('c3-digest-rerun');
      await defer(user.id, 'assessment.quiz.graded', { quizTitle: 'Q', score: 50 });
      await makeWindowsDue(user.id);

      expect(await dispatcher.sendDueDigests()).toBe(1);
      expect(sent).toHaveLength(1);

      expect(await dispatcher.sendDueDigests()).toBe(0);
      expect(sent).toHaveLength(1);
    });

    it('renders the digest in the recipient’s language', async () => {
      const user = await digestLearner('c3-digest-ar', 'ar');
      await defer(user.id, 'assessment.quiz.graded', { quizTitle: 'Q', score: 50 });
      await makeWindowsDue(user.id);

      await dispatcher.sendDueDigests();
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toMatch(/[؀-ۿ]/);
      expect(sent[0].html).toContain('dir="rtl"');
    });

    it('sends nothing when the recipient silenced the category AFTER the items were batched', async () => {
      const user = await digestLearner('c3-digest-silenced');
      const item = await defer(user.id, 'assessment.quiz.graded', {
        quizTitle: 'Q',
        score: 50,
      });
      expect(item.outcome).toBe('digested');

      // The learner turns engagement email off before the window closes.
      await admin.user.update({
        where: { id: user.id },
        data: {
          preferences: {
            notifications: {
              categories: { engagement: { email: false, digest: 'daily' } },
            },
          },
        },
      });
      await makeWindowsDue(user.id);

      expect(await dispatcher.sendDueDigests()).toBe(0);
      expect(sent).toHaveLength(0);
      const row = await admin.communicationOutbox.findUnique({
        where: { id: item.outboxId },
      });
      expect(row!.state).toBe('dispatched');
      expect(row!.lastError).toBe('preference_off');
      const digest = await admin.communicationDigest.findFirst({
        where: { recipientUserId: user.id },
      });
      expect(digest!.state).toBe('empty');
    });

    it('never mails a suppressed address a digest', async () => {
      const user = await digestLearner('c3-digest-suppressed');
      const item = await defer(user.id, 'assessment.quiz.graded', {
        quizTitle: 'Q',
        score: 50,
      });
      await admin.communicationSuppression.create({
        data: { emailHash: hashEmail(user.email), reason: 'complaint', source: 'test' },
      });
      await makeWindowsDue(user.id);

      expect(await dispatcher.sendDueDigests()).toBe(0);
      expect(sent).toHaveLength(0);
      const row = await admin.communicationOutbox.findUnique({
        where: { id: item.outboxId },
      });
      expect(row!.state).toBe('suppressed');
    });

    it('gives each recipient their own window — one email per person', async () => {
      const [first, second] = await Promise.all([
        digestLearner('c3-digest-first'),
        digestLearner('c3-digest-second'),
      ]);
      await defer(first.id, 'assessment.quiz.graded', { quizTitle: 'A', score: 1 });
      await defer(second.id, 'assessment.quiz.graded', { quizTitle: 'B', score: 2 });
      await makeWindowsDue(first.id);
      await makeWindowsDue(second.id);

      await dispatcher.sendDueDigests();

      const addresses = sent.map((message) => message.to).sort();
      expect(addresses).toEqual([first.email, second.email].sort());
      // One item each, never the other person's.
      expect(sent).toHaveLength(2);
      for (const message of sent) expect(message.subject).toContain('1');
    });

    it('survives losing the window-creation race instead of aborting the dispatch', async () => {
      // The real race: another worker opened this recipient's window
      // between the lookup and the INSERT. Reproduced deterministically by
      // pre-creating the row the attach is about to compute, but with a
      // `windowEnd` in the past so the `windowEnd >= now` lookup misses it
      // and the INSERT is forced to collide on
      // `(recipient, kind, window_start)`.
      //
      // Without a SAVEPOINT around that INSERT the failed statement aborts
      // the DISPATCH transaction, and the recovery read below then fails
      // with 25P02 — the outbox row is left claimed until its lease
      // expires and the recipient hears nothing for ten minutes.
      const user = await digestLearner('c3-digest-race');
      const windowEnd = nextLocalHour(new Date(), 'UTC', DIGEST_LOCAL_HOUR);
      const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
      const raced = await admin.communicationDigest.create({
        data: {
          recipientUserId: user.id,
          kind: digestKind('learner'),
          windowStart,
          windowEnd: new Date(Date.now() - 60 * 1000),
          state: 'open',
        },
      });

      const item = await defer(user.id, 'assessment.quiz.graded', {
        quizTitle: 'Q',
        score: 50,
      });

      expect(item.outcome).toBe('digested');
      const row = await admin.communicationOutbox.findUnique({
        where: { id: item.outboxId },
      });
      expect(row!.state).toBe('deferred');
      expect(row!.digestId).toBe(raced.id);
      expect(
        await admin.communicationDigest.count({ where: { recipientUserId: user.id } }),
      ).toBe(1);
    });

    it('a claimed window is not sent twice by two concurrent sweeps', async () => {
      const user = await digestLearner('c3-digest-claim');
      await defer(user.id, 'assessment.quiz.graded', { quizTitle: 'Q', score: 50 });
      await makeWindowsDue(user.id);

      await Promise.all([dispatcher.sendDueDigests(), dispatcher.sendDueDigests()]);

      // Scoped to THIS recipient: the two sweeps also drain any window an
      // earlier test in this file left due, which is exactly what the
      // hourly job does in production.
      expect(sent.filter((message) => message.to === user.email)).toHaveLength(1);
      expect(
        await admin.communicationDigest.count({
          where: { recipientUserId: user.id, state: 'sent' },
        }),
      ).toBe(1);
    });
  });
});
