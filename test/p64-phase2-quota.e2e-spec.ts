/**
 * P64 Phase 2 — `videoStorageMinutes`, the provider-independent video
 * quota (master plan D5, AD-14; Phase 2 §D.5, §L, §V).
 *
 * THE FOUR CLAIMS THIS FILE EXISTS TO PROVE, each of which is a place the
 * quota could silently stop bounding anything:
 *
 *   1. Enforcement happens BEFORE the upload URL is issued. A check after
 *      the fact leaves bytes with a provider that Atlas then has to delete,
 *      and a tenant who ignores the error keeps the video.
 *   2. Usage counts EVERY provider-hosted video, not one (AD-14). The
 *      filter this replaces was `provider: 'cloudflare_stream'`, under
 *      which a whole tier was invisible to the quota meant to bound it.
 *   3. Usage is RECONCILED once the real duration is known, and may
 *      legitimately go DOWN: the reservation held the declared maximum,
 *      and the measured figure is usually smaller.
 *   4. The two independent aggregates — `EntitlementEnforcementService`
 *      (the gate) and `TenantUsageRecomputeService` (the Usage page) —
 *      agree. If they drift, a customer is told two different numbers and
 *      one of them is what they are billed against.
 *
 * D5 spells the arithmetic out and this file uses those exact figures:
 * 1,850 + 180 = 2,030 > 2,000 → reject; 1,850 + 100 = 1,950 → allow.
 *
 * Harness: identical to `p64-phase2-api.e2e-spec.ts` — real Postgres,
 * Redis and MinIO, with the two production video adapters made available
 * (a real `BasicVideoProvider` against the real bucket, and the real
 * `CloudflareStreamProvider` with only its HTTP calls replaced).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { FeatureFlagsService } from '../src/common/flags/feature-flags.service';
import { CloudflareStreamProvider } from '../src/media/video/cloudflare-stream.provider';
import { BasicVideoProvider } from '../src/media/video/basic-video.provider';
import { ProtectedMediaStorage } from '../src/media/storage/protected-media-storage.provider';
import { EntitlementEnforcementService } from '../src/plans/services/entitlement-enforcement.service';
import { TenantUsageRecomputeService } from '../src/plans/services/tenant-usage-recompute.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { ConfigService } from '@nestjs/config';
import type { PlanFamily, PlanTier, PrismaClient } from '@prisma/client';
import type {
  BasicVideoConfig,
  LearningFeatureFlags,
  VideoProviderConfig,
} from '../src/config/configuration';
import type {
  CreateDirectUploadInput,
  CreatedDirectUpload,
  ProviderVideoAsset,
} from '../src/media/video/video-provider.interface';

const PASSWORD = 'correct-horse-battery';

const basicConfig: {
  deliveryHost?: string;
  signingSecret?: string;
  playbackTtlSeconds: number;
  revocationEndpoint?: string;
  revocationToken?: string;
  allowedOriginsConfigured: boolean;
} = {
  deliveryHost: 'video.atlas.test',
  signingSecret: 'p64-phase2-quota-signing-secret',
  playbackTtlSeconds: 600,
  revocationEndpoint: 'https://video.atlas.test/__revocations',
  revocationToken: 'p64-phase2-quota-revocation-token',
  allowedOriginsConfigured: true,
};

const streamKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const STREAM_CONFIG: VideoProviderConfig = {
  provider: 'cloudflare_stream',
  accountId: 'cf-account-id',
  apiToken: 'cf-api-token',
  signingKeyId: 'cf-signing-key-id',
  signingKeyPem: streamKeyPair.privateKey,
  webhookSecret: 'cf-webhook-secret',
  customerSubdomain: 'customer-p64-quota.cloudflarestream.com',
  playbackTokenTtlSeconds: 2 * 60 * 60,
};

/** Counts direct-upload requests, so "the URL was never issued" is provable rather than inferred. */
const providerCalls = { stream: 0, basic: 0 };
/** Set by one test to make the provider fail AFTER the reservation was written. */
const basicFailure = { next: false };

class TestStreamProvider extends CloudflareStreamProvider {
  private readonly assets = new Map<string, ProviderVideoAsset>();

