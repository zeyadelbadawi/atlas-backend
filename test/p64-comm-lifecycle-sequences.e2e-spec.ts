/**
 * Tenant lifecycle sequences — P64 Communications C5 (plan §26 T1–T6,
 * §27 S1–S10), end to end against real Postgres, real RLS and the real
 * outbox.
 *
 * WHAT THIS SUITE IS ACTUALLY FOR. The pure evaluator is already pinned
 * boundary-by-boundary in `lifecycle-steps.util.spec.ts`. What only a
 * database can prove is the property the whole workstream rests on:
 *
 *   THE SWEEP RUNS EVERY 15 MINUTES FOREVER, AND SENDS EACH STEP ONCE.
 *
 * Nothing is scheduled ahead, so there is no queue to revoke when a
 * customer pays — every tick re-asks "is this step due now?" and the
 * dedupe key (`lifecycle_<step>:<organizationId>:<anchor>`, enforced by
 * the `(recipient_user_id, dedupe_key)` unique index) is the only thing
 * standing between that design and 96 identical emails a day. A test that
 * ran the sweep once would never notice if it broke.
 *
 * THE CLOCK. `PLANS_CLOCK` is overridden with a pinnable clock, the same
 * mechanism `p64-comm-expiry-enforcement.e2e-spec.ts` uses, so a trial can
 * be stood 1 ms either side of its expiry and a 45-day sequence walked in
 * milliseconds. Every other clock (Postgres defaults, JWTs) stays real.
 *
 * THE FLAG. `FLAG_LIFECYCLE_SEQUENCES_MODE` defaults to `off`, which is
 * the correct production default and would make every assertion here
 * vacuous — so it is set to `on` BEFORE the app is built, and `dry_run` is
 * exercised through the service's own mode getter.
 */
process.env.FLAG_LIFECYCLE_SEQUENCES_MODE = 'on';

import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedOrganizationWithOwner,
  seedPlan,
} from './utils/db-admin';
import { PLANS_CLOCK, type Clock } from '../src/plans/utils/clock';
import { TenantLifecycleService } from '../src/plans/services/tenant-lifecycle.service';
import { TrialRedemptionService } from '../src/plans/services/trial-redemption.service';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
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
import { GRACE_PERIOD_MS } from '../src/plans/queue/subscription-sweep.types';
import { LIFECYCLE_STEP_MAX_LATENESS_MS } from '../src/plans/utils/lifecycle-steps.util';

const DAY = 24 * 60 * 60 * 1000;
const DISPATCH_ATTEMPT = { made: 0, max: 6 } as const;

/** Queue workers off: this suite drives the sweep and the dispatcher by hand. */
class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

/** Real time until pinned; pinned time until reset — copied from the expiry suite. */
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

interface Tenant {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly planId: string;
}

