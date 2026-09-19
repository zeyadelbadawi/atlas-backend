/**
 * P64 Phase 2 — REGRESSION SUITE FOR FINDINGS D-1 … D-5.
 *
 * Master plan Phase 2 §M (amended 19 Sep 2026) requires "regressions for
 * findings D-1 … D-5 specifically", and §V makes "Findings D-1 … D-5 each
 * have a regression test" an acceptance criterion. This file is that
 * suite, and nothing else: it is deliberately NOT general adapter
 * coverage, so it does not duplicate `cloudflare-stream.provider.spec.ts`
 * or `video-provider.registry.spec.ts`.
 *
 * WHAT EACH DEFECT'S REGRESSION HAS TO CATCH — stated here because a
 * regression test that asserts the fix rather than the FAILURE MODE
 * rots the moment the fix is refactored:
 *
 *   D-1 — `media_assets.provider` recorded the literal `'cloudflare_stream'`
 *         instead of the acting adapter. The DB write itself is asserted
 *         end-to-end (`test/p64-phase2-tiers.e2e-spec.ts`); what belongs
 *         HERE is the invariant that makes the column usable at all —
 *         whatever an adapter reports as `storedAs` must be a value
 *         `VideoProviderRegistry.forProvider` routes straight back to
 *         that same adapter. If that round trip ever breaks, writing the
 *         honest value becomes as useless as writing the constant was.
 *
 *   D-2 — `createDirectUpload` returned `uploadUrl: ''` and deferred the
 *         real presign to an uncalled method. The failure mode is an
 *         upload ticket whose URL cannot be uploaded to, so the assertion
 *         is on the URL actually handed out, not on whether some other
 *         method exists.
 *
 *   D-3 — the grant advertised a two-hour `expiresAt` for a URL that the
 *         protected store clamped to ten minutes. The failure mode is
 *         `expiresAt` EXCEEDING the real life of the credential inside
 *         the same response, so each test below compares the reported
 *         expiry against the TTL the adapter genuinely signed with,
 *         captured from the storage call rather than assumed.
 *
 *   D-4 — the only production writer of `ready` was the webhook handler,
 *         so a synchronous adapter would leave every asset `processing`
 *         forever. The unit-level invariant is the one that makes the
 *         completion endpoint the ONLY other door: an adapter that
 *         reports `reportsReadinessAsynchronously: false` must never
 *         verify a webhook as genuine, or `ready` would still be
 *         reachable by an unauthenticated caller. The endpoint itself is
 *         covered end-to-end.
 *
 *   D-5 — Cloudflare Stream does not enforce Atlas's session/device
 *         claims at its edge. `cloudflare-stream.provider.spec.ts` already
 *         pins that adapter's own report, so the non-duplicative
 *         assertion here is the CROSS-ADAPTER one AD-16 actually needs:
 *         no adapter may claim edge binding it does not enforce, and the
 *         two flags must never be reported as true "because the token
 *         carries the identifiers".
 */
import { CloudflareStreamProvider } from './cloudflare-stream.provider';
import { BasicVideoProvider, basicVideoObjectKey } from './basic-video.provider';
import { FakeVideoProvider, fakeVideoObjectKey } from './fake-video.provider';
import { VideoProviderRegistry } from './video-provider.registry';
import type { VideoProvider } from './video-provider.interface';
import type { ProtectedMediaStorage } from '../storage/protected-media-storage.provider';
import type { ConfigService } from '@nestjs/config';
import type { BasicVideoConfig, VideoProviderConfig } from '../../config/configuration';
import { generateKeyPairSync } from 'node:crypto';

/** A throwaway RSA key — Stream token signing is local, so a test can hold the private half. */
const streamSigningKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;

/** The protected store's real ceiling in these tests — deliberately far shorter than the two hours a caller asks for, because that gap IS defect D-3. */
const STORE_MAX_TTL_SECONDS = 600;
const REQUESTED_TTL_SECONDS = 2 * 60 * 60;

/** Records every TTL the adapter actually signed with, which is what D-3's assertion compares against. */
interface StorageSpy {
  readonly storage: ProtectedMediaStorage;
  readonly presignGetCalls: { key: string; ttlSeconds?: number }[];
  readonly presignPutCalls: { key: string; contentType: string }[];
}

