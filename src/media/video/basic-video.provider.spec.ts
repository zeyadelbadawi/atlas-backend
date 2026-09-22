/**
 * The Normal tier's adapter.
 *
 * The most important tests here are the ones that assert what it CANNOT
 * do. This adapter originally claimed `boundToSession: true` and
 * `boundToDevice: true`, and that claim was wrong in exactly the way
 * finding D-5 was wrong for Cloudflare Stream: the token carries the
 * identifiers, and nothing at the delivery edge ever re-checks them. The
 * delivery host is Atlas-owned and cross-site from the academy, so no
 * Atlas session reaches it — there is nothing to check against.
 *
 * These assertions exist so that claim cannot come back without someone
 * first making the gate genuinely enforce it.
 */
import { BasicVideoProvider } from './basic-video.provider';
import type { ConfigService } from '@nestjs/config';
import type { ProtectedMediaStorage } from '../storage/protected-media-storage.provider';
import type { BasicVideoConfig } from '../../config/configuration';

const BASE_CONFIG: BasicVideoConfig = {
  deliveryHost: 'video.atlas.test',
  signingSecret: 'a-local-test-secret',
  playbackTtlSeconds: 600,
  allowedOriginsConfigured: false,
};

function providerWith(
  overrides: Partial<BasicVideoConfig> = {},
  storage: Partial<ProtectedMediaStorage> = {},
): BasicVideoProvider {
  const config = { ...BASE_CONFIG, ...overrides };
  return new BasicVideoProvider(
    { getOrThrow: () => config } as unknown as ConfigService,
    {
      maxTtlSeconds: 600,
      presignPut: () => Promise.resolve('https://s3.test/put?sig=1'),
      deleteObject: () => Promise.resolve(),
      ...storage,
    } as unknown as ProtectedMediaStorage,
  );
}

describe('BasicVideoProvider.capabilities — what it honestly does NOT enforce', () => {
  it('does not claim session or device binding at the edge', () => {
    // The gate verifies signature, key, expiry, Origin and the revocation
    // list. It never compares the token's session/device claims against
    // the requester, because the delivery host is cross-site from the
    // academy and carries no Atlas session. A lifted token plays
    // elsewhere until it expires or is revoked.
    const capabilities = providerWith().capabilities();
    expect(capabilities.boundToSession).toBe(false);
    expect(capabilities.boundToDevice).toBe(false);
  });

  it('claims revocation only when a revocation list is actually wired', () => {
    // A denylist nobody publishes to revokes nothing. The capability is
    // read from configuration so it can never be an aspiration (AD-16).
    expect(providerWith().capabilities().revocableBeforeExpiry).toBe(false);
    expect(
      providerWith({
        revocationEndpoint: 'https://gate.test/revoke',
        revocationToken: 'token',
      }).capabilities().revocableBeforeExpiry,
    ).toBe(true);
  });

  it('claims origin restriction only when an origin list is actually configured', () => {
    expect(providerWith().capabilities().originRestricted).toBe(false);
    expect(
      providerWith({ allowedOriginsConfigured: true }).capabilities().originRestricted,
    ).toBe(true);
  });

  it('reports no DRM, no adaptive bitrate and no provider watermark', () => {
    const capabilities = providerWith().capabilities();
    // DL-19: a single 720p rendition, deliberately, so Atlas does not
    // inherit a transcoding pipeline in order to ship a cheaper tier.
    expect(capabilities.adaptiveBitrate).toBe(false);
    expect(capabilities.drm).toBe(false);
    expect(capabilities.watermark).toBe(false);
  });

  it('reports that it cannot enforce a maximum duration', () => {
    // A presigned PUT bounds Content-Length, never runtime minutes. This
    // flag is why the quota has to be re-checked when the real duration
    // lands (AD-14's second enforcement point).
    expect(providerWith().capabilities().enforcesMaxDuration).toBe(false);
  });

  it('reports readiness synchronously, because it has no webhook', () => {
    expect(providerWith().capabilities().reportsReadinessAsynchronously).toBe(false);
  });
});

describe('BasicVideoProvider — configuration', () => {
  it('is unconfigured without a delivery host or a signing secret', () => {
    expect(providerWith().isConfigured()).toBe(true);
    expect(providerWith({ deliveryHost: undefined }).isConfigured()).toBe(false);
    expect(providerWith({ signingSecret: undefined }).isConfigured()).toBe(false);
  });

  it('refuses to act at all when unconfigured, rather than minting something useless', async () => {
    const provider = providerWith({ signingSecret: undefined });
    await expect(
      provider.createDirectUpload({
        maxDurationSeconds: 60,
        allowedOrigins: [],
        metadata: { academyId: 'a1', assetId: 'v1' },
      }),
    ).rejects.toThrow(/not configured/);
  });

  it('records itself as r2_worker — where the bytes are', () => {
    expect(providerWith().key).toBe('r2_worker');
    expect(providerWith().storedAs).toBe('r2_worker');
  });
});

