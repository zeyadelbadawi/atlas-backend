/**
 * Hosted-video retention — P64 Communications C6 (plan §31/§32), end to
 * end against real Postgres, real RLS, the real outbox and the real
 * `FakeVideoProvider`.
 *
 * WHAT ONLY A DATABASE CAN PROVE. The evaluator's arithmetic is already
 * pinned boundary-by-boundary in `video-retention.util.spec.ts` without
 * any I/O. What needs a real database is everything the arithmetic does
 * NOT decide, and it is all of the dangerous part:
 *
 *   - a repeated sweep is silent, because of a unique index on a dedupe
 *     key and not because anybody remembered to check;
 *   - the tombstone is written under an RLS context that can actually
 *     write it (`media_assets` has a platform-owner SELECT policy and no
 *     platform-owner UPDATE policy — a tombstone written under the wrong
 *     context affects zero rows and raises nothing);
 *   - a tenant who reactivates while their deletion job sits in the queue
 *     keeps their video, decided from the live row at execution time;
 *   - a provider failure leaves an asset `active` with `deletionFailedAt`
 *     and NO tombstone, which is the single outcome this workstream
 *     exists to guarantee.
 *
 * THE CLOCK. `PLANS_CLOCK` is overridden with a pinnable clock — the
 * mechanism `p64-comm-expiry-enforcement` and `p64-comm-lifecycle-
 * sequences` both use — so a 90-day sequence is walked in milliseconds
 * and every assertion stands exactly where it means to.
 *
 * THE FLAG. `FLAG_VIDEO_RETENTION_MODE` defaults to `off`, which is the
 * correct production default and would make every assertion here vacuous,
 * so it is set before the app is built and then moved between `on` and
 * `warn_only` through the loaded config object, which is what the services
 * really read.
 *
 * THE PROVIDER. `FakeVideoProvider` throughout — never a real one. It
 * holds a genuine in-process record of its assets, so "present, then
 * deleted, then verified absent" is a real transition and not a fixture
 * that was always empty.
 */
process.env.FLAG_VIDEO_RETENTION_MODE = 'on';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedOrganizationWithOwner,
  seedPlan,
} from './utils/db-admin';
import { PLANS_CLOCK, type Clock } from '../src/plans/utils/clock';
import { VideoRetentionService } from '../src/retention/services/video-retention.service';
import { VideoRetentionDeletionService } from '../src/retention/services/video-retention-deletion.service';
import { VideoRetentionProducer } from '../src/retention/queue/video-retention.producer';
import { VideoRetentionProcessor } from '../src/retention/queue/video-retention.processor';
import { VideoRetentionScheduler } from '../src/retention/queue/video-retention.scheduler';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { FakeVideoProvider } from '../src/media/video/fake-video.provider';
import {
  RETENTION_DELETION_MAX_LATENESS_MS,
  RETENTION_STEP_MAX_LATENESS_MS,
  RETENTION_W1_LEAD_MS,
  RETENTION_W2_LEAD_MS,
  RETENTION_W3_LEAD_MS,
  RETENTION_W4_LEAD_MS,
  RETENTION_WINDOW_TRIAL_MS,
} from '../src/retention/utils/video-retention.util';
import {
  retentionAssetJobId,
  VIDEO_RETENTION_ASSET_ATTEMPTS,
  type VideoRetentionAssetJobPayload,
  type VideoRetentionTenantJobPayload,
} from '../src/retention/queue/video-retention.types';

const DAY = 24 * 60 * 60 * 1000;

/** Queue workers off: this suite drives every job body by hand. */
class Inert {}

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
  readonly academyId: string;
  readonly courseId: string;
  readonly trialEndsAt: Date;
  readonly deletionAt: Date;
}

interface SeededAsset {
  readonly id: string;
  readonly providerId: string;
}

