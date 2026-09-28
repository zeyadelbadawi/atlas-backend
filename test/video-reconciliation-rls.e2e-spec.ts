/**
 * Video reconciliation under real RLS (cloud remediation, finding A).
 *
 * THE DEFECT. `VideoReconciliationService` read `media_assets` through the
 * bare Prisma client with no RLS context. The app connects as `atlas_app`
 * (NOBYPASSRLS) and every `media_assets` SELECT policy needs an
 * organization, a user or a platform owner — so the read returned zero
 * rows, every provider webhook was logged "unknown asset; ignored", and the
 * stalled-asset poll never found anything. Assets stayed `processing` and
 * kept their quota reservation forever. Unit specs with a mocked client
 * could never see this; only real Postgres can.
 *
 * WHAT THIS PINS, against real Postgres and the real `atlas_app` role:
 *   - an event reaches exactly the asset it names, in its own tenant;
 *   - an asset of ANOTHER tenant is untouched by that event;
 *   - the lesson duration backfill lands in the right tenant only;
 *   - the stalled poll finds assets across tenants and reconciles them;
 *   - an unknown provider id changes nothing.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { VideoReconciliationService } from '../src/media/services/video-reconciliation.service';
import { VideoProviderRegistry } from '../src/media/video/video-provider.registry';
import type { PrismaClient } from '@prisma/client';

async function seedUser(admin: PrismaClient, label: string, isPlatformOwner = false) {
  return admin.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      name: label,
      isPlatformOwner,
    },
  });
}

async function seedHostedAsset(
  admin: PrismaClient,
  academyId: string,
  providerId: string,
) {
  const asset = await admin.mediaAsset.create({
    data: {
      academyId,
      type: 'video',
      status: 'active',
      fileName: `${providerId}.mp4`,
      storageKey: '',
      url: '',
      mimeType: 'video/mp4',
      sizeBytes: BigInt(1024),
      access: 'protected',
      provider: 'cloudflare_stream',
      providerId,
      processingStatus: 'processing',
      durationSeconds: 600,
      securityTier: 'premium',
    },
  });
  // Old enough for the stalled poll's cutoff.
  await admin.$executeRaw`UPDATE media_assets SET updated_at = now() - interval '2 hours' WHERE id = ${asset.id}`;
  return asset;
}

describe('Video reconciliation — explicit RLS context (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let reconciliation: VideoReconciliationService;

  let assetA: { id: string };
  let assetB: { id: string };
  let lessonA: { id: string };
  let lessonB: { id: string };
  const providerIdA = `cfuid-a-${randomUUID()}`;
  const providerIdB = `cfuid-b-${randomUUID()}`;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    admin = createAdminPrisma();
    reconciliation = app.get(VideoReconciliationService);

    // A platform owner must exist: it is the identity cross-tenant reads
    // run as. Created before anything else so it is the oldest.
    await seedUser(admin, 'recon-platform-owner', true);

    for (const side of ['a', 'b'] as const) {
      const owner = await seedUser(admin, `recon-owner-${side}`);
      const org = await seedOrganizationWithOwner(admin, owner.id, `recon-org-${side}`);
      const academy = await seedAcademy(admin, org.id, `recon-academy-${side}`);
      const course = await seedCourse(admin, academy.id, `recon-course-${side}`);
      const section = await seedCourseSection(
        admin,
        course.id,
        `recon-section-${side}`,
        1,
      );
      const asset = await seedHostedAsset(
        admin,
        academy.id,
        side === 'a' ? providerIdA : providerIdB,
      );
      const lesson = await seedCourseLesson(
        admin,
        section.id,
        course.id,
        `recon-lesson-${side}`,
        1,
      );
      await admin.courseLesson.update({
        where: { id: lesson.id },
        data: { videoAssetId: asset.id, durationSeconds: null },
      });
      if (side === 'a') {
        assetA = asset;
        lessonA = lesson;
      } else {
        assetB = asset;
        lessonB = lesson;
      }
    }
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('applies an event to exactly the asset it names, and to no other tenant', async () => {
    await reconciliation.applyEvent({
      providerId: providerIdA,
      status: 'ready',
      durationSeconds: 42,
    });

    const a = await admin.mediaAsset.findUniqueOrThrow({ where: { id: assetA.id } });
    const b = await admin.mediaAsset.findUniqueOrThrow({ where: { id: assetB.id } });
    expect(a.processingStatus).toBe('ready');
    expect(a.durationSeconds).toBe(42);
    expect(b.processingStatus).toBe('processing');
    expect(b.durationSeconds).toBe(600);

    const la = await admin.courseLesson.findUniqueOrThrow({ where: { id: lessonA.id } });
    const lb = await admin.courseLesson.findUniqueOrThrow({ where: { id: lessonB.id } });
    expect(la.durationSeconds).toBe(42);
    expect(lb.durationSeconds).toBeNull();
  });

  it('changes nothing for a provider id Atlas does not know', async () => {
    await expect(
      reconciliation.applyEvent({
        providerId: `unknown-${randomUUID()}`,
        status: 'ready',
        durationSeconds: null,
      }),
    ).resolves.toBeUndefined();
    const b = await admin.mediaAsset.findUniqueOrThrow({ where: { id: assetB.id } });
    expect(b.processingStatus).toBe('processing');
  });

  it('finds stalled assets across tenants and reconciles each in its own tenant', async () => {
    const registry = app.get(VideoProviderRegistry);
    const spy = jest.spyOn(registry, 'forProvider').mockReturnValue({
      fetchAsset: (providerId: string) =>
        Promise.resolve({ providerId, status: 'ready', durationSeconds: 77 }),
    } as unknown as ReturnType<VideoProviderRegistry['forProvider']>);
    try {
      const reconciled = await reconciliation.pollStalled(30, 1000);
      expect(reconciled).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
    const b = await admin.mediaAsset.findUniqueOrThrow({ where: { id: assetB.id } });
    expect(b.processingStatus).toBe('ready');
    expect(b.durationSeconds).toBe(77);
  });
});