describe('BasicVideoProvider.createDirectUpload', () => {
  it('returns a REAL presigned PUT and the store’s true expiry (finding D-2/D-3)', async () => {
    const ticket = await providerWith().createDirectUpload({
      maxDurationSeconds: 600,
      allowedOrigins: [],
      metadata: { academyId: 'academy-1', courseId: 'course-1', assetId: 'asset-1' },
    });
    expect(ticket.uploadUrl).toBe('https://s3.test/put?sig=1');
    // The key is prefixed by academy AND course from verified context.
    expect(ticket.providerId).toContain('academies/academy-1/');
    expect(ticket.providerId).toContain('courses/course-1/');
    // 600 s is the store's real ceiling, not an optimistic 30 minutes.
    const ttlSeconds = Math.round((ticket.expiresAt.getTime() - Date.now()) / 1000);
    expect(ttlSeconds).toBeLessThanOrEqual(600);
    expect(ttlSeconds).toBeGreaterThan(590);
  });

  it('refuses to build a key without verified tenancy metadata', async () => {
    await expect(
      providerWith().createDirectUpload({
        maxDurationSeconds: 60,
        allowedOrigins: [],
        metadata: { assetId: 'asset-1' },
      }),
    ).rejects.toThrow(/academyId and assetId/);
  });
});

describe('BasicVideoProvider.issuePlaybackToken', () => {
  const request = {
    providerId: 'academies/a1/asset.mp4',
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    binding: { userId: 'u1', sessionId: 's1', deviceId: 'd1' },
    allowedOrigins: ['https://academy.test'],
  };

  it('never advertises an expiry beyond its own ceiling (finding D-3)', async () => {
    // The caller asked for two hours; the tier's credential lives ten
    // minutes. Reporting the two hours is precisely the bug D-3 recorded,
    // and it would strand a player mid-lesson with no reason to refresh.
    const descriptor = await providerWith().issuePlaybackToken(request);
    const ttlSeconds = Math.round((descriptor.expiresAt.getTime() - Date.now()) / 1000);
    expect(ttlSeconds).toBeLessThanOrEqual(600);
  });

  it('builds a URL on the configured delivery host and never sets downloadable', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);
    expect(descriptor.playbackUrl).toContain('https://video.atlas.test/v/');
    expect(descriptor.playbackUrl).toContain('?t=');
    expect(descriptor.format).toBe('mp4');
    expect(descriptor.downloadable).toBe(false);
  });

  it('mints a token the gate accepts, and rejects one that was tampered with', async () => {
    const provider = providerWith();
    const descriptor = await provider.issuePlaybackToken(request);
    expect(provider.verifyGateToken(descriptor.token!).valid).toBe(true);

    // Flipping one character of the signature must fail, and must not
    // throw — an attacker-controlled token cannot be allowed to turn
    // verification into a 500.
    const [payload, signature] = descriptor.token!.split('.');
    const flipped = signature[0] === 'a' ? 'b' : 'a';
    expect(() =>
      provider.verifyGateToken(`${payload}.${flipped}${signature.slice(1)}`),
    ).not.toThrow();
    expect(
      provider.verifyGateToken(`${payload}.${flipped}${signature.slice(1)}`).valid,
    ).toBe(false);
  });

  it('rejects a token of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch; the length guard is
    // what keeps that from becoming a denial of service.
    const provider = providerWith();
    expect(() => provider.verifyGateToken('short.abc')).not.toThrow();
    expect(provider.verifyGateToken('short.abc').valid).toBe(false);
    expect(provider.verifyGateToken('no-dot').valid).toBe(false);
  });

  it('rejects an expired token', async () => {
    const provider = providerWith();
    const descriptor = await provider.issuePlaybackToken(request);
    const wellAfterExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(provider.verifyGateToken(descriptor.token!, wellAfterExpiry).valid).toBe(
      false,
    );
  });

  it('carries the binding identifiers so a revocation can name a session', async () => {
    // They are NOT enforced at the edge (see the capability tests above),
    // but they are what makes per-session revocation expressible at all.
    const provider = providerWith();
    const descriptor = await provider.issuePlaybackToken(request);
    const { claims } = provider.verifyGateToken(descriptor.token!);
    expect(claims?.u).toBe('u1');
    expect(claims?.s).toBe('s1');
    expect(claims?.d).toBe('d1');
  });
});

describe('BasicVideoProvider — the methods it honestly cannot implement', () => {
  it('never verifies a webhook, because it has none', () => {
    // The only safe implementation. A `true` here would admit an
    // unauthenticated caller to the reconciliation path.
    expect(providerWith().verifyWebhookSignature()).toBe(false);
    expect(providerWith().parseWebhookEvent()).toBeNull();
  });

  it('has no remote to poll', async () => {
    await expect(providerWith().fetchAsset()).resolves.toBeNull();
  });
});