describe('P64 C6 — hosted-video retention (e2e, fake clock, fake provider)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let sweep: VideoRetentionService;
  let deletion: VideoRetentionDeletionService;
  let fakeVideo: FakeVideoProvider;
  let platformOwnerId: string;
  /** The mutable half of the loaded config — what the services actually read. */
  let commsConfig: { videoRetentionMode: 'off' | 'warn_only' | 'on' };
  let producer: VideoRetentionProducer;

  const clock = new FakeClock();
  const seededOrganizationIds: string[] = [];
  /** Everything the sweep tried to enqueue, captured instead of reaching Redis. */
  let enqueuedAssets: VideoRetentionAssetJobPayload[] = [];
  let enqueuedTenants: VideoRetentionTenantJobPayload[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(PLANS_CLOCK)
          .useValue(clock)
          .overrideProvider(VideoRetentionProcessor)
          .useClass(Inert)
          .overrideProvider(VideoRetentionScheduler)
          .useClass(Inert)
          .overrideProvider(CommunicationsProcessor)
          .useClass(Inert)
          .overrideProvider(CommunicationsScheduler)
          .useClass(Inert),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    sweep = app.get(VideoRetentionService, { strict: false });
    deletion = app.get(VideoRetentionDeletionService, { strict: false });
    fakeVideo = app.get(FakeVideoProvider, { strict: false });
    commsConfig = app
      .get(ConfigService, { strict: false })
      .getOrThrow('communications') as typeof commsConfig;

    const owner = await admin.user.create({
      data: {
        email: uniqueTestEmail('retention-platform-owner'),
        name: 'retention platform owner',
        isPlatformOwner: true,
      },
    });
    platformOwnerId = owner.id;

    producer = app.get(VideoRetentionProducer, { strict: false });
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    clock.reset();
    /*
      Deleted rather than left behind, for the same reason the C5 suite
      deletes its own: every fixture here sits inside a retention window
      at these pinned 2026 dates forever, so a later run of anything that
      ticks this sweep would evaluate all of them.
    */
    await admin.organization.deleteMany({
      where: { id: { in: seededOrganizationIds } },
    });
    await admin.user.deleteMany({ where: { id: platformOwnerId } });
    await admin.$disconnect();
    await app.close();
    delete process.env.FLAG_VIDEO_RETENTION_MODE;
  }, 60_000);

  beforeEach(() => {
    enqueuedAssets = [];
    enqueuedTenants = [];
    setMode('on');
    clock.reset();
    /*
      The sweep's enqueue is CAPTURED rather than executed: with the
      processor inert the jobs would simply pile up in Redis, and every
      job body in this suite is driven directly anyway.

      Re-established every test because `afterEach` restores all mocks —
      which it must, since several tests below deliberately break the
      video provider and an escaped `mockRejectedValue` would silently
      fail every test that ran after them.
    */
    jest
      .spyOn(producer, 'enqueueAsset')
      .mockImplementation(async (payload) => void enqueuedAssets.push(payload));
    jest
      .spyOn(producer, 'enqueueTenantSettlement')
      .mockImplementation(async (payload) => void enqueuedTenants.push(payload));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- helpers --------------------------------------------------------------

  function setMode(mode: 'off' | 'warn_only' | 'on'): void {
    commsConfig.videoRetentionMode = mode;
  }

  /** A tenant whose trial lapsed at `trialEndsAt`, with an academy and a course. */
  async function seedLapsedTrial(label: string, trialEndsAt: Date): Promise<Tenant> {
    const user = await admin.user.create({
      data: {
        email: uniqueTestEmail(`${label}-owner`),
        name: `${label} owner`,
      },
    });
    const org = await seedOrganizationWithOwner(admin, user.id, `${label}-org`);
    const plan = await seedPlan(admin, `${label}-plan`);
    await admin.tenantSubscription.create({
      data: {
        organizationId: org.id,
        planId: plan.id,
        status: 'trial_expired',
        trialEndsAt,
      },
    });
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label} course`);
    seededOrganizationIds.push(org.id);
    return {
      organizationId: org.id,
      ownerId: user.id,
      academyId: academy.id,
      courseId: course.id,
      trialEndsAt,
      deletionAt: new Date(trialEndsAt.getTime() + RETENTION_WINDOW_TRIAL_MS),
    };
  }

  /**
   * A protected hosted video that the provider genuinely knows about.
   *
   * `createDirectUpload` is the real registration path, so
   * `fetchAsset(providerId)` returns a record BEFORE the deletion and
   * `null` after it — which is what makes the absence probe a real
   * observation rather than a fixture that was empty all along.
   */
  async function seedVideo(
    tenant: Tenant,
    overrides: { durationSeconds?: number; sizeBytes?: bigint } = {},
  ): Promise<SeededAsset> {
    const upload = await fakeVideo.createDirectUpload({
      maxDurationSeconds: overrides.durationSeconds ?? 600,
      allowedOrigins: [],
      metadata: { academyId: tenant.academyId },
    });
    const asset = await admin.mediaAsset.create({
      data: {
        academyId: tenant.academyId,
        courseId: tenant.courseId,
        type: 'video',
        access: 'protected',
        provider: 'r2_worker',
        providerId: upload.providerId,
        processingStatus: 'ready',
        status: 'active',
        securityTier: 'normal',
        fileName: `${upload.providerId}.mp4`,
        storageKey: `fake-video/${upload.providerId}.mp4`,
        url: `https://protected.test.local/${upload.providerId}.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: overrides.sizeBytes ?? 12_345_678n,
        durationSeconds: overrides.durationSeconds ?? 600,
      },
    });
    return { id: asset.id, providerId: upload.providerId };
  }

  /** Forges the four warning outbox rows for an anchor, so guard (2) is satisfied. */
  async function preWarn(tenant: Tenant): Promise<void> {
    const steps = [
      ['retention_warning_30d', 'retention.video.warning_30d'],
      ['retention_warning_14d', 'retention.video.warning_14d'],
      ['retention_warning_7d', 'retention.video.warning_7d'],
      ['retention_warning_24h', 'retention.video.warning_24h'],
    ] as const;
    for (const [step, key] of steps) {
      await admin.communicationOutbox.create({
        data: {
          key,
          category: 'lifecycle',
          recipientUserId: tenant.ownerId,
          organizationId: tenant.organizationId,
          entityType: 'tenant_subscription',
          entityId: tenant.organizationId,
          dedupeKey: `lifecycle_${step}:${tenant.organizationId}:${tenant.trialEndsAt.toISOString()}`,
          channels: { inApp: true, email: 'always' },
          state: 'dispatched',
        },
      });
    }
  }

  async function keysFor(tenant: Tenant): Promise<string[]> {
    const rows = await admin.communicationOutbox.findMany({
      where: { recipientUserId: tenant.ownerId },
      orderBy: { createdAt: 'asc' },
      select: { key: true },
    });
    return rows.map((row) => row.key);
  }

  async function assetRow(assetId: string) {
    return admin.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
      select: {
        status: true,
        deletedAt: true,
        deletionFailedAt: true,
        deletionReason: true,
        bytesFreed: true,
      },
    });
  }

  async function auditRowsFor(assetId: string) {
    return admin.auditLogEntry.findMany({
      where: { action: 'media.video.deleted', targetId: assetId },
      select: { context: true, organizationId: true, academyId: true },
    });
  }

  async function tick(at: Date) {
    clock.set(at);
    return sweep.run(at);
  }

  /*
    EVERY ASSERTION ABOUT ENQUEUED WORK IS SCOPED TO ONE TENANT.

    A tick evaluates every candidate organisation on the platform, and
    this file seeds dozens of them whose windows overlap on purpose — so
    the sweep's own totals say nothing about the tenant under test.
    Reading them as if they did is how a test starts passing for the
    wrong reason, and on this workstream the wrong reason is "somebody
    else's video was deleted too".
  */
  function assetJobsFor(tenant: Tenant): VideoRetentionAssetJobPayload[] {
    return enqueuedAssets.filter((job) => job.organizationId === tenant.organizationId);
  }

  function tenantJobsFor(tenant: Tenant): VideoRetentionTenantJobPayload[] {
    return enqueuedTenants.filter((job) => job.organizationId === tenant.organizationId);
  }

  function assetPayload(
    tenant: Tenant,
    asset: SeededAsset,
  ): VideoRetentionAssetJobPayload {
    return {
      assetId: asset.id,
      organizationId: tenant.organizationId,
      anchorAt: tenant.trialEndsAt.toISOString(),
      reason: 'retention_trial',
    };
  }

  // =========================================================================
  // THE WARNINGS
  // =========================================================================

  describe('the W1-W4 sequence', () => {
    it('emits W1 at its boundary and stays silent across eight further ticks', async () => {
      const tenant = await seedLapsedTrial(
        'w1-repeat',
        new Date('2026-01-05T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      const w1DueAt = new Date(tenant.deletionAt.getTime() - RETENTION_W1_LEAD_MS);

      // In production W1 is re-evaluated 96 times a day for two days.
      // Eight ticks spread across the whole horizon is the same claim at
      // a price this shared database can pay.
      for (let i = 0; i < 8; i++) {
        await tick(
          new Date(w1DueAt.getTime() + (i * RETENTION_STEP_MAX_LATENESS_MS) / 7),
        );
      }

      expect(await keysFor(tenant)).toEqual(['retention.video.warning_30d']);
      const rows = await admin.communicationOutbox.findMany({
        where: { recipientUserId: tenant.ownerId },
        select: { dedupeKey: true },
      });
      expect(rows[0].dedupeKey).toBe(
        `lifecycle_retention_warning_30d:${tenant.organizationId}:${tenant.trialEndsAt.toISOString()}`,
      );
    }, 60_000);

    it('reports the repeats as deduped rather than as nothing happening', async () => {
      const tenant = await seedLapsedTrial(
        'w1-dedupe',
        new Date('2026-01-06T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      const w1DueAt = new Date(tenant.deletionAt.getTime() - RETENTION_W1_LEAD_MS);

      const first = await tick(w1DueAt);
      const second = await tick(new Date(w1DueAt.getTime() + 60 * 60 * 1000));

      // The tick totals cover every candidate on the platform, so the
      // per-tenant claim is made against this tenant's own rows.
      expect(first.warningsEmitted).toBeGreaterThanOrEqual(1);
      expect(second.warningsDeduped).toBeGreaterThanOrEqual(1);
      expect(await keysFor(tenant)).toEqual(['retention.video.warning_30d']);
    }, 60_000);

    it('walks W1, W2, W3 then W4, one row each, in order', async () => {
      const tenant = await seedLapsedTrial('w-all', new Date('2026-01-07T09:00:00.000Z'));
      await seedVideo(tenant);
      for (const lead of [
        RETENTION_W1_LEAD_MS,
        RETENTION_W2_LEAD_MS,
        RETENTION_W3_LEAD_MS,
        RETENTION_W4_LEAD_MS,
      ]) {
        await tick(new Date(tenant.deletionAt.getTime() - lead));
      }
      expect(await keysFor(tenant)).toEqual([
        'retention.video.warning_30d',
        'retention.video.warning_14d',
        'retention.video.warning_7d',
        'retention.video.warning_24h',
      ]);
    }, 60_000);

    it('writes the counts, minutes and course names the warnings promise', async () => {
      const tenant = await seedLapsedTrial(
        'w-values',
        new Date('2026-01-08T09:00:00.000Z'),
      );
      await seedVideo(tenant, { durationSeconds: 600 });
      await seedVideo(tenant, { durationSeconds: 1200 });
      await tick(new Date(tenant.deletionAt.getTime() - RETENTION_W1_LEAD_MS));

      const row = await admin.communicationOutbox.findFirstOrThrow({
        where: { recipientUserId: tenant.ownerId, key: 'retention.video.warning_30d' },
        select: { values: true },
      });
      const values = row.values as Record<string, unknown>;
      expect(values.videoCount).toBe(2);
      expect(values.videoMinutes).toBe(30);
      expect(values.courseCount).toBe(1);
      expect(String(values.courseList)).toContain('w-values course');
      // The dedupe version is the ISO anchor, never a formatted date.
      expect(values.anchorAt).toBe(tenant.trialEndsAt.toISOString());
    }, 60_000);

    it('writes one in-app notification per warning, not one per tick', async () => {
      const tenant = await seedLapsedTrial(
        'w-inapp',
        new Date('2026-01-09T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      const w1DueAt = new Date(tenant.deletionAt.getTime() - RETENTION_W1_LEAD_MS);
      await tick(w1DueAt);
      await tick(new Date(w1DueAt.getTime() + 30 * 60 * 1000));
      await tick(new Date(w1DueAt.getTime() + 90 * 60 * 1000));

      const notifications = await admin.notification.findMany({
        where: { userId: tenant.ownerId },
      });
      expect(notifications).toHaveLength(1);
    }, 60_000);

    it('records the deletion date on the lifecycle state from W1 onward', async () => {
      const tenant = await seedLapsedTrial(
        'w-state',
        new Date('2026-01-10T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await tick(new Date(tenant.deletionAt.getTime() - RETENTION_W1_LEAD_MS));
      const state = await admin.tenantLifecycleState.findUniqueOrThrow({
        where: { organizationId: tenant.organizationId },
      });
      expect(state.deletionScheduledAt?.toISOString()).toBe(
        tenant.deletionAt.toISOString(),
      );
    }, 60_000);
  });

  // =========================================================================
  // THE HORIZON — the guard the production data makes non-hypothetical
  // =========================================================================

  describe('the lateness horizon', () => {
    /**
     * Production is roughly sixteen of seventeen organisations sitting in
     * `trial_expired`, most lapsed months ago. Without the horizon, the
     * first tick after enabling this feature would warn — and, with
     * warnings in place, DELETE — for every one of them at once.
     */
    it('says nothing at all to a tenant who lapsed two years ago', async () => {
      const tenant = await seedLapsedTrial(
        'horizon-old',
        new Date('2024-01-05T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await preWarn(tenant);
      const before = (await keysFor(tenant)).length;

      await tick(new Date('2026-06-01T00:00:00.000Z'));

      expect((await keysFor(tenant)).length).toBe(before);
      expect(assetJobsFor(tenant)).toEqual([]);
    }, 60_000);

    it('does not even fetch such a tenant as a candidate', async () => {
      const tenant = await seedLapsedTrial(
        'horizon-not-a-candidate',
        new Date('2023-05-05T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await tick(new Date('2026-06-01T00:00:00.000Z'));
      // The candidate query is bounded by the same constants the decision
      // uses, so an ancient anchor is never fetched — nothing was said to
      // this tenant and nothing was scheduled for it.
      expect(await keysFor(tenant)).toEqual([]);
      expect(
        await admin.tenantLifecycleState.findUnique({
          where: { organizationId: tenant.organizationId },
        }),
      ).toBeNull();
    }, 60_000);

    it('refuses the deletion once the deletion horizon has passed, warnings and all', async () => {
      const tenant = await seedLapsedTrial(
        'horizon-late-delete',
        new Date('2026-01-11T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await preWarn(tenant);

      const justInside = new Date(
        tenant.deletionAt.getTime() + RETENTION_DELETION_MAX_LATENESS_MS,
      );
      const justOutside = new Date(justInside.getTime() + 1);

      await tick(justOutside);
      expect(assetJobsFor(tenant)).toEqual([]);

      await tick(justInside);
      expect(assetJobsFor(tenant)).toHaveLength(1);
    }, 60_000);
  });

  // =========================================================================
  // REACTIVATION AND HOLDS
  // =========================================================================

  describe('reactivation', () => {
    it.each([
      ['before W1', RETENTION_W1_LEAD_MS],
      ['between W1 and W2', RETENTION_W2_LEAD_MS],
      ['between W2 and W3', RETENTION_W3_LEAD_MS],
      ['at W4', RETENTION_W4_LEAD_MS],
      ['on the deletion day', 0],
    ])(
      '%s, the sequence stops',
      async (label, lead) => {
        const tenant = await seedLapsedTrial(
          `react-${label.replace(/\W+/g, '-')}`,
          new Date('2026-01-12T09:00:00.000Z'),
        );
        await seedVideo(tenant);
        await preWarn(tenant);
        const before = (await keysFor(tenant)).length;

        await admin.tenantSubscription.update({
          where: { organizationId: tenant.organizationId },
          data: {
            status: 'active',
            currentPeriodStart: new Date('2026-01-12T09:00:00.000Z'),
            currentPeriodEnd: new Date('2028-01-12T09:00:00.000Z'),
          },
        });

        await tick(new Date(tenant.deletionAt.getTime() - lead));

        expect((await keysFor(tenant)).length).toBe(before);
        expect(assetJobsFor(tenant)).toEqual([]);
      },
      60_000,
    );
  });

  describe('holds', () => {
    it('a legal hold stops the warnings and the deletion', async () => {
      const tenant = await seedLapsedTrial(
        'hold-legal',
        new Date('2026-01-13T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await preWarn(tenant);
      await admin.tenantLifecycleState.create({
        data: {
          organizationId: tenant.organizationId,
          legalHold: true,
          holdReason: 'court order',
        },
      });
      const before = (await keysFor(tenant)).length;

      const result = await tick(tenant.deletionAt);

      expect(result.organizationsHeld).toBeGreaterThanOrEqual(1);
      expect(assetJobsFor(tenant)).toEqual([]);
      expect((await keysFor(tenant)).length).toBe(before);
    }, 60_000);

    it('an open support case stops them too', async () => {
      const tenant = await seedLapsedTrial(
        'hold-case',
        new Date('2026-01-14T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await preWarn(tenant);
      await admin.supportCase.create({
        data: {
          organizationId: tenant.organizationId,
          subject: 'Please export my data',
          status: 'open',
          requesterName: 'owner',
          requesterEmail: uniqueTestEmail('hold-case-requester'),
        },
      });

      const result = await tick(tenant.deletionAt);

      expect(result.organizationsHeld).toBeGreaterThanOrEqual(1);
      expect(assetJobsFor(tenant)).toEqual([]);
    }, 60_000);

    it('a closed case does not hold anything', async () => {
      const tenant = await seedLapsedTrial(
        'hold-case-closed',
        new Date('2026-01-15T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await preWarn(tenant);
      await admin.supportCase.create({
        data: {
          organizationId: tenant.organizationId,
          subject: 'An old question',
          status: 'closed',
          requesterName: 'owner',
          requesterEmail: uniqueTestEmail('hold-case-closed-requester'),
        },
      });

      await tick(tenant.deletionAt);

      expect(assetJobsFor(tenant)).toHaveLength(1);
    }, 60_000);
  });

  // =========================================================================
  // THE WARNING PRECONDITION AND warn_only
  // =========================================================================

  describe('nothing is deleted that was not warned', () => {
    it('refuses to enqueue a deletion for a tenant with no warnings on record', async () => {
      const tenant = await seedLapsedTrial(
        'precond-none',
        new Date('2026-01-16T09:00:00.000Z'),
      );
      await seedVideo(tenant);

      await tick(tenant.deletionAt);

      expect(assetJobsFor(tenant)).toEqual([]);
    }, 60_000);

    it('refuses when only three of the four warnings exist', async () => {
      const tenant = await seedLapsedTrial(
        'precond-partial',
        new Date('2026-01-17T09:00:00.000Z'),
      );
      await seedVideo(tenant);
      await preWarn(tenant);
      await admin.communicationOutbox.deleteMany({
        where: {
          recipientUserId: tenant.ownerId,
          key: 'retention.video.warning_24h',
        },
      });

      await tick(tenant.deletionAt);

      expect(assetJobsFor(tenant)).toEqual([]);
    }, 60_000);

    it('enqueues one job per asset, plus one tenant job, once all four exist', async () => {
      const tenant = await seedLapsedTrial(
        'precond-full',
        new Date('2026-01-18T09:00:00.000Z'),
      );
      const a = await seedVideo(tenant);
      const b = await seedVideo(tenant);
      await preWarn(tenant);

      await tick(tenant.deletionAt);

      expect(
        assetJobsFor(tenant)
          .map((job) => job.assetId)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      expect(tenantJobsFor(tenant)).toHaveLength(1);
      expect([...tenantJobsFor(tenant)[0].assetIds].sort()).toEqual([a.id, b.id].sort());
      // Deterministic, colon-free ids: a repeated tick re-derives exactly
      // these, and BullMQ rejects the duplicate.
      expect(retentionAssetJobId(a.id, tenant.trialEndsAt)).not.toContain(':');
    }, 60_000);
  });

  describe('warn_only', () => {
    it('sends the warnings and enqueues nothing at all', async () => {
      const tenant = await seedLapsedTrial(
        'warnonly-sweep',
        new Date('2026-01-19T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      setMode('warn_only');
      expect(sweep.mode).toBe('warn_only');

      const result = await tick(tenant.deletionAt);

      // Global, and safely so: `warn_only` is a platform-wide switch, so
      // NOTHING may be enqueued for anyone on this tick.
      expect(result.assetsEnqueued).toBe(0);
      expect(enqueuedAssets).toEqual([]);
      expect(enqueuedTenants).toEqual([]);
      expect((await assetRow(asset.id)).status).toBe('active');
    }, 60_000);

    it('refuses an in-flight deletion job if the mode was turned down', async () => {
      const tenant = await seedLapsedTrial(
        'warnonly-job',
        new Date('2026-01-20T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      setMode('warn_only');
      clock.set(tenant.deletionAt);

      const outcome = await deletion.deleteAsset(
        assetPayload(tenant, asset),
        0,
        tenant.deletionAt,
      );

      expect(outcome).toBe('skipped');
      expect(await assetRow(asset.id)).toMatchObject({
        status: 'active',
        deletedAt: null,
        deletionFailedAt: null,
      });
      // The provider still holds it.
      expect(await fakeVideo.fetchAsset(asset.providerId)).not.toBeNull();
    }, 60_000);
  });

  // =========================================================================
  // THE DELETION ITSELF
  // =========================================================================

  describe('deleting one asset', () => {
    it('deletes at the provider, verifies absence, then writes the tombstone and the audit row', async () => {
      const tenant = await seedLapsedTrial(
        'del-happy',
        new Date('2026-02-01T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant, { durationSeconds: 900, sizeBytes: 999n });
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      // The provider really does hold it beforehand — the probe observes
      // a transition, not an empty fixture.
      expect(await fakeVideo.fetchAsset(asset.providerId)).not.toBeNull();

      const outcome = await deletion.deleteAsset(
        assetPayload(tenant, asset),
        0,
        tenant.deletionAt,
      );

      expect(outcome).toBe('deleted');
      expect(await fakeVideo.fetchAsset(asset.providerId)).toBeNull();
      expect(await assetRow(asset.id)).toMatchObject({
        status: 'deleted',
        deletionFailedAt: null,
        deletionReason: 'retention_trial',
        bytesFreed: 999n,
      });

      const audits = await auditRowsFor(asset.id);
      expect(audits).toHaveLength(1);
      expect(audits[0].organizationId).toBe(tenant.organizationId);
      expect(audits[0].academyId).toBe(tenant.academyId);
      expect(audits[0].context).toMatchObject({
        assetId: asset.id,
        bytes: 999,
        minutes: 15,
        reason: 'retention_trial',
      });
    }, 60_000);

    it('is idempotent — a second run writes no second tombstone and no second audit row', async () => {
      const tenant = await seedLapsedTrial(
        'del-idem',
        new Date('2026-02-02T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      await deletion.deleteAsset(assetPayload(tenant, asset), 0, tenant.deletionAt);
      const second = await deletion.deleteAsset(
        assetPayload(tenant, asset),
        1,
        tenant.deletionAt,
      );

      expect(second).toBe('already_deleted');
      expect(await auditRowsFor(asset.id)).toHaveLength(1);
    }, 60_000);

    /** §31: "a 404 on delete is success". */
    it('treats a provider 404 on delete as success and still verifies before tombstoning', async () => {
      const tenant = await seedLapsedTrial(
        'del-404',
        new Date('2026-02-03T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      const spy = jest
        .spyOn(fakeVideo, 'deleteAsset')
        .mockRejectedValue(Object.assign(new Error('Video not found'), { status: 404 }));
      // The bytes really are gone at the provider, which is what the 404
      // was telling us — so the probe agrees and the tombstone is honest.
      jest.spyOn(fakeVideo, 'fetchAsset').mockResolvedValue(null);

      const outcome = await deletion.deleteAsset(
        assetPayload(tenant, asset),
        0,
        tenant.deletionAt,
      );

      expect(outcome).toBe('deleted');
      expect((await assetRow(asset.id)).status).toBe('deleted');
      spy.mockRestore();
      jest.spyOn(fakeVideo, 'fetchAsset').mockRestore();
    }, 60_000);

    it('leaves the asset active with deletionFailedAt and NO tombstone when the provider fails', async () => {
      const tenant = await seedLapsedTrial(
        'del-fail',
        new Date('2026-02-04T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      const spy = jest
        .spyOn(fakeVideo, 'deleteAsset')
        .mockRejectedValue(
          Object.assign(new Error('503 provider unavailable'), { status: 503 }),
        );

      await expect(
        deletion.deleteAsset(assetPayload(tenant, asset), 0, tenant.deletionAt),
      ).rejects.toThrow(/503/);

      const row = await assetRow(asset.id);
      expect(row.status).toBe('active');
      expect(row.deletedAt).toBeNull();
      expect(row.bytesFreed).toBeNull();
      expect(row.deletionFailedAt).not.toBeNull();
      expect(await auditRowsFor(asset.id)).toHaveLength(0);
      spy.mockRestore();
    }, 60_000);

    /**
     * The failure mode the whole "verify, then tombstone" ordering exists
     * for: the provider says it deleted the asset and the asset is still
     * there. Nothing may be marked deleted.
     */
    it('refuses the tombstone when the provider claims success but the asset is still present', async () => {
      const tenant = await seedLapsedTrial(
        'del-unverified',
        new Date('2026-02-05T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      const deleteSpy = jest.spyOn(fakeVideo, 'deleteAsset').mockResolvedValue(undefined);
      const fetchSpy = jest.spyOn(fakeVideo, 'fetchAsset').mockResolvedValue({
        providerId: asset.providerId,
        status: 'ready',
        durationSeconds: 600,
      });

      await expect(
        deletion.deleteAsset(assetPayload(tenant, asset), 0, tenant.deletionAt),
      ).rejects.toThrow(/not verifiably absent/);

      const row = await assetRow(asset.id);
      expect(row.status).toBe('active');
      expect(row.deletedAt).toBeNull();
      expect(row.deletionFailedAt).not.toBeNull();
      expect(await auditRowsFor(asset.id)).toHaveLength(0);
      deleteSpy.mockRestore();
      fetchSpy.mockRestore();
    }, 60_000);

    it('tells the Platform Owner once the last attempt has failed', async () => {
      const tenant = await seedLapsedTrial(
        'del-escalate',
        new Date('2026-02-06T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      const spy = jest
        .spyOn(fakeVideo, 'deleteAsset')
        .mockRejectedValue(new Error('permanently broken'));

      // Attempts 1..4 stay quiet; the fifth escalates.
      for (let attempt = 0; attempt < VIDEO_RETENTION_ASSET_ATTEMPTS - 1; attempt++) {
        await expect(
          deletion.deleteAsset(assetPayload(tenant, asset), attempt, tenant.deletionAt),
        ).rejects.toThrow();
      }
      // Keyed on the ASSET, not on the recipient: the alert goes to
      // whichever platform-owner account is oldest in this database, which
      // is not necessarily the one this suite created.
      let alerts = await admin.communicationOutbox.count({
        where: { key: 'retention.video.deletion_failed', entityId: asset.id },
      });
      expect(alerts).toBe(0);

      await expect(
        deletion.deleteAsset(
          assetPayload(tenant, asset),
          VIDEO_RETENTION_ASSET_ATTEMPTS - 1,
          tenant.deletionAt,
        ),
      ).rejects.toThrow();

      alerts = await admin.communicationOutbox.count({
        where: { key: 'retention.video.deletion_failed', entityId: asset.id },
      });
      expect(alerts).toBe(1);
      expect((await assetRow(asset.id)).status).toBe('active');
      spy.mockRestore();
    }, 90_000);
  });

  // =========================================================================
  // THE RACE
  // =========================================================================

  describe('a race with reactivation resolves in favour of the customer', () => {
    it('keeps the video of a tenant who paid while the job sat in the queue', async () => {
      const tenant = await seedLapsedTrial(
        'race-pay',
        new Date('2026-03-01T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);

      // The sweep authorises the deletion...
      await tick(tenant.deletionAt);
      expect(enqueuedAssets).toHaveLength(1);

      // ...and the customer pays before the worker gets to it.
      await admin.tenantSubscription.update({
        where: { organizationId: tenant.organizationId },
        data: {
          status: 'active',
          currentPeriodStart: tenant.deletionAt,
          currentPeriodEnd: new Date(tenant.deletionAt.getTime() + 365 * DAY),
        },
      });

      const outcome = await deletion.deleteAsset(
        enqueuedAssets[0],
        0,
        new Date(tenant.deletionAt.getTime() + 30 * 1000),
      );

      expect(outcome).toBe('skipped');
      expect((await assetRow(asset.id)).status).toBe('active');
      expect(await fakeVideo.fetchAsset(asset.providerId)).not.toBeNull();
    }, 60_000);

    it('keeps the video of a tenant put on legal hold while the job sat in the queue', async () => {
      const tenant = await seedLapsedTrial(
        'race-hold',
        new Date('2026-03-02T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      await tick(tenant.deletionAt);
      expect(enqueuedAssets).toHaveLength(1);

      await admin.tenantLifecycleState.upsert({
        where: { organizationId: tenant.organizationId },
        create: { organizationId: tenant.organizationId, legalHold: true },
        update: { legalHold: true },
      });

      const outcome = await deletion.deleteAsset(
        enqueuedAssets[0],
        0,
        new Date(tenant.deletionAt.getTime() + 30 * 1000),
      );

      expect(outcome).toBe('skipped');
      expect((await assetRow(asset.id)).status).toBe('active');
    }, 60_000);

    it('refuses a job whose anchor no longer matches the live subscription', async () => {
      const tenant = await seedLapsedTrial(
        'race-anchor',
        new Date('2026-03-03T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      const outcome = await deletion.deleteAsset(
        {
          ...assetPayload(tenant, asset),
          anchorAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
        },
        0,
        tenant.deletionAt,
      );

      expect(outcome).toBe('skipped');
      expect((await assetRow(asset.id)).status).toBe('active');
    }, 60_000);
  });

  // =========================================================================
  // THE D EMAIL
  // =========================================================================

  describe('the tenant-level completion email', () => {
    it('is sent once every asset has settled, and reports zero failures honestly', async () => {
      const tenant = await seedLapsedTrial(
        'd-clean',
        new Date('2026-04-01T09:00:00.000Z'),
      );
      const a = await seedVideo(tenant, { durationSeconds: 600 });
      const b = await seedVideo(tenant, { durationSeconds: 600 });
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      await deletion.deleteAsset(assetPayload(tenant, a), 0, tenant.deletionAt);
      await deletion.deleteAsset(assetPayload(tenant, b), 0, tenant.deletionAt);

      const outcome = await deletion.settleTenant(
        {
          organizationId: tenant.organizationId,
          anchorAt: tenant.trialEndsAt.toISOString(),
          assetIds: [a.id, b.id],
        },
        tenant.deletionAt,
      );

      expect(outcome).toBe('sent');
      const row = await admin.communicationOutbox.findFirstOrThrow({
        where: { recipientUserId: tenant.ownerId, key: 'retention.video.deleted' },
        select: { values: true },
      });
      expect(row.values).toMatchObject({
        deletedCount: 2,
        deletedMinutes: 20,
        failedCount: 0,
      });
    }, 90_000);

    it('waits rather than lying while an asset is still in flight', async () => {
      const tenant = await seedLapsedTrial(
        'd-pending',
        new Date('2026-04-02T09:00:00.000Z'),
      );
      const a = await seedVideo(tenant);
      const b = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      await deletion.deleteAsset(assetPayload(tenant, a), 0, tenant.deletionAt);

      await expect(
        deletion.settleTenant(
          {
            organizationId: tenant.organizationId,
            anchorAt: tenant.trialEndsAt.toISOString(),
            assetIds: [a.id, b.id],
          },
          tenant.deletionAt,
        ),
      ).rejects.toThrow(/have not settled/);

      expect(
        await admin.communicationOutbox.count({
          where: { recipientUserId: tenant.ownerId, key: 'retention.video.deleted' },
        }),
      ).toBe(0);
    }, 90_000);

    it('is honest about a partial failure rather than claiming a clean sweep', async () => {
      const tenant = await seedLapsedTrial(
        'd-partial',
        new Date('2026-04-03T09:00:00.000Z'),
      );
      const good = await seedVideo(tenant, { durationSeconds: 600 });
      const bad = await seedVideo(tenant, { durationSeconds: 600 });
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      await deletion.deleteAsset(assetPayload(tenant, good), 0, tenant.deletionAt);

      const spy = jest
        .spyOn(fakeVideo, 'deleteAsset')
        .mockRejectedValue(new Error('provider refused'));
      await expect(
        deletion.deleteAsset(assetPayload(tenant, bad), 0, tenant.deletionAt),
      ).rejects.toThrow();
      spy.mockRestore();

      const outcome = await deletion.settleTenant(
        {
          organizationId: tenant.organizationId,
          anchorAt: tenant.trialEndsAt.toISOString(),
          assetIds: [good.id, bad.id],
        },
        tenant.deletionAt,
      );

      expect(outcome).toBe('sent');
      const row = await admin.communicationOutbox.findFirstOrThrow({
        where: { recipientUserId: tenant.ownerId, key: 'retention.video.deleted' },
        select: { values: true },
      });
      expect(row.values).toMatchObject({ deletedCount: 1, failedCount: 1 });
      // The one that failed is still there, and still says so.
      const failed = await assetRow(bad.id);
      expect(failed.status).toBe('active');
      expect(failed.deletionFailedAt).not.toBeNull();
    }, 90_000);

    it('says nothing when nothing was deleted', async () => {
      const tenant = await seedLapsedTrial(
        'd-nothing',
        new Date('2026-04-04T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);

      const spy = jest
        .spyOn(fakeVideo, 'deleteAsset')
        .mockRejectedValue(new Error('provider refused'));
      await expect(
        deletion.deleteAsset(assetPayload(tenant, asset), 0, tenant.deletionAt),
      ).rejects.toThrow();
      spy.mockRestore();

      const outcome = await deletion.settleTenant(
        {
          organizationId: tenant.organizationId,
          anchorAt: tenant.trialEndsAt.toISOString(),
          assetIds: [asset.id],
        },
        tenant.deletionAt,
      );

      expect(outcome).toBe('nothing_deleted');
      expect(
        await admin.communicationOutbox.count({
          where: { recipientUserId: tenant.ownerId, key: 'retention.video.deleted' },
        }),
      ).toBe(0);
    }, 60_000);

    it('emits D at most once per anchor, however often the job is retried', async () => {
      const tenant = await seedLapsedTrial(
        'd-dedupe',
        new Date('2026-04-05T09:00:00.000Z'),
      );
      const asset = await seedVideo(tenant);
      await preWarn(tenant);
      clock.set(tenant.deletionAt);
      await deletion.deleteAsset(assetPayload(tenant, asset), 0, tenant.deletionAt);

      const payload = {
        organizationId: tenant.organizationId,
        anchorAt: tenant.trialEndsAt.toISOString(),
        assetIds: [asset.id],
      };
      expect(await deletion.settleTenant(payload, tenant.deletionAt)).toBe('sent');
      expect(await deletion.settleTenant(payload, tenant.deletionAt)).toBe('deduped');
      expect(
        await admin.communicationOutbox.count({
          where: { recipientUserId: tenant.ownerId, key: 'retention.video.deleted' },
        }),
      ).toBe(1);
    }, 60_000);
  });

  // =========================================================================
  // WHAT IS NOT TOUCHED
  // =========================================================================

  describe('only protected hosted video is ever deleted', () => {
    it('ignores images, documents, public video and already-archived rows', async () => {
      const tenant = await seedLapsedTrial('scope', new Date('2026-05-01T09:00:00.000Z'));
      const video = await seedVideo(tenant);
      await preWarn(tenant);

      const untouched = await Promise.all([
        admin.mediaAsset.create({
          data: {
            academyId: tenant.academyId,
            type: 'image',
            access: 'public',
            provider: 'r2',
            status: 'active',
            fileName: 'logo.png',
            storageKey: `academies/${tenant.academyId}/logo.png`,
            url: 'https://cdn.test.local/logo.png',
            mimeType: 'image/png',
            sizeBytes: 100n,
          },
        }),
        admin.mediaAsset.create({
          data: {
            academyId: tenant.academyId,
            type: 'document',
            access: 'protected',
            provider: 'r2',
            status: 'active',
            fileName: 'handbook.pdf',
            storageKey: `academies/${tenant.academyId}/handbook.pdf`,
            url: 'https://protected.test.local/handbook.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 200n,
          },
        }),
        admin.mediaAsset.create({
          data: {
            academyId: tenant.academyId,
            type: 'video',
            access: 'public',
            provider: 'r2_worker',
            status: 'active',
            fileName: 'promo.mp4',
            storageKey: `academies/${tenant.academyId}/promo.mp4`,
            url: 'https://cdn.test.local/promo.mp4',
            mimeType: 'video/mp4',
            sizeBytes: 300n,
          },
        }),
        admin.mediaAsset.create({
          data: {
            academyId: tenant.academyId,
            type: 'video',
            access: 'protected',
            provider: 'r2_worker',
            status: 'archived',
            fileName: 'old.mp4',
            storageKey: `academies/${tenant.academyId}/old.mp4`,
            url: 'https://protected.test.local/old.mp4',
            mimeType: 'video/mp4',
            sizeBytes: 400n,
          },
        }),
      ]);

      await tick(tenant.deletionAt);

      expect(assetJobsFor(tenant).map((job) => job.assetId)).toEqual([video.id]);
      for (const row of untouched) {
        const after = await admin.mediaAsset.findUniqueOrThrow({
          where: { id: row.id },
          select: { status: true, deletedAt: true },
        });
        expect(after.deletedAt).toBeNull();
        expect(after.status).not.toBe('deleted');
      }
    }, 60_000);
  });
});
