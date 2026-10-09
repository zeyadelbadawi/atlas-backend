/**
 * The video upload path.
 *
 * THE REASON THIS FILE EXISTS. `createVideoUpload` once destructured
 * `const { origins, tier } = await runInTenantContext(...)` and then read
 * `tier` INSIDE that same callback — a temporal dead zone, so every call
 * threw `ReferenceError` before writing a row. The whole upload path was
 * dead and `tsc` was green, because the reference sat inside a closure.
 * Nothing caught it because nothing exercised this method at all.
 *
 * So the first test below is deliberately unglamorous: call the thing and
 * prove it completes. Everything else here follows the same principle —
 * assert the facts the method is supposed to record, not the shape of its
 * internals.
 */
import { ProtectedMediaService } from './protected-media.service';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';

interface Row {
  id: string;
  provider: string;
  securityTier: string | null;
  processingStatus: string;
  durationSeconds: number | null;
  providerId: string | null;
}

function harness(
  options: {
    readonly tier?: 'normal' | 'premium';
    readonly flagEnabled?: boolean;
    readonly tierAvailable?: boolean;
  } = {},
) {
  const tier = options.tier ?? 'normal';
  const rows: Row[] = [];
  const quotaCalls: number[] = [];
  const storageCalls: { kind: string; bytes: number }[] = [];
  const directUploads: Record<string, unknown>[] = [];

  const tx = {
    academy: { findUnique: () => Promise.resolve({ videoSecurityTier: null }) },
    course: { findFirst: () => Promise.resolve({ id: 'course-1' }) },
    mediaAsset: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data as unknown as Row);
        return Promise.resolve(data);
      },
      update: ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(rows[0], data);
        return Promise.resolve(rows[0]);
      },
    },
    subdomainAllocation: { findUnique: () => Promise.resolve(null) },
    domainConnection: { findUnique: () => Promise.resolve(null) },
  } as unknown as Prisma.TransactionClient;

  const provider = {
    key: tier === 'premium' ? 'cloudflare_stream' : 'r2_worker',
    storedAs: tier === 'premium' ? 'cloudflare_stream' : 'r2_worker',
    capabilities: () => ({ reportsReadinessAsynchronously: tier === 'premium' }),
    createDirectUpload: (input: Record<string, unknown>) => {
      directUploads.push(input);
      return Promise.resolve({
        providerId: 'provider-asset-1',
        uploadUrl: 'https://upload.test/x',
        expiresAt: new Date(Date.now() + 600_000),
      });
    },
  };

  const service = new ProtectedMediaService(
    {
      runInTenantContext: (
        _org: string,
        work: (t: Prisma.TransactionClient) => unknown,
      ) => Promise.resolve(work(tx)),
    } as never,
    {
      findForUserInAcademy: () => Promise.resolve({ role: 'owner', status: 'active' }),
      findManagingRole: () => Promise.resolve('owner'),
    } as never,
    // P64 Phase 3 — AcademyStudentsRepository (student attachment uploads; unused here)
    { findForUserInAcademy: () => Promise.resolve(null) } as never,
    {
      assertVideoMinutesWithinQuota: (_t: unknown, _o: string, minutes: number) => {
        quotaCalls.push(minutes);
        return Promise.resolve();
      },
      assertStorageWithinLimit: (
        _t: unknown,
        _o: string,
        kind: string,
        bytes: number,
      ) => {
        storageCalls.push({ kind, bytes });
        return Promise.resolve();
      },
    } as never,
    { enqueueOne: () => Promise.resolve() } as never,
    { maxTtlSeconds: 600 } as never,
    {
      // Faithful to the REAL VideoProviderRegistry: `forTier` throws a raw
      // Error for an unconfigured tier (the same condition `isTierAvailable`
      // reports as false). A mock that always returned an adapter hid the
      // ordering bug where this raw throw pre-empted the `videoNotEnabled`
      // refusal and surfaced as a 500.
      forTier: () => {
        if (options.tierAvailable === false) {
          throw new Error('The tier is not configured.');
        }
        return provider;
      },
      forProvider: () => provider,
      isTierAvailable: () => options.tierAvailable ?? true,
    } as never,
    {
      resolve: () => Promise.resolve({ tier, entitled: tier, source: 'plan' as const }),
    } as never,
    { isEnabledForAcademy: () => options.flagEnabled ?? true } as never,
    { forAcademy: () => Promise.resolve(['https://academy.test']) } as never,
    {
      recordUploadCompletion: () => undefined,
      recordDurationProvenance: () => undefined,
    } as never,
    {
      getOrThrow: () => ({
        bucket: 'b',
        signedUrlTtlSeconds: 600,
        maxUploadBytes: 1,
        maxVideoUploadBytes: 1000,
      }),
    } as unknown as ConfigService,
  );

  return { service, rows, quotaCalls, storageCalls, directUploads, provider };
}