function storageSpy(maxTtlSeconds = STORE_MAX_TTL_SECONDS): StorageSpy {
  const presignGetCalls: { key: string; ttlSeconds?: number }[] = [];
  const presignPutCalls: { key: string; contentType: string }[] = [];
  const storage = {
    get maxTtlSeconds() {
      return maxTtlSeconds;
    },
    presignGet: (key: string, ttlSeconds?: number) => {
      presignGetCalls.push({ key, ttlSeconds });
      return Promise.resolve(
        `https://storage.test.local/${key}?X-Amz-Expires=${String(ttlSeconds ?? maxTtlSeconds)}`,
      );
    },
    presignPut: (key: string, contentType: string) => {
      presignPutCalls.push({ key, contentType });
      return Promise.resolve(
        `https://storage.test.local/${key}?X-Amz-SignedHeaders=host`,
      );
    },
    deleteObject: () => Promise.resolve(),
  } as unknown as ProtectedMediaStorage;
  return { storage, presignGetCalls, presignPutCalls };
}

const VIDEO_CONFIG: VideoProviderConfig = {
  provider: 'fake',
  accountId: 'cf-account',
  apiToken: 'cf-token',
  signingKeyId: 'cf-key-id',
  signingKeyPem: streamSigningKey,
  webhookSecret: 'cf-webhook-secret',
  customerSubdomain: 'customer-abc.cloudflarestream.com',
  playbackTokenTtlSeconds: REQUESTED_TTL_SECONDS,
};

const BASIC_CONFIG: BasicVideoConfig = {
  deliveryHost: 'video.atlas.test',
  signingSecret: 'basic-signing-secret',
  playbackTtlSeconds: STORE_MAX_TTL_SECONDS,
  revocationEndpoint: 'https://worker.atlas.test/revocations',
  revocationToken: 'revocation-token',
  allowedOriginsConfigured: true,
};

function configStub<T>(value: T): ConfigService {
  return { getOrThrow: () => value } as unknown as ConfigService;
}

function fakeProviderWith(spy: StorageSpy): FakeVideoProvider {
  return new FakeVideoProvider(configStub(VIDEO_CONFIG), spy.storage);
}

function basicProviderWith(
  spy: StorageSpy,
  overrides: Partial<BasicVideoConfig> = {},
): BasicVideoProvider {
  return new BasicVideoProvider(
    configStub({ ...BASIC_CONFIG, ...overrides }),
    spy.storage,
  );
}

function cloudflareProvider(): CloudflareStreamProvider {
  return new CloudflareStreamProvider(configStub(VIDEO_CONFIG));
}

const UPLOAD_INPUT = {
  maxDurationSeconds: 600,
  allowedOrigins: ['https://academy.atlas.test'],
  metadata: { academyId: 'academy-1', courseId: 'course-1', assetId: 'asset-1' },
};

const TOKEN_REQUEST = {
  providerId: 'provider-asset-id',
  expiresAt: new Date(Date.now() + REQUESTED_TTL_SECONDS * 1000),
  binding: { userId: 'user-1', sessionId: 'session-1', deviceId: 'device-1' },
  allowedOrigins: ['https://academy.atlas.test'],
};

// ---------------------------------------------------------------------------
// D-1
// ---------------------------------------------------------------------------