describe('P64 C5 — tenant lifecycle sequences (e2e, fake clock)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let lifecycle: TenantLifecycleService;
  let trials: TrialRedemptionService;
  let dispatcher: CommunicationDispatchService;
  let stubEmailProvider: StubEmailProvider;
  let sent: EmailSendInput[];
  let sendSpy: jest.SpyInstance;
  const clock = new FakeClock();
  /**
   * Every organisation this run seeds, removed in `afterAll`.
   *
   * Unusual for this suite's neighbours, which deliberately leave their
   * fixtures behind — but a lifecycle fixture is not inert. Each one sits
   * inside a sequence window at the pinned 2026 dates forever, so every
   * future run of this file (and of anything else that ticks the sweep)
   * would evaluate all of them, and the tick cost would climb with every
   * run until the 60 s timeout. Deleting the organisation cascades to its
   * subscription, cancellations and lifecycle state.
   */
  const seededOrganizationIds: string[] = [];

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
    stubEmailProvider = testApp.stubEmailProvider;
    lifecycle = app.get(TenantLifecycleService, { strict: false });
    trials = app.get(TrialRedemptionService, { strict: false });
    dispatcher = app.get(CommunicationDispatchService, { strict: false });

    // The sweep and the dispatcher both run under a real platform owner.
    await admin.user.create({
      data: {
        email: uniqueTestEmail('lifecycle-platform-owner'),
        passwordHash: 'x',
        name: 'lifecycle platform owner',
        isPlatformOwner: true,
      },
    });

    // Only OUTBOX sends count — the dispatcher tags every one with `key:`.
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
    clock.reset();
    await admin.organization.deleteMany({
      where: { id: { in: seededOrganizationIds } },
    });
    await admin.$disconnect();
    await app.close();
    delete process.env.FLAG_LIFECYCLE_SEQUENCES_MODE;
  });

  beforeEach(() => {
    sent.length = 0;
    sendSpy.mockClear();
    clock.reset();
  });

  // --- fixtures -------------------------------------------------------------

  async function seedTenant(
    label: string,
    subscription: {
      status:
        | 'no_plan'
        | 'trialing'
        | 'trial_expired'
        | 'active'
        | 'grace_period'
        | 'cancelled'
        | 'expired';
      trialEndsAt?: Date | null;
      currentPeriodStart?: Date | null;
      currentPeriodEnd?: Date | null;
      graceEndsAt?: Date | null;
      cancelAtPeriodEnd?: boolean;
    },
    owner: { preferences?: Record<string, unknown>; email?: string } = {},
  ): Promise<Tenant> {
    const email = owner.email ?? uniqueTestEmail(`${label}-owner`);
    const user = await admin.user.create({
      data: {
        email,
        passwordHash: 'x',
        name: `${label} owner`,
        ...(owner.preferences ? { preferences: owner.preferences as never } : {}),
      },
    });
    const org = await seedOrganizationWithOwner(admin, user.id, `${label}-org`);
    const plan = await seedPlan(admin, `${label}-plan`);
    await admin.tenantSubscription.create({
      data: {
        organizationId: org.id,
        planId: plan.id,
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt ?? null,
        currentPeriodStart: subscription.currentPeriodStart ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd ?? null,
        graceEndsAt: subscription.graceEndsAt ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
      },
    });
    seededOrganizationIds.push(org.id);
    return {
      organizationId: org.id,
      ownerId: user.id,
      ownerEmail: email,
      planId: plan.id,
    };
  }

  function recordCancellation(tenant: Tenant, kind: 'trial' | 'paid', effectiveAt: Date) {
    return admin.subscriptionCancellation.create({
      data: {
        organizationId: tenant.organizationId,
        kind,
        reason: 'not_using_it',
        cancelledByUserId: tenant.ownerId,
        effectiveAt,
      },
    });
  }

  /** Every lifecycle outbox row this owner holds, oldest first. */
  async function outbox(tenant: Tenant) {
    return admin.communicationOutbox.findMany({
      where: { recipientUserId: tenant.ownerId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, key: true, dedupeKey: true, state: true },
    });
  }

  async function keysFor(tenant: Tenant): Promise<string[]> {
    return (await outbox(tenant)).map((row) => row.key);
  }

  /**
   * Puts one outbox row back in the exact state `emit` left it in, right
   * before this suite dispatches it by hand.
   *
   * Needed because the dispatch assertions below are the only ones that
   * race anything: `enqueueAfterCommit` really does put a job on the
   * `communications` queue, and on a developer machine where the ordinary
   * Atlas backend happens to be running against this same database and
   * Redis, that backend's own worker can claim the row first (leaving it
   * `failed` with the ten-minute claim lease set) before the assertion
   * runs. Re-arming is honest: nothing about the row's key, dedupe key or
   * values is touched, so `decide` still makes its real decision on the
   * real row — only "who got there first" is removed from the test.
   */
  async function rearm(outboxId: string): Promise<void> {
    await admin.communicationOutbox.update({
      where: { id: outboxId },
      data: { state: 'pending', attempts: 0, availableAt: new Date(), lastError: null },
    });
    await admin.communicationDelivery.deleteMany({ where: { outboxId } });
  }

  /** One sweep tick at `at`. */
  async function tick(at: Date) {
    clock.set(at);
    return lifecycle.run(at);
  }

  // --- the property the whole design rests on -------------------------------

  describe('a repeated sweep never re-sends', () => {
    it('emits T3 exactly once across eight ticks spread over its whole due window', async () => {
      const trialEndsAt = new Date('2026-10-04T12:00:00.000Z');
      const tenant = await seedTenant('t3-repeat', {
        status: 'trial_expired',
        trialEndsAt,
      });

      // Eight ticks: the first at the expiry instant, the last just
      // inside the lateness horizon, and six spread across the window in
      // between. In production this step is re-evaluated ninety-six times
      // a day for two days and must survive all of them; eight is the
      // same claim at a cost this shared database can pay.
      for (let i = 0; i < 8; i++) {
        await tick(
          new Date(trialEndsAt.getTime() + (i * LIFECYCLE_STEP_MAX_LATENESS_MS) / 7),
        );
      }

      const rows = await outbox(tenant);
      expect(rows.map((row) => row.key)).toEqual(['lifecycle.trial.expired']);
      expect(rows[0].dedupeKey).toBe(
        `lifecycle_trial_expired:${tenant.organizationId}:${trialEndsAt.toISOString()}`,
      );
    });

    it('reports the repeats as deduped rather than as nothing happening', async () => {
      const trialEndsAt = new Date('2026-10-05T08:00:00.000Z');
      const tenant = await seedTenant('t3-dedupe-count', {
        status: 'trial_expired',
        trialEndsAt,
      });

      const first = await tick(trialEndsAt);
      const second = await tick(new Date(trialEndsAt.getTime() + 60 * 60 * 1000));

      expect(first.stepsEmitted).toBeGreaterThanOrEqual(1);
      expect(second.stepsEmitted).toBe(0);
      expect(second.stepsDeduped).toBeGreaterThanOrEqual(1);
      expect(await keysFor(tenant)).toEqual(['lifecycle.trial.expired']);
    });

    it('writes exactly one in-app notification too, not one per tick', async () => {
      const trialEndsAt = new Date('2026-10-06T08:00:00.000Z');
      const tenant = await seedTenant('t3-inapp', {
        status: 'trial_expired',
        trialEndsAt,
      });

      await tick(trialEndsAt);
      await tick(new Date(trialEndsAt.getTime() + 30 * 60 * 1000));
      await tick(new Date(trialEndsAt.getTime() + 90 * 60 * 1000));

      const notifications = await admin.notification.findMany({
        where: { userId: tenant.ownerId },
      });
      expect(notifications).toHaveLength(1);
    });
  });

  // --- boundaries -----------------------------------------------------------

  describe('each step fires at its boundary and not before', () => {
    it('does not emit T2 one millisecond early, and emits it exactly on time', async () => {
      const trialEndsAt = new Date('2026-10-10T12:00:00.000Z');
      const tenant = await seedTenant('t2-boundary', {
        status: 'trialing',
        trialEndsAt,
      });
      const dueAt = new Date(trialEndsAt.getTime() - DAY);

      await tick(new Date(dueAt.getTime() - 1));
      expect(await keysFor(tenant)).toEqual([]);

      await tick(dueAt);
      expect(await keysFor(tenant)).toEqual(['lifecycle.trial.ending_soon']);
    });

    it('refuses a step that fell due longer ago than the lateness horizon', async () => {
      const trialEndsAt = new Date('2026-10-11T12:00:00.000Z');
      const tenant = await seedTenant('t3-stale', {
        status: 'trial_expired',
        trialEndsAt,
      });

      await tick(new Date(trialEndsAt.getTime() + LIFECYCLE_STEP_MAX_LATENESS_MS + 1));
      expect(await keysFor(tenant)).toEqual([]);
    });
  });

  // --- the conditional tail -------------------------------------------------

  describe('T4–T6', () => {
    it('are suppressed the moment a plan is activated', async () => {
      const trialEndsAt = new Date('2026-10-12T12:00:00.000Z');
      const tenant = await seedTenant('t4-activated', {
        status: 'trial_expired',
        trialEndsAt,
      });

      // The customer pays two hours after the trial lapsed.
      await tick(trialEndsAt);
      await admin.tenantSubscription.update({
        where: { organizationId: tenant.organizationId },
        data: {
          status: 'active',
          currentPeriodStart: new Date(trialEndsAt.getTime() + 2 * 60 * 60 * 1000),
          currentPeriodEnd: new Date(trialEndsAt.getTime() + 365 * DAY),
        },
      });

      for (const offset of [3 * DAY, 14 * DAY, 45 * DAY]) {
        await tick(new Date(trialEndsAt.getTime() + offset));
      }
      expect(await keysFor(tenant)).toEqual(['lifecycle.trial.expired']);
    });

    it('are suppressed for a cancelled trial, which gets T3 and nothing else', async () => {
      const trialEndsAt = new Date('2026-10-14T12:00:00.000Z');
      const cancelledAt = new Date(trialEndsAt.getTime() - 2 * DAY);
      const tenant = await seedTenant('t4-cancelled', {
        status: 'cancelled',
        trialEndsAt,
      });
      await recordCancellation(tenant, 'trial', cancelledAt);

      await tick(cancelledAt);
      for (const offset of [3 * DAY, 14 * DAY, 45 * DAY]) {
        await tick(new Date(cancelledAt.getTime() + offset));
      }

      const rows = await outbox(tenant);
      expect(rows.map((row) => row.key)).toEqual(['lifecycle.trial.expired']);
      // Anchored on the cancellation, not on when the trial WOULD have run out.
      expect(rows[0].dedupeKey).toBe(
        `lifecycle_trial_expired:${tenant.organizationId}:${cancelledAt.toISOString()}`,
      );
    });

    it('skips T5/T6 for an organisation that never built anything, and sends them when it did', async () => {
      const trialEndsAt = new Date('2026-10-16T12:00:00.000Z');
      const empty = await seedTenant('t5-empty', {
        status: 'trial_expired',
        trialEndsAt,
      });
      const withContent = await seedTenant('t5-content', {
        status: 'trial_expired',
        trialEndsAt,
      });
      const academy = await seedAcademy(admin, withContent.organizationId, 't5-academy');
      await admin.course.create({
        data: {
          academyId: academy.id,
          title: 'A real course',
          slug: `t5-course-${Date.now()}`,
          status: 'draft',
          visibility: 'private',
          pricingType: 'free',
        },
      });

      await tick(new Date(trialEndsAt.getTime() + 14 * DAY));
      await tick(new Date(trialEndsAt.getTime() + 45 * DAY));

      expect(await keysFor(empty)).toEqual([]);
      expect(await keysFor(withContent)).toEqual([
        'lifecycle.trial.followup_14d',
        'lifecycle.trial.reactivation_45d',
      ]);
    });

    it('sends T4 to an empty organisation — only the SECOND nudge needs content', async () => {
      const trialEndsAt = new Date('2026-10-18T12:00:00.000Z');
      const tenant = await seedTenant('t4-empty', {
        status: 'trial_expired',
        trialEndsAt,
      });

      await tick(new Date(trialEndsAt.getTime() + 3 * DAY));
      expect(await keysFor(tenant)).toEqual(['lifecycle.trial.followup_3d']);
    });
  });

  // --- the paid half --------------------------------------------------------

  describe('S3–S7', () => {
    it('skips the renewal reminders once the period has been paid forward', async () => {
      const periodEnd = new Date('2026-11-01T12:00:00.000Z');
      const tenant = await seedTenant('s3-renewed', {
        status: 'active',
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
        currentPeriodEnd: periodEnd,
      });

      // The renewal lands before the first reminder is due.
      await admin.tenantSubscription.update({
        where: { organizationId: tenant.organizationId },
        data: { currentPeriodEnd: new Date(periodEnd.getTime() + 30 * DAY) },
      });

      await tick(new Date(periodEnd.getTime() - 7 * DAY));
      await tick(new Date(periodEnd.getTime() - DAY));
      expect(await keysFor(tenant)).toEqual([]);
    });

    it('emits S3 then S4 for a period nobody renews', async () => {
      const periodEnd = new Date('2026-11-03T12:00:00.000Z');
      const tenant = await seedTenant('s3-unpaid', {
        status: 'active',
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
        currentPeriodEnd: periodEnd,
      });

      await tick(new Date(periodEnd.getTime() - 7 * DAY));
      await tick(new Date(periodEnd.getTime() - DAY));

      expect(await keysFor(tenant)).toEqual([
        'lifecycle.subscription.renewal_due',
        'lifecycle.subscription.renewal_tomorrow',
      ]);
    });

    it('emits S5 at the period end and S7 at the grace end, in that order and never the reverse', async () => {
      const periodEnd = new Date('2026-11-05T12:00:00.000Z');
      const graceEnd = new Date(periodEnd.getTime() + GRACE_PERIOD_MS);
      const tenant = await seedTenant('s5-s7', {
        status: 'active',
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
        currentPeriodEnd: periodEnd,
      });

      await tick(new Date(periodEnd.getTime() - 1));
      expect(await keysFor(tenant)).toEqual([]);

      await tick(periodEnd);
      expect(await keysFor(tenant)).toEqual(['lifecycle.subscription.grace_started']);

      // The sweep persists `grace_period` in production; simulate that so
      // the stored and derived states agree, as they do live.
      await admin.tenantSubscription.update({
        where: { organizationId: tenant.organizationId },
        data: { status: 'grace_period', graceEndsAt: graceEnd },
      });

      await tick(new Date(graceEnd.getTime() - DAY));
      await tick(new Date(graceEnd.getTime() - 1));
      expect(await keysFor(tenant)).toEqual([
        'lifecycle.subscription.grace_started',
        'lifecycle.subscription.grace_ending',
      ]);

      await admin.tenantSubscription.update({
        where: { organizationId: tenant.organizationId },
        data: { status: 'expired' },
      });
      await tick(graceEnd);

      expect(await keysFor(tenant)).toEqual([
        'lifecycle.subscription.grace_started',
        'lifecycle.subscription.grace_ending',
        'lifecycle.subscription.expired',
      ]);
    });

    it('sends S10 at +7 d and +30 d, and nothing at all to someone who cancelled', async () => {
      const periodEnd = new Date('2026-11-08T12:00:00.000Z');
      const graceEnd = new Date(periodEnd.getTime() + GRACE_PERIOD_MS);
      const lapsed = await seedTenant('s10-lapsed', {
        status: 'expired',
        currentPeriodEnd: periodEnd,
        graceEndsAt: graceEnd,
      });
      const cancelled = await seedTenant('s10-cancelled', {
        status: 'expired',
        currentPeriodEnd: periodEnd,
        graceEndsAt: graceEnd,
      });
      await recordCancellation(cancelled, 'paid', periodEnd);

      await tick(new Date(graceEnd.getTime() + 7 * DAY));
      await tick(new Date(graceEnd.getTime() + 30 * DAY));

      expect(await keysFor(lapsed)).toEqual([
        'lifecycle.subscription.followup_7d',
        'lifecycle.subscription.followup_30d',
      ]);
      expect(await keysFor(cancelled)).toEqual([]);
    });

    it('emits S9 when a paid cancellation takes effect', async () => {
      const periodEnd = new Date('2026-11-12T12:00:00.000Z');
      const tenant = await seedTenant('s9', {
        status: 'cancelled',
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
      });
      await recordCancellation(tenant, 'paid', periodEnd);

      await tick(new Date(periodEnd.getTime() - 1));
      expect(await keysFor(tenant)).toEqual([]);

      await tick(periodEnd);
      await tick(new Date(periodEnd.getTime() + 60 * 60 * 1000));
      expect(await keysFor(tenant)).toEqual(['lifecycle.subscription.cancelled']);
    });
  });

  // --- recipients -----------------------------------------------------------

  describe('recipient safety', () => {
    it('emits nothing for an organisation whose owner is deleted, soft-deleted or anonymised', async () => {
      const trialEndsAt = new Date('2026-10-20T12:00:00.000Z');

      const softDeleted = await seedTenant('owner-soft-deleted', {
        status: 'trial_expired',
        trialEndsAt,
      });
      await admin.user.update({
        where: { id: softDeleted.ownerId },
        data: { deletedAt: new Date() },
      });

      const statusDeleted = await seedTenant('owner-status-deleted', {
        status: 'trial_expired',
        trialEndsAt,
      });
      await admin.user.update({
        where: { id: statusDeleted.ownerId },
        data: { status: 'deleted' },
      });

      const anonymised = await seedTenant(
        'owner-anonymised',
        { status: 'trial_expired', trialEndsAt },
        {
          email: `anon-${Date.now()}-${Math.random().toString(36).slice(2)}@account.invalid`,
        },
      );

      const live = await seedTenant('owner-live', {
        status: 'trial_expired',
        trialEndsAt,
      });

      await tick(trialEndsAt);

      expect(await keysFor(softDeleted)).toEqual([]);
      expect(await keysFor(statusDeleted)).toEqual([]);
      expect(await keysFor(anonymised)).toEqual([]);
      // The control: the same tick, the same due step, a live owner.
      expect(await keysFor(live)).toEqual(['lifecycle.trial.expired']);
    });
  });

  // --- preferences ----------------------------------------------------------

  describe('preferences', () => {
    const SILENCED = {
      notifications: {
        email: false,
        categories: {
          lifecycle: { reminders: false },
          engagement: { email: false, digest: 'off' },
        },
      },
    };

    it('still sends T3 to someone who has silenced everything — a site going offline is not marketing', async () => {
      const trialEndsAt = new Date('2026-10-22T12:00:00.000Z');
      const tenant = await seedTenant(
        'pref-t3',
        { status: 'trial_expired', trialEndsAt },
        { preferences: SILENCED },
      );

      await tick(trialEndsAt);
      const [row] = await outbox(tenant);
      expect(row.key).toBe('lifecycle.trial.expired');

      await rearm(row.id);
      expect(await dispatcher.dispatch(row.id, DISPATCH_ATTEMPT)).toBe('sent');
      expect(sent.map((message) => message.to)).toContain(tenant.ownerEmail);
    });

    it('honours the reminders toggle for T4, which is a nudge and not news', async () => {
      const trialEndsAt = new Date('2026-10-24T12:00:00.000Z');
      const tenant = await seedTenant(
        'pref-t4',
        { status: 'trial_expired', trialEndsAt },
        { preferences: SILENCED },
      );

      await tick(new Date(trialEndsAt.getTime() + 3 * DAY));
      const [row] = await outbox(tenant);
      expect(row.key).toBe('lifecycle.trial.followup_3d');

      await rearm(row.id);
      expect(await dispatcher.dispatch(row.id, DISPATCH_ATTEMPT)).toBe('in_app_only');
      expect(sent.map((message) => message.to)).not.toContain(tenant.ownerEmail);
    });

    it('sends T4 to someone who left the reminders toggle alone', async () => {
      const trialEndsAt = new Date('2026-10-26T12:00:00.000Z');
      const tenant = await seedTenant('pref-t4-default', {
        status: 'trial_expired',
        trialEndsAt,
      });

      await tick(new Date(trialEndsAt.getTime() + 3 * DAY));
      const [row] = await outbox(tenant);
      await rearm(row.id);
      expect(await dispatcher.dispatch(row.id, DISPATCH_ATTEMPT)).toBe('sent');
      expect(sent.map((message) => message.to)).toContain(tenant.ownerEmail);
    });
  });

  // --- the flag -------------------------------------------------------------

  describe('FLAG_LIFECYCLE_SEQUENCES_MODE', () => {
    it('writes nothing in `dry_run`, but still reports what it would have sent', async () => {
      const trialEndsAt = new Date('2026-10-28T12:00:00.000Z');
      const tenant = await seedTenant('dry-run', {
        status: 'trial_expired',
        trialEndsAt,
      });

      const modeSpy = jest
        .spyOn(lifecycle, 'mode', 'get')
        .mockReturnValue('dry_run' as never);
      try {
        const result = await tick(trialEndsAt);
        expect(result.stepsDue).toBeGreaterThanOrEqual(1);
        expect(result.stepsEmitted).toBe(0);
      } finally {
        modeSpy.mockRestore();
      }

      expect(await keysFor(tenant)).toEqual([]);
    });

    it('evaluates nothing at all when `off`', async () => {
      const trialEndsAt = new Date('2026-10-29T12:00:00.000Z');
      const tenant = await seedTenant('flag-off', {
        status: 'trial_expired',
        trialEndsAt,
      });

      const modeSpy = jest
        .spyOn(lifecycle, 'mode', 'get')
        .mockReturnValue('off' as never);
      try {
        const result = await tick(trialEndsAt);
        expect(result.organizationsEvaluated).toBe(0);
      } finally {
        modeSpy.mockRestore();
      }

      expect(await keysFor(tenant)).toEqual([]);
    });
  });

  // --- T1, the one step a clock does not decide ----------------------------

  describe('T1 — emitted by `startTrial` itself', () => {
    it('sends exactly one "trial started" and never a second on a repeated request', async () => {
      const tenant = await seedTenant('t1', { status: 'no_plan', trialEndsAt: null });
      await admin.plan.update({
        where: { id: tenant.planId },
        data: { trialEligible: true, trialDurationDays: 3 },
      });
      await admin.trialPolicy.deleteMany({});
      await admin.trialPolicy.create({ data: { enabled: true, durationDays: 3 } });

      const first = await trials.startTrial(
        tenant.organizationId,
        tenant.ownerId,
        tenant.planId,
      );
      expect(first.started).toBe(true);

      // A double-clicked button: refused by the trial guards, and it must
      // not produce a second email either.
      const second = await trials.startTrial(
        tenant.organizationId,
        tenant.ownerId,
        tenant.planId,
      );
      expect(second.started).toBe(false);

      const rows = await outbox(tenant);
      expect(rows.map((row) => row.key)).toEqual(['lifecycle.trial.started']);
      expect(rows[0].dedupeKey).toBe(
        `lifecycle_trial_started:${tenant.organizationId}:${first.trialEndsAt!.toISOString()}`,
      );
    });
  });
});