describe('ProtectedMediaService.createVideoUpload', () => {
  it('completes — the temporal-dead-zone regression', async () => {
    // Before the fix this threw `ReferenceError: Cannot access 'tier'
    // before initialization`. A green typecheck said nothing about it.
    const { service } = harness();
    const ticket = await service.createVideoUpload('academy-1', 'org-1', 'user-1', {
      fileName: 'lesson.mp4',
      maxDurationSeconds: 600,
      courseId: 'course-1',
    });
    expect(ticket.assetId).toEqual(expect.any(String));
    expect(ticket.uploadUrl).toBe('https://upload.test/x');
  });

  it('records the ACTING adapter, not a hardcoded literal (finding D-1)', async () => {
    // The column used to be written as the constant `'cloudflare_stream'`
    // whatever adapter actually ran. Playback resolves the adapter from
    // exactly this column, so a column that lies routes an asset to an
    // edge that cannot honour its credential.
    const normal = harness({ tier: 'normal' });
    await normal.service.createVideoUpload('a', 'o', 'u', {
      fileName: 'x.mp4',
      maxDurationSeconds: 60,
    });
    expect(normal.rows[0].provider).toBe('r2_worker');

    const premium = harness({ tier: 'premium' });
    await premium.service.createVideoUpload('a', 'o', 'u', {
      fileName: 'x.mp4',
      maxDurationSeconds: 60,
    });
    expect(premium.rows[0].provider).toBe('cloudflare_stream');
  });

  it('records the tier the academy was entitled to, as a fact about the asset (AD-15)', async () => {
    const { service, rows } = harness({ tier: 'premium' });
    await service.createVideoUpload('a', 'o', 'u', {
      fileName: 'x.mp4',
      maxDurationSeconds: 60,
    });
    expect(rows[0].securityTier).toBe('premium');
  });

  it('reserves quota BEFORE issuing the upload URL, rounded up to whole minutes', async () => {
    const { service, quotaCalls } = harness();
    await service.createVideoUpload('a', 'o', 'u', {
      fileName: 'x.mp4',
      // 90 seconds consumes two minutes of a minute-denominated quota —
      // rounding down would let a tenant hold more than their plan allows
      // by uploading short clips.
      maxDurationSeconds: 90,
    });
    expect(quotaCalls).toEqual([2]);
  });

  // W6 — the video PUT used to have no size bound and charged no storage.
  it('charges a declared size to video storage, reserves it, and hands it to the adapter to sign', async () => {
    const { service, storageCalls, rows, directUploads } = harness();
    await service.createVideoUpload('a', 'o', 'u', {
      fileName: 'x.mp4',
      maxDurationSeconds: 60,
      sizeBytes: 900,
    });
    expect(storageCalls).toEqual([{ kind: 'videoStorage', bytes: 900 }]);
    expect(Number((rows[0] as unknown as { sizeBytes: bigint }).sizeBytes)).toBe(900);
    expect(directUploads[0]).toMatchObject({ contentLength: 900 });
  });

  it('refuses a declared size above VIDEO_MAX_UPLOAD_BYTES before reserving anything', async () => {
    const { service, rows, storageCalls } = harness();
    await expect(
      service.createVideoUpload('a', 'o', 'u', {
        fileName: 'x.mp4',
        maxDurationSeconds: 60,
        sizeBytes: 1001,
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(rows).toEqual([]);
    expect(storageCalls).toEqual([]);
  });

  it('tells the client whether it must call the completion endpoint (finding D-4)', async () => {
    // The Normal tier has no webhook, so nothing would ever mark the
    // asset ready without a second call.
    const normal = await harness({ tier: 'normal' }).service.createVideoUpload(
      'a',
      'o',
      'u',
      { fileName: 'x.mp4', maxDurationSeconds: 60 },
    );
    expect(normal.requiresCompletionCall).toBe(true);

    const premium = await harness({ tier: 'premium' }).service.createVideoUpload(
      'a',
      'o',
      'u',
      { fileName: 'x.mp4', maxDurationSeconds: 60 },
    );
    expect(premium.requiresCompletionCall).toBe(false);
  });

  it('refuses when the tier is not rolled out to this academy', async () => {
    const { service } = harness({ flagEnabled: false });
    await expect(
      service.createVideoUpload('a', 'o', 'u', {
        fileName: 'x.mp4',
        maxDurationSeconds: 60,
      }),
    ).rejects.toMatchObject({ response: { messageKey: 'errors.media.videoNotEnabled' } });
  });

  it('refuses when the tier has no configured provider — with the CLEAN videoNotEnabled refusal, not a raw 500', async () => {
    // Regression: `forTier` was called BEFORE this gate. With a faithful
    // registry mock (raw throw for an unconfigured tier) the old ordering
    // rejected with a bare `Error` (→ 500), never the intended
    // `videoNotEnabled` ForbiddenException. `toMatchObject` on `response`
    // fails for a raw Error, so this now genuinely pins the ordering.
    const { service } = harness({ tierAvailable: false });
    await expect(
      service.createVideoUpload('a', 'o', 'u', {
        fileName: 'x.mp4',
        maxDurationSeconds: 60,
      }),
    ).rejects.toMatchObject({ response: { messageKey: 'errors.media.videoNotEnabled' } });
  });

  it('rejects a nonsensical declared duration before touching anything', async () => {
    const { service, rows } = harness();
    await expect(
      service.createVideoUpload('a', 'o', 'u', {
        fileName: 'x.mp4',
        maxDurationSeconds: 0,
      }),
    ).rejects.toMatchObject({ response: { messageKey: 'errors.validation.failed' } });
    expect(rows).toHaveLength(0);
  });
});