describe('D-1 regression — the provider column has to route back to the acting adapter', () => {
  function registry(): {
    readonly registry: VideoProviderRegistry;
    readonly cloudflare: CloudflareStreamProvider;
    readonly basic: BasicVideoProvider;
  } {
    const cloudflare = cloudflareProvider();
    const basic = basicProviderWith(storageSpy());
    return {
      registry: new VideoProviderRegistry(
        cloudflare,
        basic,
        fakeProviderWith(storageSpy()),
      ),
      cloudflare,
      basic,
    };
  }

  it('routes every adapter back to itself through the value it asks to be stored as', () => {
    const { registry: resolved, cloudflare, basic } = registry();
    // The whole point of fixing D-1 was that the column becomes usable
    // for playback resolution. If `storedAs` were ever a value the
    // registry does not know, writing the truth would throw on the next
    // playback instead of silently routing to Cloudflare — a different
    // bug, equally fatal.
    expect(resolved.forProvider(cloudflare.storedAs)).toBe(cloudflare);
    expect(resolved.forProvider(basic.storedAs)).toBe(basic);
  });

  it('never lets the local stand-in record a value that is not a storage fact', () => {
    const fake = fakeProviderWith(storageSpy());
    // `fake` is not a place bytes can live. The objects really are in the
    // protected R2 bucket, so that is what the column has to say — and
    // `'fake'` is not even a `MediaAssetProvider` value, which is what
    // would make the row unroutable the day a real adapter took over.
    expect(fake.key).toBe('fake');
    expect(fake.storedAs).toBe('r2_worker');
    expect(fake.storedAs).not.toBe(fake.key);
  });

  it('throws a PLAIN Error for an unconfigured tier — which is why the caller must check availability FIRST', () => {
    // DEFECT FOUND BY THIS SUITE (reported, not patched — the fix belongs
    // in `src/media/services/protected-media.service.ts`, which this
    // worker does not own).
    //
    // `forTier` refuses an unconfigured tier by throwing a bare `Error`,
    // and the registry's own comment says the caller "turns this into the
    // same `videoNotEnabled` refusal". The caller cannot:
    // `protected-media.service.ts:204` calls `forTier(resolved.tier)`
    // BEFORE the feature-flag guard at :210 and the `isTierAvailable`
    // guard at :213. So a Premium-entitled academy whose Cloudflare
    // Stream is not yet onboarded — which Phase 2 §S says is the state on
    // day one of the Premium rollout — gets a 500 rather than the
    // intended `403 errors.media.videoNotEnabled`, and both guards below
    // it are unreachable.
    //
    // The assertion here is the registry half of that: the error is not
    // an HttpException, so nothing above it can map it to a status.
    const unconfiguredCloudflare = new CloudflareStreamProvider(
      configStub({ ...VIDEO_CONFIG, apiToken: undefined }),
    );
    const resolved = new VideoProviderRegistry(
      unconfiguredCloudflare,
      basicProviderWith(storageSpy()),
      fakeProviderWith(storageSpy()),
    );
    expect(unconfiguredCloudflare.isConfigured()).toBe(false);
    expect(resolved.isTierAvailable('premium')).toBe(false);
    expect(() => resolved.forTier('premium')).toThrow(
      'The premium video tier is not configured.',
    );
    // Not a `ForbiddenException` and not anything with a status — so a
    // caller that reaches it before checking `isTierAvailable` produces a
    // 500 by construction.
    try {
      resolved.forTier('premium');
      throw new Error('forTier should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('status');
      expect(error).not.toHaveProperty('response');
    }
  });

  it('keeps the premium adapter off the value the normal tier stores', () => {
    const { cloudflare, basic } = registry();
    // The original defect wrote `'cloudflare_stream'` for every asset.
    // Two adapters sharing one `storedAs` would reintroduce exactly that
    // ambiguity by a different route.
    expect(cloudflare.storedAs).toBe('cloudflare_stream');
    expect(basic.storedAs).toBe('r2_worker');
    expect(cloudflare.storedAs).not.toBe(basic.storedAs);
  });
});

// ---------------------------------------------------------------------------
// D-2
// ---------------------------------------------------------------------------

describe('D-2 regression — an upload ticket carries a URL that can actually be uploaded to', () => {
  it('the local adapter presigns a real PUT rather than returning an empty string', async () => {
    const spy = storageSpy();
    const created = await fakeProviderWith(spy).createDirectUpload(UPLOAD_INPUT);

    expect(created.uploadUrl).not.toBe('');
    expect(created.uploadUrl).toMatch(/^https:\/\//);
    // The URL must be the one the store signed, for the object this
    // asset's bytes are expected at — not some other plausible string.
    expect(spy.presignPutCalls).toEqual([
      { key: fakeVideoObjectKey(created.providerId), contentType: 'video/mp4' },
    ]);
    expect(created.uploadUrl).toContain(fakeVideoObjectKey(created.providerId));
  });

  it('the normal adapter presigns a PUT at the asset’s own tenant-prefixed key', async () => {
    const spy = storageSpy();
    const created = await basicProviderWith(spy).createDirectUpload(UPLOAD_INPUT);

    const expectedKey = basicVideoObjectKey({
      academyId: 'academy-1',
      courseId: 'course-1',
      assetId: 'asset-1',
    });
    expect(created.uploadUrl).not.toBe('');
    expect(created.providerId).toBe(expectedKey);
    expect(spy.presignPutCalls).toEqual([{ key: expectedKey, contentType: 'video/mp4' }]);
  });

  it('refuses to invent an upload key when the tenancy metadata is missing', async () => {
    const spy = storageSpy();
    await expect(
      basicProviderWith(spy).createDirectUpload({
        ...UPLOAD_INPUT,
        metadata: { courseId: 'course-1' },
      }),
    ).rejects.toThrow(/academyId and assetId/);
    // Nothing signed: an object key without a verified academy prefix is
    // the cross-tenant write Phase 2 §H exists to prevent.
    expect(spy.presignPutCalls).toHaveLength(0);
  });

  it('reports the presign’s own ceiling as the ticket expiry, not a hopeful one', async () => {
    const spy = storageSpy();
    const before = Date.now();
    const created = await fakeProviderWith(spy).createDirectUpload(UPLOAD_INPUT);
    const lifetimeSeconds = (created.expiresAt.getTime() - before) / 1000;

    // Same honesty rule as D-3, applied to the upload half: a ticket that
    // claims thirty minutes for a ten-minute presign sends the browser
    // back to a dead URL mid-upload.
    expect(lifetimeSeconds).toBeLessThanOrEqual(STORE_MAX_TTL_SECONDS);
    expect(lifetimeSeconds).toBeGreaterThan(STORE_MAX_TTL_SECONDS - 5);
  });
});

// ---------------------------------------------------------------------------
// D-3
// ---------------------------------------------------------------------------

describe('D-3 regression — a credential never outlives what it advertises', () => {
  it('the local adapter reports the CLAMPED presign life, not the two hours it was asked for', async () => {
    const spy = storageSpy();
    const before = Date.now();
    const descriptor = await fakeProviderWith(spy).issuePlaybackToken(TOKEN_REQUEST);

    const after = Date.now();
    const signedTtl = spy.presignGetCalls[0].ttlSeconds as number;
    expect(spy.presignGetCalls).toHaveLength(1);
    expect(spy.presignGetCalls[0].key).toBe(fakeVideoObjectKey(TOKEN_REQUEST.providerId));
    // The exact defect: asked for 7,200 s, the store signs 600 s, and the
    // pre-fix code reported 7,200 s anyway.
    expect(signedTtl).toBe(STORE_MAX_TTL_SECONDS);
    expect(signedTtl).toBeLessThan(REQUESTED_TTL_SECONDS);

    // Compared against the clock read AFTER the call, so the assertion is
    // exact rather than tolerant: the URL dies at `signingMoment +
    // signedTtl`, and `signingMoment <= after`, so an advertised expiry
    // beyond `after + signedTtl` is the URL outliving its advertisement.
    expect(descriptor.expiresAt.getTime()).toBeLessThanOrEqual(after + signedTtl * 1000);
    expect(descriptor.expiresAt.getTime()).toBeGreaterThan(
      before + (signedTtl - 5) * 1000,
    );
  });

  it('the local adapter honours a SHORTER request instead of always reporting the ceiling', async () => {
    const spy = storageSpy();
    const shortTtl = 120;
    const descriptor = await fakeProviderWith(spy).issuePlaybackToken({
      ...TOKEN_REQUEST,
      expiresAt: new Date(Date.now() + shortTtl * 1000),
    });

    // The fix must be "report the truth", not "always report the
    // ceiling" — otherwise a deliberately short-lived grant would be
    // advertised as ten minutes, which is the same lie inverted.
    expect(spy.presignGetCalls[0].ttlSeconds).toBeLessThanOrEqual(shortTtl);
    const advertisedTtl = (descriptor.expiresAt.getTime() - Date.now()) / 1000;
    expect(advertisedTtl).toBeLessThanOrEqual(shortTtl);
  });

  it('the normal adapter clamps to its own playback TTL and reports that', async () => {
    const descriptor =
      await basicProviderWith(storageSpy()).issuePlaybackToken(TOKEN_REQUEST);
    const advertisedTtl = (descriptor.expiresAt.getTime() - Date.now()) / 1000;

    expect(advertisedTtl).toBeLessThanOrEqual(BASIC_CONFIG.playbackTtlSeconds);
    expect(advertisedTtl).toBeGreaterThan(BASIC_CONFIG.playbackTtlSeconds - 5);
  });

  it('the normal adapter’s SIGNED expiry matches the expiry it advertises', async () => {
    const descriptor =
      await basicProviderWith(storageSpy()).issuePlaybackToken(TOKEN_REQUEST);
    const [payload] = (descriptor.token as string).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      e: number;
    };

    // The gate honours the SIGNED `e`, so an advertised expiry later than
    // the signed one is D-3 reappearing one layer down — the player would
    // believe it had time left while the Worker had already started
    // refusing.
    expect(claims.e).toBe(Math.floor(descriptor.expiresAt.getTime() / 1000));
  });

  it('never advertises longer than requested, for any requested lifetime', async () => {
    const spy = storageSpy();
    const provider = fakeProviderWith(spy);
    for (const requestedSeconds of [30, 300, 599, 600, 601, 3600, 7200]) {
      const at = Date.now();
      const descriptor = await provider.issuePlaybackToken({
        ...TOKEN_REQUEST,
        expiresAt: new Date(at + requestedSeconds * 1000),
      });
      const advertised = (descriptor.expiresAt.getTime() - at) / 1000;
      expect(advertised).toBeLessThanOrEqual(
        Math.min(requestedSeconds, STORE_MAX_TTL_SECONDS) + 1,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// D-4
// ---------------------------------------------------------------------------

describe('D-4 regression — a no-webhook adapter has an honest readiness story', () => {
  const synchronousAdapters: { name: string; build: () => VideoProvider }[] = [
    { name: 'FakeVideoProvider', build: () => fakeProviderWith(storageSpy()) },
    { name: 'BasicVideoProvider', build: () => basicProviderWith(storageSpy()) },
  ];

  it.each(synchronousAdapters)(
    '$name declares readiness is NOT asynchronous, which is what makes the completion endpoint mandatory',
    ({ build }) => {
      expect(build().capabilities().reportsReadinessAsynchronously).toBe(false);
    },
  );

  it.each(synchronousAdapters)(
    '$name refuses a forged or unsigned webhook outright',
    ({ build }) => {
      const provider = build();
      // If a synchronous adapter ever accepted one of these, an
      // unauthenticated caller could reach the reconciliation path and
      // flip an asset to `ready` — which is worse than the stuck
      // `processing` D-4 described.
      expect(
        provider.verifyWebhookSignature({
          rawBody: JSON.stringify({ uid: 'x', readyToStream: true }),
          signatureHeader: 'time=1,sig1=deadbeef',
        }),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature({
          rawBody: '',
          signatureHeader: undefined,
        }),
      ).toBe(false);
    },
  );

  it('the NORMAL tier adapter has no webhook door at all, so completion is the only path to ready', () => {
    const provider: VideoProvider = basicProviderWith(storageSpy());
    // `BasicVideoProvider` is the production-shaped synchronous adapter:
    // its bytes sit in Atlas's own bucket and no provider will ever call
    // back. Both halves of the webhook pair are closed, so the
    // completion endpoint is the single writer of `ready` — which is
    // exactly the hole D-4 identified, now filled from one side only.
    //
    // NOTE (reported, not asserted here): `FakeVideoProvider` reports the
    // same `reportsReadinessAsynchronously: false` but DOES implement a
    // working webhook pair, because it signs its own local webhooks so
    // the webhook controller can be exercised without a provider. That is
    // a local-adapter divergence from the capability it reports, not a
    // production one.
    expect(
      provider.verifyWebhookSignature({
        rawBody: '{"uid":"x"}',
        signatureHeader: 'time=1,sig1=deadbeef',
      }),
    ).toBe(false);
    expect(provider.parseWebhookEvent('{"uid":"x","readyToStream":true}')).toBeNull();
  });

  it('the asynchronous adapter still reports itself as asynchronous, so the two paths stay distinguishable', () => {
    expect(cloudflareProvider().capabilities().reportsReadinessAsynchronously).toBe(true);
  });

  it('a synchronous adapter does not pretend to poll a remote record either', async () => {
    // `fetchAsset` is the webhook's fallback. For an adapter whose bytes
    // sit in Atlas's own bucket there is no remote record to poll, and a
    // fabricated `ready` here would be the same dishonesty from the
    // status-poll direction.
    const provider: VideoProvider = basicProviderWith(storageSpy());
    await expect(provider.fetchAsset('some-key')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-5
// ---------------------------------------------------------------------------

describe('D-5 regression — no adapter claims edge binding it does not enforce', () => {
  const allAdapters: { name: string; build: () => VideoProvider }[] = [
    { name: 'CloudflareStreamProvider', build: () => cloudflareProvider() },
    { name: 'BasicVideoProvider', build: () => basicProviderWith(storageSpy()) },
    { name: 'FakeVideoProvider', build: () => fakeProviderWith(storageSpy()) },
  ];

  it.each(allAdapters)(
    '$name reports boundToSession and boundToDevice false',
    ({ build }) => {
      const capabilities = build().capabilities();
      // AD-16. Today NO adapter re-checks the session at its edge — the
      // Worker cannot (it is cross-site from the academy host) and
      // Cloudflare does not interpret custom claims. The day one genuinely
      // does, this test is the place that has to be changed deliberately,
      // with the enforcement to back it.
      expect(capabilities.boundToSession).toBe(false);
      expect(capabilities.boundToDevice).toBe(false);
    },
  );

  it.each(allAdapters)('$name reports drm false (D1)', ({ build }) => {
    expect(build().capabilities().drm).toBe(false);
  });

  it('the premium adapter does not claim revocation before expiry, because a key revocation is not one learner’s', () => {
    // Its only kill switch invalidates every token minted with the key.
    expect(cloudflareProvider().capabilities().revocableBeforeExpiry).toBe(false);
  });

  it('the normal adapter reports revocability from CONFIGURATION, never as an aspiration', () => {
    const wired = basicProviderWith(storageSpy());
    const unwired = basicProviderWith(storageSpy(), {
      revocationEndpoint: undefined,
      revocationToken: undefined,
    });
    expect(wired.capabilities().revocableBeforeExpiry).toBe(true);
    // An unwired denylist is a list nobody writes to; claiming
    // revocability then would reproduce D-5 on the tier the plan presents
    // as the stronger of the two.
    expect(unwired.capabilities().revocableBeforeExpiry).toBe(false);
  });

  it('the normal adapter reports origin restriction from CONFIGURATION too', () => {
    expect(basicProviderWith(storageSpy()).capabilities().originRestricted).toBe(true);
    expect(
      basicProviderWith(storageSpy(), { allowedOriginsConfigured: false }).capabilities()
        .originRestricted,
    ).toBe(false);
  });

  it('carries the session and device identifiers in the token even though the edge ignores them', async () => {
    // The identifiers are still signed — that is what makes revocation BY
    // session possible on the tier that has a denylist. D-5 is about the
    // claim, not about removing the claims.
    const descriptor =
      await basicProviderWith(storageSpy()).issuePlaybackToken(TOKEN_REQUEST);
    const [payload] = (descriptor.token as string).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u: string;
      s: string;
      d: string;
    };
    expect(claims).toMatchObject({ u: 'user-1', s: 'session-1', d: 'device-1' });
  });

  it.each(allAdapters)(
    '$name never mints a downloadable credential (§I)',
    async ({ build }) => {
      const descriptor = await build().issuePlaybackToken(TOKEN_REQUEST);
      expect(descriptor.downloadable).toBe(false);
    },
  );
});
