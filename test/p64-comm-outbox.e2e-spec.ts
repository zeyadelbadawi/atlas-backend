/**
 * P64 Communications — the outbox, end to end, against real Postgres with
 * FORCE RLS, the real `AppModule` and the stub email provider.
 *
 * These are the properties the whole design exists for, and every one of
 * them is invisible to a unit test:
 *
 *  - TRANSACTIONALITY. `emit` writes inside the caller's transaction, so a
 *    rolled-back purchase must leave no outbox row and no feed row — i.e.
 *    no email about a purchase that never happened.
 *  - IDEMPOTENCY, twice over: a repeated `emit` (a retried job, a
 *    redelivered webhook) collapses on the `(recipient, dedupe_key)` unique
 *    constraint, and a repeated DISPATCH collapses on the conditional
 *    claim, so a person is told once and mailed once.
 *  - THE CHANNEL AND PREFERENCE POLICY. `email: 'always'` mails regardless;
 *    `email: 'preference'` respects the engagement toggle but STILL writes
 *    the in-app row (silencing an email must never silence the feed); an
 *    anonymised or deleted account is never mailed at all.
 *  - LOCALE. The email is rendered in the RECIPIENT's language, not the
 *    actor's — asserted here with a real Arabic-preference user and the
 *    Arabic subject line.
 *  - RLS. `communication_outbox` rows are visible to their recipient, the
 *    owning tenant and the Platform Owner, and to nobody else. No endpoint
 *    exposes them today, so the policy is asserted directly under a second
 *    user's session context, the way `test/rls-*.e2e-spec.ts` do.
 *
 * WHY THE QUEUE IS STUBBED OUT: the `communications` BullMQ worker and its
 * 60-second sweep would otherwise claim these rows in the background, mid
 * assertion — the spec would be testing a race, not a rule. The processor
 * and the scheduler (and ONLY those two) are replaced with inert classes;
 * the dispatch pipeline itself is the real `CommunicationDispatchService`,
 * called the same way the processor calls it.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
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

jest.setTimeout(60000);

/** Inert stand-ins — no `@Processor` metadata, so no BullMQ worker is created. */
class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const DISPATCH_ATTEMPT = { made: 0, max: 6 } as const;

