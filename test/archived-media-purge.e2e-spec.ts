/**
 * Archived-media purge — the 30-day grace policy (owner decision, 26 Sep
 * 2026), against real Postgres (`atlas_app`, RLS on), the S3-compatible
 * test store for R2, and `FakeVideoProvider` in the hosted-video slot.
 *
 *   - immediate deletion is refused (archived today → not eligible);
 *   - resources inside the grace period remain;
 *   - eligible resources are destroyed — public R2, protected R2 and hosted
 *     video — absence is proven, the row is tombstoned and audited;
 *   - an individually archived asset still referenced by a lesson is kept;
 *   - active assets of active academies are never candidates;
 *   - repeated cleanup is safe;
 *   - a payload naming the wrong tenant touches nothing;
 *   - a legal hold wins over the grace period;
 *   - `dry_run` (the default) destroys nothing.
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
import { ArchivedMediaPurgeService } from '../src/retention/services/archived-media-purge.service';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../src/media/storage/media-storage.interface';
import { ProtectedMediaStorage } from '../src/media/storage/protected-media-storage.provider';
import { FakeVideoProvider } from '../src/media/video/fake-video.provider';
import type { PrismaClient } from '@prisma/client';

const DAY = 24 * 60 * 60 * 1000;

describe('Archived-media purge — 30-day grace (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let purge: ArchivedMediaPurgeService;
  let publicStorage: MediaStorageProvider;
  let protectedStorage: ProtectedMediaStorage;
  let fakeVideo: FakeVideoProvider;
  let modeSpy: jest.SpyInstance;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    admin = createAdminPrisma();
    purge = app.get(ArchivedMediaPurgeService);
    publicStorage = app.get(MEDIA_STORAGE_PROVIDER);
    protectedStorage = app.get(ProtectedMediaStorage);
    fakeVideo = app.get(FakeVideoProvider, { strict: false });
    // A platform owner is the identity cross-tenant reads run as.
    await admin.user.create({
      data: {
        email: `purge-po-${randomUUID()}@example.test`,
        name: 'purge-po',
        passwordHash: 'x',
        isPlatformOwner: true,
      },
    });
  });

  /** Candidate listing WITHOUT enqueueing — `sweep()` in `on` would hand them to the live worker. */
  async function candidates(): Promise<string[]> {
    const po = await admin.user.findFirstOrThrow({
      where: { isPlatformOwner: true },
      orderBy: { createdAt: 'asc' },
    });
    return (await purge.findCandidates(po.id, new Date())).map((c) => c.assetId);
  }

  beforeEach(() => {
    modeSpy = jest.spyOn(purge, 'mode', 'get').mockReturnValue('on');
  });

  afterEach(() => modeSpy.mockRestore());

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function tenant(label: string, archivedDaysAgo: number | null) {
    const owner = await admin.user.create({
      data: {
        email: `${label}-${randomUUID()}@example.test`,
        name: label,
        passwordHash: 'x',
      },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    if (archivedDaysAgo !== null) {
      await admin.academy.update({
        where: { id: academy.id },
        data: {
          status: 'archived',
          archivedAt: new Date(Date.now() - archivedDaysAgo * DAY),
        },
      });
    }
    return { organizationId: org.id, academyId: academy.id };
  }

  async function publicAsset(
    academyId: string,
    status: 'active' | 'archived' = 'active',
  ) {
    const key = `academies/${academyId}/purge-${randomUUID()}.png`;
    await publicStorage.putObject(key, Buffer.from('png'), 'image/png');
    return admin.mediaAsset.create({
      data: {
        academyId,
        type: 'image',
        status,
        fileName: 'logo.png',
        storageKey: key,
        url: '',
        mimeType: 'image/png',
        sizeBytes: BigInt(3),
        access: 'public',
        provider: 'r2',
      },
    });
  }

  async function protectedAsset(academyId: string) {
    const key = `academies/${academyId}/purge-${randomUUID()}.pdf`;
    await protectedStorage.putObject(key, Buffer.from('%PDF'), 'application/pdf');
    return admin.mediaAsset.create({
      data: {
        academyId,
        type: 'document',
        status: 'active',
        fileName: 'notes.pdf',
        storageKey: key,
        url: '',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(4),
        access: 'protected',
        provider: 'r2',
      },
    });
  }

  async function hostedVideo(academyId: string) {
    const upload = await fakeVideo.createDirectUpload({
      maxDurationSeconds: 60,
      allowedOrigins: [],
      metadata: { academyId },
    });
    return admin.mediaAsset.create({
      data: {
        academyId,
        type: 'video',
        status: 'active',
        fileName: `${upload.providerId}.mp4`,
        storageKey: `fake-video/${upload.providerId}.mp4`,
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(10),
        access: 'protected',
        provider: 'r2_worker',
        providerId: upload.providerId,
        processingStatus: 'ready',
        securityTier: 'normal',
      },
    });
  }

  const ageAsset = (id: string, days: number) =>
    admin.$executeRaw`UPDATE media_assets SET updated_at = now() - make_interval(days => ${days}::int) WHERE id = ${id}`;

  it('refuses immediate deletion and keeps everything inside the grace period', async () => {
    const today = await tenant('purge-today', 0);
    const tenDays = await tenant('purge-ten-days', 10);
    const a = await publicAsset(today.academyId);
    const b = await publicAsset(tenDays.academyId);

    expect(
      await purge.purgeAsset({ assetId: a.id, organizationId: today.organizationId }),
    ).toBe('not_eligible');
    expect(
      await purge.purgeAsset({ assetId: b.id, organizationId: tenDays.organizationId }),
    ).toBe('not_eligible');
    expect(await publicStorage.objectExists(a.storageKey)).toBe(true);
    expect(await publicStorage.objectExists(b.storageKey)).toBe(true);

    const listed = await candidates();
    expect(listed).not.toContain(a.id);
    expect(listed).not.toContain(b.id);
  });

  it('destroys public R2, protected R2 and hosted video of an academy archived > 30 days, with proof and audit', async () => {
    const t = await tenant('purge-eligible', 31);
    const pub = await publicAsset(t.academyId);
    const prot = await protectedAsset(t.academyId);
    const video = await hostedVideo(t.academyId);
    expect(await fakeVideo.fetchAsset(video.providerId!)).not.toBeNull();

    expect(await candidates()).toEqual(
      expect.arrayContaining([pub.id, prot.id, video.id]),
    );

    for (const asset of [pub, prot, video]) {
      expect(
        await purge.purgeAsset({ assetId: asset.id, organizationId: t.organizationId }),
      ).toBe('purged');
      const row = await admin.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
      expect(row.status).toBe('deleted');
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.deletionReason).toBe('archive_grace_elapsed');
    }
    expect(await publicStorage.objectExists(pub.storageKey)).toBe(false);
    expect(await protectedStorage.headObject(prot.storageKey)).toBeNull();
    expect(await fakeVideo.fetchAsset(video.providerId!)).toBeNull();
    expect(
      await admin.auditLogEntry.count({
        where: {
          action: 'media.asset.purged',
          targetId: { in: [pub.id, prot.id, video.id] },
        },
      }),
    ).toBe(3);

    // Repeated cleanup is safe and changes nothing.
    expect(
      await purge.purgeAsset({ assetId: pub.id, organizationId: t.organizationId }),
    ).toBe('already_deleted');
    expect(await candidates()).not.toContain(pub.id);
  });

  it('in an active academy: keeps active assets and referenced archived assets, purges unreferenced old archived ones', async () => {
    const t = await tenant('purge-active-academy', null);
    const active = await publicAsset(t.academyId, 'active');
    await ageAsset(active.id, 90);
    const referenced = await hostedVideo(t.academyId);
    await admin.mediaAsset.update({
      where: { id: referenced.id },
      data: { status: 'archived' },
    });
    await ageAsset(referenced.id, 45);
    const course = await seedCourse(admin, t.academyId, 'purge-course');
    const section = await seedCourseSection(admin, course.id, 'purge-section', 1);
    const lesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      'purge-lesson',
      1,
    );
    await admin.courseLesson.update({
      where: { id: lesson.id },
      data: { videoAssetId: referenced.id },
    });
    const orphan = await publicAsset(t.academyId, 'archived');
    await ageAsset(orphan.id, 45);

    expect(await candidates()).not.toContain(active.id);

    expect(
      await purge.purgeAsset({
        assetId: referenced.id,
        organizationId: t.organizationId,
      }),
    ).toBe('not_eligible');
    expect(await fakeVideo.fetchAsset(referenced.providerId!)).not.toBeNull();
    expect(
      await purge.purgeAsset({ assetId: orphan.id, organizationId: t.organizationId }),
    ).toBe('purged');
    expect(await publicStorage.objectExists(orphan.storageKey)).toBe(false);
    expect(
      (await admin.mediaAsset.findUniqueOrThrow({ where: { id: active.id } })).status,
    ).toBe('active');
  });

  it('never acts on a payload naming another tenant', async () => {
    const victim = await tenant('purge-victim', 40);
    const other = await tenant('purge-other', 40);
    const asset = await publicAsset(victim.academyId);
    expect(
      await purge.purgeAsset({ assetId: asset.id, organizationId: other.organizationId }),
    ).toBe('not_found');
    expect(await publicStorage.objectExists(asset.storageKey)).toBe(true);
  });

  it('a legal hold wins over the grace period', async () => {
    const t = await tenant('purge-held', 60);
    await admin.tenantLifecycleState.create({
      data: {
        organizationId: t.organizationId,
        legalHold: true,
        holdReason: 'litigation',
      },
    });
    const asset = await publicAsset(t.academyId);
    expect(
      await purge.purgeAsset({ assetId: asset.id, organizationId: t.organizationId }),
    ).toBe('held');
    expect(await publicStorage.objectExists(asset.storageKey)).toBe(true);
  });

  it('dry_run reports candidates and destroys nothing', async () => {
    modeSpy.mockReturnValue('dry_run');
    const t = await tenant('purge-dry', 45);
    const asset = await publicAsset(t.academyId);
    expect((await purge.sweep()).map((c) => c.assetId)).toContain(asset.id);
    expect(
      await purge.purgeAsset({ assetId: asset.id, organizationId: t.organizationId }),
    ).toBe('mode_not_on');
    expect(await publicStorage.objectExists(asset.storageKey)).toBe(true);
    expect(
      (await admin.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).status,
    ).toBe('active');
  });

  it('in `on`, the sweep hands eligible assets to the queue worker, which purges them', async () => {
    const t = await tenant('purge-queue', 35);
    const asset = await publicAsset(t.academyId);
    await purge.sweep();
    const deadline = Date.now() + 30_000;
    let status = 'active';
    while (Date.now() < deadline) {
      status = (await admin.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }))
        .status;
      if (status === 'deleted') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(status).toBe('deleted');
    expect(await publicStorage.objectExists(asset.storageKey)).toBe(false);
  });
});
