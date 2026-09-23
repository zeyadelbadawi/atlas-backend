/**
 * P64 Phase 4 §E.5 — `GET /platform-metrics/video` (platform video minutes
 * and provider health). Proves exact aggregation over seeded video assets
 * across tiers/providers/processing states, that non-video and archived
 * assets are ignored, and the three-guard access rule (401 anonymous, 403
 * non-owner, 200 platform owner) — the same rule as the seven-KPI overview.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

describe('Platform video metrics (e2e)', () => {
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

  async function account(label: string) {
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
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  async function seedVideo(
    academyId: string,
    overrides: {
      tier?: 'normal' | 'premium' | null;
      provider?: 'r2' | 'r2_worker' | 'cloudflare_stream';
      processing?: 'pending' | 'processing' | 'ready' | 'failed';
      seconds?: number | null;
      bytes?: number;
      type?: 'video' | 'image';
      status?: 'active' | 'archived';
    } = {},
  ) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return admin.mediaAsset.create({
      data: {
        academyId,
        type: overrides.type ?? 'video',
        status: overrides.status ?? 'active',
        fileName: `v-${id}.mp4`,
        storageKey: `academies/${academyId}/${id}.mp4`,
        url: `/api/v1/public/media/academies/${academyId}/${id}.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(overrides.bytes ?? 0),
        provider: overrides.provider ?? 'r2_worker',
        processingStatus: overrides.processing ?? 'ready',
        durationSeconds: overrides.seconds === undefined ? 60 : overrides.seconds,
        securityTier: overrides.tier === undefined ? 'normal' : overrides.tier,
      },
    });
  }

  it('a platform owner reads exact per-tier minutes, per-provider counts and processing health', async () => {
    const platformOwner = await account('pvm-owner');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });

    // Baseline BEFORE seeding, so pre-existing rows in the shared dev DB
    // never make the assertions flaky — we assert on deltas.
    const before = await request(app.getHttpServer())
      .get('/platform-metrics/video')
      .set(platformOwner.auth)
      .expect(200);

    const tenantOwner = await account('pvm-tenant');
    const org = await seedOrganizationWithOwner(admin, tenantOwner.userId, 'pvm-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'pvm');
    const academy = await seedAcademy(admin, org.id, 'pvm-academy');
    await seedAcademyMember(admin, academy.id, tenantOwner.userId, 'owner');

    const GB = 1024 ** 3;
    await seedVideo(academy.id, {
      tier: 'normal',
      provider: 'r2_worker',
      seconds: 600,
      bytes: GB,
    });
    await seedVideo(academy.id, {
      tier: 'normal',
      provider: 'r2_worker',
      seconds: 300,
      bytes: GB,
    });
    await seedVideo(academy.id, {
      tier: 'premium',
      provider: 'cloudflare_stream',
      seconds: 1200,
      bytes: 2 * GB,
    });
    await seedVideo(academy.id, {
      tier: 'premium',
      provider: 'cloudflare_stream',
      processing: 'failed',
      seconds: null,
    });
    await seedVideo(academy.id, {
      tier: null,
      provider: 'r2',
      processing: 'processing',
      seconds: null,
    });
    // Must be ignored: an image, and an archived video.
    await seedVideo(academy.id, { type: 'image', seconds: 9999 });
    await seedVideo(academy.id, { status: 'archived', seconds: 9999 });

    const after = await request(app.getHttpServer())
      .get('/platform-metrics/video')
      .set(platformOwner.auth)
      .expect(200);

    const tier = (body: typeof after.body, t: string) =>
      body.byTier.find((row: { tier: string }) => row.tier === t) ?? {
        assets: 0,
        storedMinutes: 0,
        storedGb: 0,
      };

    expect(after.body.totalVideoAssets - before.body.totalVideoAssets).toBe(5);
    // 600+300+1200 seconds = 35 minutes; 4 GB total.
    expect(
      Math.round((after.body.totalStoredMinutes - before.body.totalStoredMinutes) * 10) /
        10,
    ).toBe(35);
    expect(
      Math.round((after.body.totalStoredGb - before.body.totalStoredGb) * 100) / 100,
    ).toBe(4);

    expect(tier(after.body, 'normal').assets - tier(before.body, 'normal').assets).toBe(
      2,
    );
    expect(
      Math.round(
        (tier(after.body, 'normal').storedMinutes -
          tier(before.body, 'normal').storedMinutes) *
          10,
      ) / 10,
    ).toBe(15);
    expect(tier(after.body, 'premium').assets - tier(before.body, 'premium').assets).toBe(
      2,
    );
    expect(tier(after.body, 'none').assets - tier(before.body, 'none').assets).toBe(1);

    const prov = (body: typeof after.body, p: string) => body.byProvider[p] ?? 0;
    expect(prov(after.body, 'r2_worker') - prov(before.body, 'r2_worker')).toBe(2);
    expect(
      prov(after.body, 'cloudflare_stream') - prov(before.body, 'cloudflare_stream'),
    ).toBe(2);
    expect(prov(after.body, 'r2') - prov(before.body, 'r2')).toBe(1);

    expect(after.body.processing.failed - before.body.processing.failed).toBe(1);
    expect(after.body.processing.processing - before.body.processing.processing).toBe(1);
    expect(after.body.processing.ready - before.body.processing.ready).toBe(3);

    // Counts and minutes only — never tenant names or asset ids.
    expect(JSON.stringify(after.body)).not.toContain(academy.id);
    expect(JSON.stringify(after.body)).not.toContain('pvm-academy');
  });

  it('refuses a non-platform-owner (403) and an anonymous caller (401)', async () => {
    const someone = await account('pvm-nobody');
    await request(app.getHttpServer())
      .get('/platform-metrics/video')
      .set(someone.auth)
      .expect(403);
    await request(app.getHttpServer()).get('/platform-metrics/video').expect(401);
  });
});