describe('P64 Communications — outbox, dispatch, preferences, RLS (e2e)', () => {
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

    // Every email the OUTBOX handed to the provider, in order — the stub
    // itself only keeps the LAST one per address, which cannot answer
    // "exactly once".
    //
    // Scoped to outbox sends on purpose. `send` is now the single method
    // every email in the process goes through, auth's verification and
    // password-reset mail included, and these specs create accounts —
    // so an unfiltered array would mix a registration's verification
    // email into "how many emails did dispatching this row produce?".
    // The dispatcher tags every send with the catalogue `key:`; auth's
    // legacy messages carry bare `email_verification`/`password_reset`
    // tags instead (`providers/legacy-messages.ts`), which is the
    // distinction used here.
    sent = [];
    sendSpy = jest
      .spyOn(stubEmailProvider, 'send')
      .mockImplementation(async (input: EmailSendInput) => {
        if ((input.tags ?? []).some((tag) => tag.startsWith('key:'))) sent.push(input);
        // Mirrors the real stub's own result shape (`STUB_PROVIDER_NAME`),
        // so the delivery row this spec asserts on is the row production
        // would have written.
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

  async function createUser(
    label: string,
    overrides: {
      preferences?: Record<string, unknown>;
      email?: string;
      status?: 'active' | 'deleted';
      deletedAt?: Date;
    } = {},
  ) {
    return admin.user.create({
      data: {
        email: overrides.email ?? uniqueTestEmail(label),
        passwordHash: 'x',
        name: label,
        preferences: overrides.preferences as Prisma.InputJsonValue | undefined,
        status: overrides.status,
        deletedAt: overrides.deletedAt,
      },
    });
  }

  function emitInput(
    key: EmitInput['key'],
    recipientUserId: string,
    values: Record<string, unknown> = {},
  ): EmitInput {
    return {
      key,
      recipientUserId,
      entity: { type: 'payment', id: randomUUID() },
      values,
    };
  }

  /** `emit` exactly as a producer does it: inside one transaction, under the recipient's own context. */
  async function emit(input: EmitInput) {
    return tenancy.runInUserContext(input.recipientUserId, (tx) =>
      communications.emit(tx, input),
    );
  }

  function outboxRow(id: string) {
    return admin.communicationOutbox.findUnique({ where: { id } });
  }

  function deliveriesOf(outboxId: string) {
    return admin.communicationDelivery.findMany({
      where: { outboxId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- transactionality -------------------------------------------------

  describe('emit is part of the caller’s transaction', () => {
    it('leaves no outbox row and no notification when the transaction rolls back', async () => {
      const user = await createUser('comm-rollback');
      const entityId = randomUUID();
      const boom = new Error('business rule failed after the emit');

      await expect(
        tenancy.runInUserContext(user.id, async (tx) => {
          const result = await communications.emit(tx, {
            key: 'platform.payment.approved',
            recipientUserId: user.id,
            entity: { type: 'payment', id: entityId },
            values: { amount: '49.00', currency: 'USD' },
          });
          expect(result.created).toBe(true);
          expect(result.outboxId).not.toBeNull();
          // The row is visible INSIDE the transaction that wrote it...
          const inFlight = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "communication_outbox" WHERE "entity_id" = ${entityId}`;
          expect(inFlight).toHaveLength(1);
          throw boom;
        }),
      ).rejects.toThrow(boom);

      // ...and gone from the database once it rolled back.
      expect(await admin.communicationOutbox.count({ where: { entityId } })).toBe(0);
      expect(
        await admin.notification.count({
          where: { userId: user.id, dedupeKey: `payment_approved:${entityId}` },
        }),
      ).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('commits exactly one outbox row and one notification when the transaction succeeds', async () => {
      const user = await createUser('comm-commit');
      const input = emitInput('platform.payment.approved', user.id, {
        amount: '49.00',
        currency: 'USD',
      });
      const result = await emit(input);

      expect(result.created).toBe(true);
      const row = await outboxRow(result.outboxId!);
      expect(row).not.toBeNull();
      expect(row!.state).toBe('pending');
      expect(row!.key).toBe('platform.payment.approved');
      expect(row!.category).toBe('transactional');
      expect(row!.recipientUserId).toBe(user.id);
      expect(row!.dedupeKey).toBe(`payment_approved:${input.entity.id}`);
      expect(row!.channels).toEqual({ inApp: true, email: 'always' });
      expect(
        await admin.notification.count({
          where: { userId: user.id, dedupeKey: row!.dedupeKey },
        }),
      ).toBe(1);
      // Emitting never sends — that is the dispatcher's job, after commit.
      expect(sent).toHaveLength(0);
    });
  });

  // --- dedupe -----------------------------------------------------------

  describe('dedupe', () => {
    it('a duplicate emit writes one outbox row and reports created:false the second time', async () => {
      const user = await createUser('comm-dedupe');
      const input = emitInput('platform.payment.approved', user.id, {
        amount: '10.00',
        currency: 'USD',
      });

      const first = await emit(input);
      const second = await emit(input);

      expect(first.created).toBe(true);
      expect(second).toEqual({ created: false, outboxId: null });
      expect(
        await admin.communicationOutbox.count({ where: { entityId: input.entity.id } }),
      ).toBe(1);
      expect(
        await admin.notification.count({
          where: { userId: user.id, dedupeKey: `payment_approved:${input.entity.id}` },
        }),
      ).toBe(1);
    });

    it('a deduped emit leaves the caller’s transaction usable (it must not poison the business write)', async () => {
      const user = await createUser('comm-dedupe-tx');
      const input = emitInput('platform.payment.approved', user.id, {
        amount: '10.00',
        currency: 'USD',
      });
      await emit(input);

      // A producer does not stop at `emit` — `PlatformPaymentService` and
      // `PlatformCourseOrderPaymentsService` both read the row back
      // afterwards, and `LiveSessionNotificationsService` emits once per
      // enrolled student in a loop. A duplicate must therefore be
      // absorbed, not left as an aborted transaction that fails every
      // statement after it.
      const probedName = `renamed-${randomUUID().slice(0, 8)}`;
      const result = await tenancy.runInUserContext(user.id, async (tx) => {
        const second = await communications.emit(tx, input);
        const readBack = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "communication_outbox" WHERE "entity_id" = ${input.entity.id}`;
        // A real business write after the deduped emit, in the same transaction.
        await tx.$executeRaw`UPDATE "users" SET "name" = ${probedName} WHERE "id" = ${user.id}`;
        return { second, readBack };
      });

      expect(result.second).toEqual({ created: false, outboxId: null });
      expect(result.readBack).toHaveLength(1);
      // The transaction COMMITTED — an aborted one turns its commit into a
      // silent rollback, which would leave the old name here.
      expect((await admin.user.findUnique({ where: { id: user.id } }))!.name).toBe(
        probedName,
      );
      expect(
        await admin.communicationOutbox.count({ where: { entityId: input.entity.id } }),
      ).toBe(1);
    });

    it('a second recipient still gets their row when the first one deduped in the same transaction', async () => {
      const [first, second] = await Promise.all([
        createUser('comm-loop-first'),
        createUser('comm-loop-second'),
      ]);
      const entity = { type: 'live_session', id: randomUUID() } as const;
      const values = { title: 'Live review session', startsAtMs: 1790000000000 };

      // The first student was already told (a previous run of the job).
      await emit({
        key: 'live_session.scheduled',
        recipientUserId: first.id,
        entity,
        values: { ...values, studentId: first.id },
      });

      // The job is retried: one loop, both students, one transaction.
      const outcomes = await tenancy.runInUserContext(first.id, async (tx) => {
        const a = await communications.emit(tx, {
          key: 'live_session.scheduled',
          recipientUserId: first.id,
          entity,
          values: { ...values, studentId: first.id },
        });
        const b = await communications.emit(tx, {
          key: 'live_session.scheduled',
          recipientUserId: second.id,
          entity,
          values: { ...values, studentId: second.id },
        });
        return { a, b };
      });

      expect(outcomes.a.created).toBe(false);
      expect(outcomes.b.created).toBe(true);
      expect(
        await admin.communicationOutbox.count({
          where: { entityId: entity.id, recipientUserId: second.id },
        }),
      ).toBe(1);
      expect(
        await admin.notification.count({
          where: {
            userId: second.id,
            dedupeKey: `live-session:${entity.id}:scheduled:${second.id}`,
          },
        }),
      ).toBe(1);
    });

    it('does not collapse the same event for two different recipients', async () => {
      const [a, b] = await Promise.all([
        createUser('comm-dedupe-a'),
        createUser('comm-dedupe-b'),
      ]);
      const entity = { type: 'payment', id: randomUUID() } as const;
      const values = { amount: '10.00', currency: 'USD' };

      const first = await emit({
        key: 'platform.payment.approved',
        recipientUserId: a.id,
        entity,
        values,
      });
      const second = await emit({
        key: 'platform.payment.approved',
        recipientUserId: b.id,
        entity,
        values,
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(
        await admin.communicationOutbox.count({ where: { entityId: entity.id } }),
      ).toBe(2);
    });

    it('never collapses an event the catalogue says must fire every time', async () => {
      const user = await createUser('comm-never-dedupe');
      const entity = { type: 'user', id: user.id } as const;

      const first = await emit({
        key: 'auth.password.changed',
        recipientUserId: user.id,
        entity,
      });
      const second = await emit({
        key: 'auth.password.changed',
        recipientUserId: user.id,
        entity,
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(
        await admin.communicationOutbox.count({
          where: { recipientUserId: user.id, key: 'auth.password.changed' },
        }),
      ).toBe(2);
    });
  });

  // --- dispatch ---------------------------------------------------------

  describe('dispatch', () => {
    it('sends exactly one email, in the recipient’s locale, and records the delivery', async () => {
      const user = await createUser('comm-dispatch-ar', {
        preferences: { language: 'ar' },
      });
      const emitted = await emit(
        emitInput('platform.payment.approved', user.id, {
          amount: '49.00',
          currency: 'USD',
        }),
      );

      const outcome = await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);

      expect(outcome).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(user.email);
      // The Arabic subject of `platform.payment.approved`, not the English one.
      expect(sent[0].subject).toBe('تمت الموافقة على الدفع');
      expect(sent[0].html).toContain('dir="rtl"');
      expect(sent[0].html).toContain('lang="ar"');
      expect(sent[0].text).not.toContain('<');

      const row = await outboxRow(emitted.outboxId!);
      expect(row!.state).toBe('dispatched');
      expect(row!.dispatchedAt).not.toBeNull();
      expect(row!.attempts).toBe(1);

      const deliveries = await deliveriesOf(emitted.outboxId!);
      const email = deliveries.filter((d) => d.channel === 'email');
      expect(email).toHaveLength(1);
      expect(email[0].status).toBe('sent');
      expect(email[0].templateVersion).toBe('platform.payment.approved@1');
      expect(email[0].sentAt).not.toBeNull();
      // The provider RECORDS ITSELF now (`EmailSendResult.provider`),
      // rather than the transport guessing from the class name — so a
      // Brevo-then-Resend failover writes which one actually accepted it.
      expect(email[0].provider).toBe(STUB_PROVIDER_NAME);
    });

    it('renders the English subject for a recipient with no language preference', async () => {
      const user = await createUser('comm-dispatch-en');
      const emitted = await emit(
        emitInput('platform.payment.approved', user.id, {
          amount: '49.00',
          currency: 'USD',
        }),
      );

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe('Payment approved');
      expect(sent[0].html).toContain('dir="ltr"');
    });

    it('dispatching the same row twice sends one email (the claim is idempotent)', async () => {
      const user = await createUser('comm-dispatch-twice');
      const emitted = await emit(
        emitInput('platform.payment.approved', user.id, {
          amount: '7.00',
          currency: 'USD',
        }),
      );

      const first = await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);
      const second = await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);

      expect(first).toBe('sent');
      expect(second).toBe('skipped');
      expect(sent).toHaveLength(1);
      const deliveries = await deliveriesOf(emitted.outboxId!);
      expect(deliveries.filter((d) => d.channel === 'email')).toHaveLength(1);
      const row = await outboxRow(emitted.outboxId!);
      expect(row!.state).toBe('dispatched');
      expect(row!.attempts).toBe(1);
    });

    it('never mails an anonymised account — the row ends `suppressed`', async () => {
      const user = await createUser('comm-anonymised', {
        email: `deleted-${randomUUID()}@account.invalid`,
      });
      const emitted = await emit(
        emitInput('platform.payment.approved', user.id, {
          amount: '1.00',
          currency: 'USD',
        }),
      );

      const outcome = await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);

      expect(outcome).toBe('suppressed');
      expect(sent).toHaveLength(0);
      const row = await outboxRow(emitted.outboxId!);
      expect(row!.state).toBe('suppressed');
      expect(row!.lastError).toBe('recipient_unavailable');
      const email = (await deliveriesOf(emitted.outboxId!)).filter(
        (d) => d.channel === 'email',
      );
      expect(email).toHaveLength(1);
      expect(email[0].status).toBe('suppressed');
    });

    it('never mails a deleted account — the row ends `suppressed`', async () => {
      const user = await createUser('comm-deleted', {
        status: 'deleted',
        deletedAt: new Date(),
      });
      const emitted = await emit(
        emitInput('platform.payment.approved', user.id, {
          amount: '1.00',
          currency: 'USD',
        }),
      );

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe(
        'suppressed',
      );
      expect(sent).toHaveLength(0);
      expect((await outboxRow(emitted.outboxId!))!.state).toBe('suppressed');
    });

    it('an `email: preference` event is not mailed when engagement is off, but the feed row still exists', async () => {
      const user = await createUser('comm-pref-off', {
        preferences: {
          notifications: { categories: { engagement: { email: false } } },
        },
      });
      const input: EmitInput = {
        key: 'assessment.assignment.graded',
        recipientUserId: user.id,
        entity: { type: 'assignment_submission', id: randomUUID() },
        values: { assignmentTitle: 'Week 3 lab report', score: 88, revision: 1 },
      };
      const emitted = await emit(input);

      const outcome = await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);

      expect(outcome).toBe('in_app_only');
      expect(sent).toHaveLength(0);
      const row = await outboxRow(emitted.outboxId!);
      expect(row!.state).toBe('dispatched');
      expect(row!.lastError).toBe('preference_off');

      // Silencing the email must never silence the in-app feed.
      const notification = await admin.notification.findFirst({
        where: {
          userId: user.id,
          dedupeKey: `assignment_submission.graded:${input.entity.id}:1`,
        },
      });
      expect(notification).not.toBeNull();
      expect(notification!.titleKey).toBe('notifications:events.assignmentGraded.title');

      const deliveries = await deliveriesOf(emitted.outboxId!);
      expect(deliveries.find((d) => d.channel === 'in_app')?.status).toBe('sent');
      expect(deliveries.find((d) => d.channel === 'email')?.status).toBe('suppressed');
    });

    it('the SAME `email: preference` event IS mailed when engagement is on', async () => {
      const user = await createUser('comm-pref-on');
      const emitted = await emit({
        key: 'assessment.assignment.graded',
        recipientUserId: user.id,
        entity: { type: 'assignment_submission', id: randomUUID() },
        values: { assignmentTitle: 'Week 3 lab report', score: 91, revision: 1 },
      });

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe('Your assignment has been graded');
    });

    it('an `email: never` event writes the feed row and mails nobody', async () => {
      const user = await createUser('comm-inapp-only');
      const emitted = await emit({
        key: 'live_session.cancelled',
        recipientUserId: user.id,
        entity: { type: 'live_session', id: randomUUID() },
        values: { title: 'Live review session', studentId: user.id },
      });

      const outcome = await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);

      expect(outcome).toBe('in_app_only');
      expect(sent).toHaveLength(0);
      const row = await outboxRow(emitted.outboxId!);
      expect(row!.state).toBe('dispatched');
      expect(
        await admin.notification.count({
          where: {
            userId: user.id,
            titleKey: 'notifications:liveSession.cancelled.title',
          },
        }),
      ).toBeGreaterThanOrEqual(1);
    });
  });

  // --- the preferences endpoint ----------------------------------------

  describe('GET/PATCH /users/me/communication-preferences', () => {
    async function signUp(label: string) {
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

    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .get('/users/me/communication-preferences')
        .expect(401);
    });

    it('GET returns the documented §23 shape with the locked categories locked', async () => {
      const user = await signUp('comm-prefs-get');

      const res = await request(app.getHttpServer())
        .get('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.language).toBe('en');
      expect(res.body.categories.security).toEqual({ email: true, locked: true });
      expect(res.body.categories.transactional).toEqual({ email: true, locked: true });
      expect(res.body.categories.lifecycle).toEqual({
        email: true,
        locked: true,
        reminders: true,
      });
      expect(res.body.categories.engagement).toEqual({
        email: true,
        digest: 'immediate',
      });
      // A freshly registered learner holds no staff membership.
      expect(res.body.categories.operational).toBeNull();
    });

    it('PATCH round-trips the mutable fields and persists them', async () => {
      const user = await signUp('comm-prefs-patch');

      const patched = await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          language: 'ar',
          engagement: { email: false, digest: 'daily' },
          lifecycle: { reminders: false },
        })
        .expect(200);

      expect(patched.body.language).toBe('ar');
      expect(patched.body.categories.engagement).toEqual({
        email: false,
        digest: 'daily',
      });
      expect(patched.body.categories.lifecycle.reminders).toBe(false);
      // …and the locked ones are still locked on.
      expect(patched.body.categories.security).toEqual({ email: true, locked: true });

      const reread = await request(app.getHttpServer())
        .get('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(reread.body).toEqual(patched.body);

      // The legacy flag is kept in step so older clients keep telling the truth.
      const stored = (await admin.user.findUnique({ where: { id: user.userId } }))!
        .preferences as { notifications?: { email?: boolean } };
      expect(stored.notifications?.email).toBe(false);
    });

    it('PATCH of a locked category is REJECTED with 400 (not silently ignored)', async () => {
      const user = await signUp('comm-prefs-locked');

      const res = await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ security: { email: false } })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('security');

      await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ transactional: { email: false } })
        .expect(400);

      // `lifecycle.email` is locked too — only `reminders` is writable.
      await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ lifecycle: { email: false } })
        .expect(400);

      const after = await request(app.getHttpServer())
        .get('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(after.body.categories.security.email).toBe(true);
      expect(after.body.categories.lifecycle.email).toBe(true);
    });

    it('PATCH rejects an invalid enum value', async () => {
      const user = await signUp('comm-prefs-invalid');
      await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ engagement: { digest: 'weekly' } })
        .expect(400);
      await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ language: 'fr' })
        .expect(400);
    });

    it('a learner’s operational PATCH is accepted but never persisted (operational stays null)', async () => {
      const user = await signUp('comm-prefs-operational');

      const res = await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ operational: { email: false, digest: 'daily' } })
        .expect(200);

      expect(res.body.categories.operational).toBeNull();
      const stored = (await admin.user.findUnique({ where: { id: user.userId } }))!
        .preferences as {
        notifications?: { categories?: { operational?: unknown } };
      };
      expect(stored.notifications?.categories?.operational).toBeUndefined();
    });

    it('the dispatcher honours a preference set through the endpoint', async () => {
      const user = await signUp('comm-prefs-honoured');
      await request(app.getHttpServer())
        .patch('/users/me/communication-preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ engagement: { email: false } })
        .expect(200);

      const emitted = await emit({
        key: 'assessment.quiz.graded',
        recipientUserId: user.userId,
        entity: { type: 'quiz_attempt', id: randomUUID() },
        values: { quizTitle: 'Module 2 quiz', score: 70 },
      });

      expect(await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT)).toBe(
        'in_app_only',
      );
      expect(sent).toHaveLength(0);
    });
  });

  // --- RLS --------------------------------------------------------------

  describe('Row-Level Security on communication_outbox', () => {
    it('a second user cannot read another user’s outbox row', async () => {
      const [owner, attacker] = await Promise.all([
        createUser('comm-rls-owner'),
        createUser('comm-rls-attacker'),
      ]);
      const emitted = await emit(
        emitInput('platform.payment.approved', owner.id, {
          amount: '5.00',
          currency: 'USD',
        }),
      );
      const id = emitted.outboxId!;

      const asOwner = await tenancy.runInUserContext(
        owner.id,
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "communication_outbox" WHERE "id" = ${id}`,
      );
      const asAttacker = await tenancy.runInUserContext(
        attacker.id,
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "communication_outbox" WHERE "id" = ${id}`,
      );
      const withoutContext = await tenancy.runWithoutContext(
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "communication_outbox" WHERE "id" = ${id}`,
      );

      expect(asOwner).toHaveLength(1);
      expect(asAttacker).toHaveLength(0);
      expect(withoutContext).toHaveLength(0);
    });

    it('a second user cannot UPDATE another user’s outbox row (no self-update policy exists)', async () => {
      const [owner, attacker] = await Promise.all([
        createUser('comm-rls-upd-owner'),
        createUser('comm-rls-upd-attacker'),
      ]);
      const emitted = await emit(
        emitInput('platform.payment.approved', owner.id, {
          amount: '5.00',
          currency: 'USD',
        }),
      );
      const id = emitted.outboxId!;

      const affected = await tenancy.runInUserContext(
        attacker.id,
        (tx) =>
          tx.$executeRaw`
          UPDATE "communication_outbox" SET "state" = 'suppressed' WHERE "id" = ${id}`,
      );

      expect(affected).toBe(0);
      expect((await outboxRow(id))!.state).toBe('pending');
    });

    it('the recipient cannot read another recipient’s deliveries either', async () => {
      const [owner, attacker] = await Promise.all([
        createUser('comm-rls-del-owner'),
        createUser('comm-rls-del-attacker'),
      ]);
      const emitted = await emit(
        emitInput('platform.payment.approved', owner.id, {
          amount: '5.00',
          currency: 'USD',
        }),
      );
      await dispatcher.dispatch(emitted.outboxId!, DISPATCH_ATTEMPT);

      const asAttacker = await tenancy.runInUserContext(
        attacker.id,
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "communication_deliveries" WHERE "outbox_id" = ${emitted.outboxId!}`,
      );
      // `communication_deliveries` has platform/tenant SELECT policies only —
      // not even the recipient reads their own delivery metadata.
      const asOwner = await tenancy.runInUserContext(
        owner.id,
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "communication_deliveries" WHERE "outbox_id" = ${emitted.outboxId!}`,
      );

      expect(asAttacker).toHaveLength(0);
      expect(asOwner).toHaveLength(0);
      expect(await deliveriesOf(emitted.outboxId!)).not.toHaveLength(0);
    });
  });
});
