/**
 * `GET /organizations/:id/retention` — the customer-facing read behind
 * `/dashboard/tenant/retention` (P64 Communications C6, plan §31/§32).
 *
 * WHAT THIS SUITE IS FOR. The warning emails have always linked to that
 * page; until this endpoint existed the link had no destination. What is
 * asserted here is therefore not arithmetic — `video-retention.util.spec`
 * already pins every boundary of the evaluator without any I/O — but the
 * two things only a real database, real guards and real RLS can settle:
 *
 *   1. AUTHORIZATION. The owner of the organisation sees its state; a
 *      member of a DIFFERENT organisation gets nothing; and a member of
 *      the SAME organisation who is not its owner also gets nothing,
 *      because this page names the account's courses, its stored minutes
 *      and the date its content is destroyed.
 *
 *   2. HONESTY IN THE QUIET CASES. An organisation with no open window
 *      gets the "nothing is scheduled" payload and a 200 — not a 404,
 *      not an error — because "you have video and none of it is
 *      scheduled for deletion" is the most reassuring thing this endpoint
 *      can say and an error says it as a failure. A held organisation
 *      says so. And `video.deletedAssetCount` is 0 wherever nothing has
 *      been deleted, which is the fact the page leads with.
 *
 * NO FAKE CLOCK. Every fixture's anchor is positioned relative to REAL
 * time (a trial that lapsed 65 days ago puts the deletion 25 days out and
 * W1 five days in the past), so the endpoint is exercised on the same
 * clock a browser would hit it on. The evaluator's own boundaries are
 * tested elsewhere; what matters here is that a real request through real
 * guards returns the real state.
 *
 * NOTHING IS DELETED BY THIS SUITE. The flag is `warn_only`, the sweep
 * never runs (its scheduler and processor are inert), and no deletion job
 * is enqueued. The fixtures are removed in `afterAll` all the same, for
 * the reason the C6 sweep suite documents: a lapsed fixture sits inside a
 * retention window forever.
 */
process.env.FLAG_VIDEO_RETENTION_MODE = 'warn_only';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
  seedPlan,
} from './utils/db-admin';
import { ORGANIZATION_MANAGER_PERMISSIONS } from '../src/tenancy/constants/organization-permissions.constants';
import { VideoRetentionProcessor } from '../src/retention/queue/video-retention.processor';
import { VideoRetentionScheduler } from '../src/retention/queue/video-retention.scheduler';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import {
  RETENTION_W1_LEAD_MS,
  RETENTION_WINDOW_TRIAL_MS,
} from '../src/retention/utils/video-retention.util';
import type { TenantRetentionResponse } from '../src/retention/dto/tenant-retention.contract';

const DAY = 24 * 60 * 60 * 1000;

/** Queue workers off — this suite only ever reads. */
class Inert {}

interface Signed {
  readonly userId: string;
  readonly accessToken: string;
}