  createDirectUpload(): Promise<CreatedDirectUpload> {
    providerCalls.stream += 1;
    const providerId = `cfuid${randomUUID().replace(/-/g, '')}`;
    this.assets.set(providerId, { providerId, status: 'processing', durationSeconds: null });
    return Promise.resolve({
      providerId,
      uploadUrl: `https://upload.videodelivery.net/${providerId}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
  }

  fetchAsset(providerId: string): Promise<ProviderVideoAsset | null> {
    return Promise.resolve(this.assets.get(providerId) ?? null);
  }

  deleteAsset(): Promise<void> {
    return Promise.resolve();
  }

  syncAllowedOrigins(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The real Normal adapter, counted — and able to fail on demand.
 *
 * A provider failure AFTER the reservation is written is the one case
 * `releaseReservation` exists for, and a tenant cannot see or delete a
 * stranded reservation themselves, so it has to be tested rather than
 * reasoned about.
 */
class CountingBasicVideoProvider extends BasicVideoProvider {
  createDirectUpload(input: CreateDirectUploadInput): Promise<CreatedDirectUpload> {
    providerCalls.basic += 1;
    if (basicFailure.next) {
      basicFailure.next = false;
      return Promise.reject(new Error('Simulated provider outage during direct upload.'));
    }
    return super.createDirectUpload(input);
  }
}

const flags: { value: LearningFeatureFlags } = {
  value: {
    contentProtected: { mode: 'on', academyIds: [] },
    videoNormal: { mode: 'on', academyIds: [] },
    videoPremium: { mode: 'on', academyIds: [] },
    devicesPolicy: { mode: 'on', academyIds: [] },
    learnerDashboardV2: { mode: 'on', academyIds: [] },
    playerV2: { mode: 'on', academyIds: [] },
  },
};

function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function faststartMp4(durationSeconds: number): Buffer {
  const timescale = 600;
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt8(0, 0);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(durationSeconds * timescale, 16);
  return Buffer.concat([
    isoBox('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1')),
    isoBox('moov', isoBox('mvhd', mvhd)),
    isoBox('mdat', Buffer.alloc(4096)),
  ]);
}

describe('P64 Phase 2 — videoStorageMinutes quota (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let enforcement: EntitlementEnforcementService;
  let recompute: TenantUsageRecomputeService;
  let tenancy: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(FeatureFlagsService)
          .useValue(
            new FeatureFlagsService({ get: () => flags.value } as unknown as ConfigService),
          )
          .overrideProvider(CloudflareStreamProvider)
          .useValue(
            new TestStreamProvider({
              getOrThrow: () => STREAM_CONFIG,
            } as unknown as ConfigService),
          )
          .overrideProvider(BasicVideoProvider)
          .useFactory({
            factory: (storage: ProtectedMediaStorage) =>
              new CountingBasicVideoProvider(
                {
                  getOrThrow: () => basicConfig as BasicVideoConfig,
                } as unknown as ConfigService,
                storage,
              ),
            inject: [ProtectedMediaStorage],
          }),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    enforcement = app.get(EntitlementEnforcementService, { strict: false });
    recompute = app.get(TenantUsageRecomputeService, { strict: false });
    tenancy = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    providerCalls.stream = 0;
    providerCalls.basic = 0;
    basicFailure.next = false;
    await flushRateLimitKeys();
  });

  async function staffAccount(label: string) {
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
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  async function world(
    label: string,
    options: {
      family?: PlanFamily;
      tier?: PlanTier;
      /** Omit to model a plan row that predates the key — which resolves to ZERO, never unlimited. */
      videoStorageMinutes?: number | 'unlimited' | undefined;
      omitQuotaKey?: boolean;
      grantedLimits?: Record<string, number | 'unlimited'>;
    } = {},
  ) {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const limits: Record<string, number | 'unlimited'> = {
      academies: 50,
      students: 500,
      instructors: 50,
      staff: 50,
      courses: 200,
      generalStorage: 100,
      videoStorage: 100,
    };
    if (!options.omitQuotaKey) {
      limits.videoStorageMinutes = options.videoStorageMinutes ?? 2_000;
    }
    const plan = await seedPlan(admin, `${label}-plan`, { limits });
    await admin.plan.update({
      where: { id: plan.id },
      data: { family: options.family ?? 'normal', tier: options.tier ?? 'growth' },
    });
    await seedTenantSubscription(admin, org.id, plan.id, {
      status: 'active',
      grantedLimits: options.grantedLimits,
    });
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    return { owner, org, plan, academy, course };
  }

  /** Existing hosted video, already reconciled — the "used" side of D5's arithmetic. */
  async function seedHostedVideo(
    academyId: string,
    durationSeconds: number,
    provider: 'r2_worker' | 'cloudflare_stream' = 'r2_worker',
    sizeBytes = 0,
  ) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return admin.mediaAsset.create({
      data: {
        academyId,
        type: 'video',
        status: 'active',
        fileName: `seeded-${suffix}.mp4`,
        storageKey: provider === 'r2_worker' ? `academies/${academyId}/${suffix}.mp4` : '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(sizeBytes),
        access: 'protected',
        provider,
        providerId: `${provider}-${suffix}`,
        processingStatus: 'ready',
        durationSeconds,
        durationSource: 'measured',
        securityTier: provider === 'cloudflare_stream' ? 'premium' : 'normal',
      },
    });
  }

  function createUpload(
    w: { academy: { id: string }; owner: { auth: Record<string, string> } },
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads`)
      .set(w.owner.auth)
      .send(body);
  }

  async function putBytes(uploadUrl: string, body: Buffer): Promise<number> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'content-type': 'video/mp4' },
    });
    return response.status;
  }

  /** The ENFORCEMENT aggregate — the number the upload gate actually uses. */
  async function enforcedUsage(organizationId: string) {
    return tenancy.runInTenantContext(organizationId, (tx) =>
      enforcement.videoMinutesSnapshot(tx, organizationId),
    );
  }

  /** The REPORTING aggregate — the number the staff Usage page shows. */
  async function reportedUsage(
    w: { org: { id: string }; owner: { auth: Record<string, string> } },
  ) {
    await recompute.recomputeOne(w.org.id);
    const response = await request(app.getHttpServer())
      .get(`/organizations/${w.org.id}/usage`)
      .set(w.owner.auth)
      .expect(200);
    return response.body;
  }

  // =========================================================================
  // 1. Enforcement BEFORE the upload URL is issued (D5, AD-14).
  // =========================================================================

  it("applies D5's exact arithmetic: 1,850 + 180 > 2,000 rejects; 1,850 + 100 allows", async () => {
    const w = await world('quota-arithmetic', { videoStorageMinutes: 2_000 });
    await seedHostedVideo(w.academy.id, 1_850 * 60);

    const rejected = await createUpload(w, {
      fileName: 'too-long.mp4',
      maxDurationSeconds: 180 * 60,
      courseId: w.course.id,
    }).expect(409);

    expect(rejected.body.error).toMatchObject({
      status: 409,
      messageKey: 'errors.entitlement.videoStorageMinutesExceeded',
      code: 'ENTITLEMENT_VIDEO_MINUTES_EXCEEDED',
      details: {
        used: 1_850,
        quota: 2_000,
        requested: 180,
        // The uploader has to be told how much room is left, not left to
        // guess how much to trim.
        remaining: 150,
      },
    });

    // NOTHING WAS ISSUED AND NOTHING WAS RESERVED. A refusal that had
    // already asked the provider for a URL would leave bytes to clean up.
    expect(providerCalls.basic).toBe(0);
    expect(providerCalls.stream).toBe(0);
    const rows = await admin.mediaAsset.count({
      where: { academyId: w.academy.id, processingStatus: { not: 'ready' } },
    });
    expect(rows).toBe(0);

    const accepted = await createUpload(w, {
      fileName: 'fits.mp4',
      maxDurationSeconds: 100 * 60,
      courseId: w.course.id,
    }).expect(201);
    expect(accepted.body.reservedMinutes).toBe(100);
    expect(providerCalls.basic).toBe(1);
  });

  it('counts an in-flight RESERVATION at once, so concurrent uploads cannot collectively overflow', async () => {
    const w = await world('quota-reservation', { videoStorageMinutes: 100 });

    const first = await createUpload(w, {
      fileName: 'first.mp4',
      maxDurationSeconds: 60 * 60,
      courseId: w.course.id,
    }).expect(201);
    expect(first.body.reservedMinutes).toBe(60);

    // The first upload has not finished — its bytes are not even uploaded —
    // but its reservation already holds 60 of the 100 minutes.
    const second = await createUpload(w, {
      fileName: 'second.mp4',
      maxDurationSeconds: 60 * 60,
      courseId: w.course.id,
    }).expect(409);
    expect(second.body.error.details).toMatchObject({
      used: 60,
      quota: 100,
      requested: 60,
      remaining: 40,
    });

    const snapshot = await enforcedUsage(w.org.id);
    expect(snapshot).toMatchObject({ usedMinutes: 60, quota: 100 });
  });

  it('rounds a reservation UP, so short clips cannot be used to exceed a minute-denominated quota', async () => {
    const w = await world('quota-rounding', { videoStorageMinutes: 2 });

    // 90 seconds is two minutes of a minute-denominated quota.
    const ticket = await createUpload(w, {
      fileName: 'ninety-seconds.mp4',
      maxDurationSeconds: 90,
      courseId: w.course.id,
    }).expect(201);
    expect(ticket.body.reservedMinutes).toBe(2);

    await createUpload(w, {
      fileName: 'one-more-second.mp4',
      maxDurationSeconds: 1,
      courseId: w.course.id,
    }).expect(409);
  });

  it('treats a plan with NO videoStorageMinutes entitlement as zero, never unlimited', async () => {
    const w = await world('quota-missing-key', { omitQuotaKey: true });

    const refused = await createUpload(w, {
      fileName: 'no-allowance.mp4',
      maxDurationSeconds: 60,
      courseId: w.course.id,
    }).expect(409);
    expect(refused.body.error.details).toMatchObject({ used: 0, quota: 0, requested: 1 });
    expect(providerCalls.basic).toBe(0);
  });

  it('honours `granted_limits` over the live catalog (AD-14, P61 semantics)', async () => {
    const w = await world('quota-granted', {
      videoStorageMinutes: 10,
      grantedLimits: {
        academies: 50,
        students: 500,
        instructors: 50,
        staff: 50,
        courses: 200,
        generalStorage: 100,
        videoStorage: 100,
        videoStorageMinutes: 400,
      },
    });

    // The PLAN says 10 minutes; the subscription was GRANTED 400.
    const snapshot = await enforcedUsage(w.org.id);
    expect(snapshot.quota).toBe(400);
    await createUpload(w, {
      fileName: 'granted.mp4',
      maxDurationSeconds: 300 * 60,
      courseId: w.course.id,
    }).expect(201);
  });

  it('an unlimited entitlement skips the ceiling entirely', async () => {
    const w = await world('quota-unlimited', { videoStorageMinutes: 'unlimited' });
    await seedHostedVideo(w.academy.id, 50_000 * 60);
    await createUpload(w, {
      fileName: 'unbounded.mp4',
      maxDurationSeconds: 11 * 60 * 60,
      courseId: w.course.id,
    }).expect(201);
  });

  // =========================================================================
  // 2. Counted across EVERY provider (AD-14), and not double-charged (D5).
  // =========================================================================

  it('counts BOTH hosted providers against one quota, and only hosted ones', async () => {
    const w = await world('quota-both-providers', {
      family: 'premium',
      tier: 'growth',
      videoStorageMinutes: 20,
    });
    await seedHostedVideo(w.academy.id, 6 * 60, 'r2_worker');
    await seedHostedVideo(w.academy.id, 6 * 60, 'cloudflare_stream');
    // A protected FILE — `provider: 'r2'` — is metered in gigabytes by
    // `videoStorage` and must not touch the minutes quota.
    await admin.mediaAsset.create({
      data: {
        academyId: w.academy.id,
        type: 'document',
        status: 'active',
        fileName: 'worksheet.pdf',
        storageKey: `academies/${w.academy.id}/worksheet.pdf`,
        url: '',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(1024),
        access: 'protected',
        provider: 'r2',
        processingStatus: 'ready',
      },
    });

    const snapshot = await enforcedUsage(w.org.id);
    expect(snapshot.usedMinutes).toBe(12);

    // 12 + 9 = 21 > 20 → refused, and the refusal proves the PREMIUM asset
    // was counted: without it the total would have been 6 and this would
    // have been allowed.
    const refused = await createUpload(w, {
      fileName: 'overflow.mp4',
      maxDurationSeconds: 9 * 60,
      courseId: w.course.id,
    }).expect(409);
    expect(refused.body.error.details).toMatchObject({ used: 12, quota: 20, requested: 9 });
  });

  it('Normal-tier video does NOT additionally consume the videoStorage gigabyte quota (D5)', async () => {
    const w = await world('quota-not-double-charged', { videoStorageMinutes: 500 });

    const ticket = await createUpload(w, {
      fileName: 'normal.mp4',
      maxDurationSeconds: 600,
      courseId: w.course.id,
    }).expect(201);
    expect(await putBytes(ticket.body.uploadUrl, faststartMp4(240))).toBe(200);
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`)
      .set(w.owner.auth)
      .expect(201);

    const usage = await reportedUsage(w);
    // The bytes genuinely sit in Atlas's own R2 — and are still not charged
    // against `videoStorage`, so the two tiers stay directly comparable to
    // a customer choosing between them.
    expect(usage.videoStorage.used).toBe(0);
    expect(usage.videoStorageMinutes.used).toBe(4);
  });

  // =========================================================================
  // 3. Reconciliation — usage may legitimately go DOWN (D5, AD-14).
  // =========================================================================

  it('reconciles the reservation to the MEASURED duration, and usage falls', async () => {
    const w = await world('quota-reconcile', { videoStorageMinutes: 500 });

    const ticket = await createUpload(w, {
      fileName: 'declared-ten-real-four.mp4',
      maxDurationSeconds: 600,
      courseId: w.course.id,
    }).expect(201);
    expect(ticket.body.reservedMinutes).toBe(10);

    const reserved = await enforcedUsage(w.org.id);
    expect(reserved.usedMinutes).toBe(10);
    const reservedReported = await reportedUsage(w);
    expect(reservedReported.videoStorageMinutes.used).toBe(10);

    // The real file is four minutes, not ten.
    expect(await putBytes(ticket.body.uploadUrl, faststartMp4(240))).toBe(200);
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`)
      .set(w.owner.auth)
      .expect(201);

    const settled = await enforcedUsage(w.org.id);
    expect(settled.usedMinutes).toBe(4);
    expect(settled.usedMinutes).toBeLessThan(reserved.usedMinutes);

    const settledReported = await reportedUsage(w);
    expect(settledReported.videoStorageMinutes.used).toBe(4);
    expect(settledReported.videoStorageMinutes.limit).toBe(500);

    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: ticket.body.assetId },
    });
    expect(row.durationSeconds).toBe(240);
    expect(row.durationSource).toBe('parsed');
  });

  it('releases the reservation when the provider fails, so the tenant is not charged for an upload that never started', async () => {
    const w = await world('quota-release', { videoStorageMinutes: 100 });
    await seedHostedVideo(w.academy.id, 10 * 60);

    const before = await enforcedUsage(w.org.id);
    expect(before.usedMinutes).toBe(10);

    basicFailure.next = true;
    const failed = await createUpload(w, {
      fileName: 'provider-outage.mp4',
      maxDurationSeconds: 80 * 60,
      courseId: w.course.id,
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(providerCalls.basic).toBe(1);

    // The row exists but is `failed` + archived, so it stops counting.
    const stranded = await admin.mediaAsset.findFirst({
      where: { academyId: w.academy.id, fileName: { contains: 'provider-outage' } },
    });
    expect(stranded).not.toBeNull();
    expect(stranded?.processingStatus).toBe('failed');
    expect(stranded?.status).toBe('archived');

    const after = await enforcedUsage(w.org.id);
    expect(after.usedMinutes).toBe(10);

    // And the minutes are genuinely available again.
    await createUpload(w, {
      fileName: 'retry.mp4',
      maxDurationSeconds: 80 * 60,
      courseId: w.course.id,
    }).expect(201);
  });

  // =========================================================================
  // 4. The two aggregates must agree (AD-14).
  // =========================================================================

  it('the enforcement gate and the Usage page report the same number, on a mixed-provider academy', async () => {
    const w = await world('quota-agreement', {
      family: 'premium',
      tier: 'enterprise',
      videoStorageMinutes: 5_000,
    });
    // Ready on both providers, plus an in-flight reservation, plus a failed
    // upload that must NOT count, plus a protected file that is a different
    // quota entirely.
    await seedHostedVideo(w.academy.id, 300, 'r2_worker');
    await seedHostedVideo(w.academy.id, 420, 'cloudflare_stream');
    const failed = await seedHostedVideo(w.academy.id, 9_000, 'r2_worker');
    await admin.mediaAsset.update({
      where: { id: failed.id },
      data: { processingStatus: 'failed', status: 'archived' },
    });
    await createUpload(w, {
      fileName: 'in-flight.mp4',
      maxDurationSeconds: 180,
      courseId: w.course.id,
    }).expect(201);

    // 300 + 420 + 180 = 900 seconds → 15 minutes.
    const gate = await enforcedUsage(w.org.id);
    const page = await reportedUsage(w);
    expect(gate.usedMinutes).toBe(15);
    expect(page.videoStorageMinutes.used).toBe(gate.usedMinutes);
    expect(page.videoStorageMinutes.limit).toBe(gate.quota);
  });
});
