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
    createDirectUpload: () =>
      Promise.resolve({
        providerId: 'provider-asset-1',
        uploadUrl: 'https://upload.test/x',
        expiresAt: new Date(Date.now() + 600_000),
      }),
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
    } as never,
    // P64 Phase 3 — AcademyStudentsRepository (student attachment uploads; unused here)
    { findForUserInAcademy: () => Promise.resolve(null) } as never,
    {
      assertVideoMinutesWithinQuota: (_t: unknown, _o: string, minutes: number) => {
        quotaCalls.push(minutes);
        return Promise.resolve();
      },
      assertStorageWithinLimit: () => Promise.resolve(),
    } as never,
    { enqueueOne: () => Promise.resolve() } as never,
    { maxTtlSeconds: 600 } as never,
    {
      forTier: () => provider,
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
      getOrThrow: () => ({ bucket: 'b', signedUrlTtlSeconds: 600, maxUploadBytes: 1 }),
    } as unknown as ConfigService,
  );

  return { service, rows, quotaCalls, provider };
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

  it('refuses when the tier has no configured provider', async () => {
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