async function signUpAndSignIn(app: INestApplication, label: string): Promise<Signed> {
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

describe('P64 C6 — tenant retention page read (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  /** The mutable half of the loaded config — what the service actually reads. */
  let commsConfig: { videoRetentionMode: 'off' | 'warn_only' | 'on' };

  const seededOrganizationIds: string[] = [];
  const seededUserIds: string[] = [];

  /** A lapsed trial 65 days old: deletion 25 days out, W1 five days past. */
  const anchorAt = new Date(Date.now() - 65 * DAY);
  const expectedDeletionAt = new Date(anchorAt.getTime() + RETENTION_WINDOW_TRIAL_MS);

  let owner: Signed;
  let organizationId: string;
  let academyId: string;
  let courseId: string;

  /** A second, unrelated tenant — the cross-tenant probe. */
  let stranger: Signed;
  let strangerOrganizationId: string;

  /** A Manager inside the SAME organisation — the in-tenant probe. */
  let manager: Signed;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
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
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    commsConfig = app
      .get(ConfigService, { strict: false })
      .getOrThrow('communications') as typeof commsConfig;

    /*
      Flushed between sign-ups: three registrations from one address in
      one breath is exactly what the auth rate limiter exists to stop, and
      a fixture tripping it would fail this suite for a reason that has
      nothing to do with retention.
    */
    await flushRateLimitKeys();
    owner = await signUpAndSignIn(app, 'ret-page-owner');
    await flushRateLimitKeys();
    stranger = await signUpAndSignIn(app, 'ret-page-stranger');
    await flushRateLimitKeys();
    manager = await signUpAndSignIn(app, 'ret-page-manager');
    seededUserIds.push(owner.userId, stranger.userId, manager.userId);

    // --- the tenant in a retention warning -----------------------------------
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'ret-page-org');
    organizationId = org.id;
    seededOrganizationIds.push(org.id);
    const plan = await seedPlan(admin, 'ret-page-plan');
    await admin.tenantSubscription.create({
      data: {
        organizationId,
        planId: plan.id,
        status: 'trial_expired',
        trialEndsAt: anchorAt,
      },
    });
    const academy = await seedAcademy(admin, organizationId, 'ret-page-academy');
    academyId = academy.id;
    const course = await seedCourse(admin, academyId, 'Retention page course');
    courseId = course.id;
    // Two protected hosted videos, 10 and 20 minutes.
    await seedVideo(600);
    await seedVideo(1200);
    /*
      A REAL Manager of the same organisation — the membership carries the
      genuine `ORGANIZATION_MANAGER_PERMISSIONS`, not an empty array, so
      the refusal below proves the owner-exclusive marker is missing from
      the manager set rather than proving the fixture forgot to grant
      anything.
    */
    const managerMembership = await seedMembership(
      admin,
      organizationId,
      manager.userId,
      'manager',
    );
    await admin.organizationMembership.update({
      where: { id: managerMembership.id },
      data: { permissions: [...ORGANIZATION_MANAGER_PERMISSIONS] },
    });

    // Only W1 has gone out. W2-W4 are still ahead.
    await forgeWarning('retention_warning_30d', 'retention.video.warning_30d');

    // --- an unrelated, healthy tenant ----------------------------------------
    const other = await seedOrganizationWithOwner(
      admin,
      stranger.userId,
      'ret-page-other-org',
    );
    strangerOrganizationId = other.id;
    seededOrganizationIds.push(other.id);
    await seedActiveSubscriptionForOrg(admin, other.id, 'ret-page-other');
  }, 180_000);

  afterAll(async () => {
    commsConfig.videoRetentionMode = 'warn_only';
    await admin.organization.deleteMany({
      where: { id: { in: seededOrganizationIds } },
    });
    await admin.user.deleteMany({ where: { id: { in: seededUserIds } } });
    await admin.$disconnect();
    await app.close();
    delete process.env.FLAG_VIDEO_RETENTION_MODE;
  }, 60_000);

  beforeEach(async () => {
    commsConfig.videoRetentionMode = 'warn_only';
    await flushRateLimitKeys();
  });

  // --- helpers ---------------------------------------------------------------

  async function seedVideo(durationSeconds: number): Promise<void> {
    const providerId = `ret-page-${Math.random().toString(36).slice(2)}`;
    await admin.mediaAsset.create({
      data: {
        academyId,
        courseId,
        type: 'video',
        access: 'protected',
        provider: 'r2_worker',
        providerId,
        processingStatus: 'ready',
        status: 'active',
        securityTier: 'normal',
        fileName: `${providerId}.mp4`,
        storageKey: `fake-video/${providerId}.mp4`,
        url: `https://protected.test.local/${providerId}.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: 10_000_000n,
        durationSeconds,
      },
    });
  }

  /** An outbox row shaped exactly as the sweep writes it, for THIS anchor. */
  async function forgeWarning(step: string, key: string): Promise<void> {
    await admin.communicationOutbox.create({
      data: {
        key,
        category: 'lifecycle',
        recipientUserId: owner.userId,
        organizationId,
        entityType: 'tenant_subscription',
        entityId: organizationId,
        dedupeKey: `lifecycle_${step}:${organizationId}:${anchorAt.toISOString()}`,
        channels: { inApp: true, email: 'always' },
        state: 'dispatched',
      },
    });
  }

  function get(orgId: string, token: string) {
    return request(app.getHttpServer())
      .get(`/organizations/${orgId}/retention`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function fetchOwnerState(): Promise<TenantRetentionResponse> {
    const response = await get(organizationId, owner.accessToken).expect(200);
    return response.body as TenantRetentionResponse;
  }

  // --- the owner sees their own state ---------------------------------------

  it('answers WHAT, WHEN and WHY for the owner of a lapsing organisation', async () => {
    const body = await fetchOwnerState();

    // WHY: a formerly-trialing tenant, and the rule is stated, not implied.
    expect(body.windowOpen).toBe(true);
    expect(body.origin).toBe('trial');
    expect(body.windowDays).toBe(90);
    expect(body.anchorAt).toBe(anchorAt.toISOString());

    // WHEN: the exact date, derived from the same evaluator the sweep uses.
    expect(body.deletionAt).toBe(expectedDeletionAt.toISOString());
    expect(body.daysUntilDeletion).toBeGreaterThan(20);
    expect(body.daysUntilDeletion).toBeLessThanOrEqual(25);

    // WHAT: two videos, half an hour, one course.
    expect(body.video.assetCount).toBe(2);
    expect(body.video.storedMinutes).toBe(30);
    expect(body.video.storedBytes).toBe('20000000');
    expect(body.courses).toHaveLength(1);
    expect(body.courses[0]).toMatchObject({
      id: courseId,
      title: 'Retention page course',
      videoCount: 2,
      storedMinutes: 30,
    });
    expect(body.coursesTruncated).toBe(false);
  });

  it('reports the W1-W4 timeline with only the warnings that were really sent', async () => {
    const body = await fetchOwnerState();

    expect(body.warnings.map((row) => row.step)).toEqual([
      'retention_warning_30d',
      'retention_warning_14d',
      'retention_warning_7d',
      'retention_warning_24h',
    ]);
    // W1's due date is the deletion date minus its own lead — the page and
    // the evaluator cannot disagree, because they use the same constant.
    expect(body.warnings[0].dueAt).toBe(
      new Date(expectedDeletionAt.getTime() - RETENTION_W1_LEAD_MS).toISOString(),
    );
    expect(body.warnings.map((row) => row.sent)).toEqual([true, false, false, false]);
    // A warning has been sent, so this is the state the emails link from.
    expect(body.state).toBe('warning');
  });

  it('says plainly that nothing has been deleted, because nothing has', async () => {
    const body = await fetchOwnerState();
    expect(body.video.deletedAssetCount).toBe(0);
    expect(body.video.lastDeletedAt).toBeNull();
    // The assets are still active in the database, which is what that means.
    const live = await admin.mediaAsset.count({
      where: { academyId, status: 'active', type: 'video' },
    });
    expect(live).toBe(2);
  });

  it('tells the truth about the flag: warn_only now, off when it is off', async () => {
    expect((await fetchOwnerState()).mode).toBe('warn_only');

    commsConfig.videoRetentionMode = 'off';
    const off = await fetchOwnerState();
    expect(off.mode).toBe('off');
    // The window is still open and the date is still real — what changed is
    // that nothing will act on it, and the payload says so rather than
    // hiding the date or implying a deletion that cannot happen.
    expect(off.windowOpen).toBe(true);
    expect(off.deletionAt).toBe(expectedDeletionAt.toISOString());
  });

  // --- a hold freezes the clock, and the page says so ------------------------

  it('reports a legal hold instead of a countdown', async () => {
    await admin.tenantLifecycleState.upsert({
      where: { organizationId },
      create: { organizationId, legalHold: true, holdReason: 'internal note' },
      update: { legalHold: true, holdReason: 'internal note' },
    });
    try {
      const body = await fetchOwnerState();
      expect(body.state).toBe('held');
      expect(body.hold.held).toBe(true);
      expect(body.hold.reason).toBe('legal_hold');
      // The operator's free-text note is never forwarded to the customer.
      expect(JSON.stringify(body)).not.toContain('internal note');
      // The date is still reported — a hold suspends the sequence, it does
      // not erase the window, and the owner is entitled to both facts.
      expect(body.deletionAt).toBe(expectedDeletionAt.toISOString());
    } finally {
      await admin.tenantLifecycleState.update({
        where: { organizationId },
        data: { legalHold: false, holdReason: null },
      });
    }
  });

  // --- nothing scheduled is a 200, not an error ------------------------------

  it('returns the "nothing scheduled" shape for an organisation with no open window', async () => {
    const response = await get(strangerOrganizationId, stranger.accessToken).expect(200);
    const body = response.body as TenantRetentionResponse;

    expect(body.state).toBe('not_scheduled');
    expect(body.windowOpen).toBe(false);
    expect(body.origin).toBeNull();
    expect(body.deletionAt).toBeNull();
    expect(body.daysUntilDeletion).toBeNull();
    expect(body.warnings).toEqual([]);
    expect(body.hold).toEqual({ held: false, reason: null });
    expect(body.video.deletedAssetCount).toBe(0);
  });

  // --- authorization ---------------------------------------------------------

  it('gives a member of ANOTHER organisation nothing', async () => {
    await get(organizationId, stranger.accessToken).expect(403);
  });

  it('gives a Manager of the SAME organisation nothing — this page is owner-only', async () => {
    // The manager really does hold the manager permission set; what it
    // does not hold is the owner-exclusive billing marker.
    expect(ORGANIZATION_MANAGER_PERMISSIONS).not.toContain(
      'tenant.subscription.view',
    );
    await get(organizationId, manager.accessToken).expect(403);
  });

  it('refuses an unauthenticated caller', async () => {
    await request(app.getHttpServer())
      .get(`/organizations/${organizationId}/retention`)
      .expect(401);
  });
});
