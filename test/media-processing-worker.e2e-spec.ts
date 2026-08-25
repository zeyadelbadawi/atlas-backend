/**
 * `media-processing` worker — real BullMQ/Redis transport e2e (master
 * plan §12/§21 Phase P8). `media.e2e-spec.ts` already proves the
 * happy-path dimension extraction through the real upload endpoint; this
 * file proves the QUEUE half directly: redelivery safety, and that a
 * genuine processing failure never touches the original asset row —
 * mirrors `tenant-usage-recompute-worker.e2e-spec.ts`'s exact pattern.
 */
import { INestApplication } from '@nestjs/common';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { createTestApp, waitForAsync } from './utils/test-app';
import { MediaProcessingProducer } from '../src/media/queue/media-processing.producer';
import { MEDIA_STORAGE_PROVIDER } from '../src/media/storage/media-storage.interface';
import type { MediaStorageProvider } from '../src/media/storage/media-storage.interface';
import type { PrismaClient } from '@prisma/client';

const REAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// Real BullMQ round trips (enqueue → worker pickup → object-storage I/O →
// DB update), not slow assertions — headroom over Jest's 5000ms default,
// same reasoning as `media.e2e-spec.ts`'s own per-test override.
jest.setTimeout(20000);

describe('media-processing worker (e2e) — real BullMQ/Redis', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let producer: MediaProcessingProducer;
  let storageProvider: MediaStorageProvider;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    producer = app.get(MediaProcessingProducer, { strict: false });
    storageProvider = app.get(MEDIA_STORAGE_PROVIDER, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function seedManagedAcademy(label: string) {
    const owner = await admin.user.create({
      data: {
        email: `${label}-${Date.now()}@test.local`,
        passwordHash: 'x',
        name: label,
      },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.id, 'owner');
    return { owner, org, academy };
  }

  it('redelivering the same job (enqueued twice) is idempotent — same dimensions, no error', async () => {
    const { academy, org } = await seedManagedAcademy('media-worker-redeliver');
    const key = `academies/${academy.id}/${Date.now()}-redeliver.png`;
    const { url } = await storageProvider.putObject(
      key,
      Buffer.from(REAL_PNG_BASE64, 'base64'),
      'image/png',
    );
    const asset = await admin.mediaAsset.create({
      data: {
        academyId: academy.id,
        type: 'image',
        fileName: 'redeliver.png',
        storageKey: key,
        url,
        mimeType: 'image/png',
        sizeBytes: BigInt(Buffer.from(REAL_PNG_BASE64, 'base64').length),
      },
    });

    await producer.enqueue(asset.id, academy.id, org.id);
    const first = await waitForAsync(
      () =>
        admin.mediaAsset
          .findUnique({ where: { id: asset.id } })
          .then((row) => (row?.width !== null ? (row ?? undefined) : undefined)),
      { timeoutMs: 10000 },
    );
    expect(first.width).toBe(1);
    expect(first.height).toBe(1);

    // Redelivery — re-runs cleanly, overwrites the same derived fields,
    // never errors, never touches anything else on the row.
    await producer.enqueue(asset.id, academy.id, org.id);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const second = await admin.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(second.width).toBe(1);
    expect(second.height).toBe(1);
    expect(second.storageKey).toBe(asset.storageKey);
    expect(second.status).toBe('active');
  });

  it('a document asset is skipped (no dimensions to extract) — never treated as a failure', async () => {
    const { academy, org } = await seedManagedAcademy('media-worker-document');
    const key = `academies/${academy.id}/${Date.now()}-doc.pdf`;
    await storageProvider.putObject(
      key,
      Buffer.from('%PDF-1.4\n%%EOF'),
      'application/pdf',
    );
    const asset = await admin.mediaAsset.create({
      data: {
        academyId: academy.id,
        type: 'document',
        fileName: 'doc.pdf',
        storageKey: key,
        url: `http://localhost:9000/test/${key}`,
        mimeType: 'application/pdf',
        sizeBytes: 100n,
      },
    });

    await producer.enqueue(asset.id, academy.id, org.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const row = await admin.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
    expect(row.status).toBe('active');
  });

  it('a processing failure (object missing from storage) never destroys or corrupts the original asset row', async () => {
    const { academy, org } = await seedManagedAcademy('media-worker-failure');
    // A real DB row whose storage key was never actually uploaded —
    // simulates a genuine processing failure (object unreachable).
    const asset = await admin.mediaAsset.create({
      data: {
        academyId: academy.id,
        type: 'image',
        fileName: 'missing.png',
        storageKey: `academies/${academy.id}/never-uploaded.png`,
        url: `http://localhost:9000/test/never-uploaded.png`,
        mimeType: 'image/png',
        sizeBytes: 1024n,
      },
    });

    await producer.enqueue(asset.id, academy.id, org.id);
    // Give the worker real time to attempt (and exhaust its retries on)
    // the job — the row itself must remain completely intact throughout.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const row = await admin.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.status).toBe('active');
    expect(row.storageKey).toBe(asset.storageKey);
    expect(row.url).toBe(asset.url);
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
  });
});
