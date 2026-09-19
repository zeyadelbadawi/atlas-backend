/**
 * P64 Phase 2 — `CloudflareStreamProvider`, the parts that are a SECURITY
 * boundary rather than an HTTP client (master plan Phase 2 §D.4, §I, §N
 * "webhook signature verification", "token claims").
 *
 * WHAT IS AND IS NOT TESTED HERE. Everything below runs without a network:
 * capability reporting, the configuration guard, webhook verification,
 * webhook parsing, and local token signing. The API calls
 * (`createDirectUpload`, `fetchAsset`, `deleteAsset`, `syncAllowedOrigins`)
 * are deliberately absent — stubbing `fetch` would assert what this file
 * sends, never what Cloudflare accepts, which is exactly the illusion
 * `zoom.provider.spec.ts` already refuses to build.
 *
 * THE THREE PROPERTIES WORTH BREAKING A BUILD OVER
 *
 * 1. `drm: false`. D1 chose signed URLs plus deterrents over DRM, and the
 *    UI reads this flag to decide what it may promise a learner about
 *    protected content. A `true` here would be Atlas claiming a protection
 *    level that is not in force.
 *
 * 2. Webhook verification must REFUSE, never throw. The header is entirely
 *    attacker-controlled, and `crypto.timingSafeEqual` throws on a length
 *    mismatch — so a two-character `sig1` would turn signature
 *    verification into a 500 and, depending on the handler, into something
 *    an attacker can use to probe. The wrong-length case below is the one
 *    that actually catches a regression here; the wrong-value case passes
 *    either way.
 *
 * 3. `downloadable` is never absent and never true (Phase 2 §I). A
 *    downloadable token is a durable copy of protected content, which is
 *    the thing this phase exists to prevent, so the claim is asserted
 *    inside the signed payload rather than only on the descriptor.
 */
import {
  createHmac,
  createVerify,
  generateKeyPairSync,
  timingSafeEqual,
} from 'node:crypto';
import { CloudflareStreamProvider } from './cloudflare-stream.provider';
import type { ConfigService } from '@nestjs/config';
import type { VideoProviderConfig } from '../../config/configuration';

const WEBHOOK_SECRET = 'stream-webhook-secret';
const SUBDOMAIN = 'customer-abc123.cloudflarestream.com';

/** A throwaway key pair — signing is local, so a test can hold both halves. */
const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const FULL_CONFIG: VideoProviderConfig = {
  provider: 'cloudflare_stream',
  accountId: 'cf-account-id',
  apiToken: 'cf-api-token',
  signingKeyId: 'signing-key-id',
  signingKeyPem: keyPair.privateKey,
  webhookSecret: WEBHOOK_SECRET,
  customerSubdomain: SUBDOMAIN,
  playbackTokenTtlSeconds: 2 * 60 * 60,
};

/** The provider receives configuration; it never reaches for it. A plain object is the whole stub. */
function providerWith(
  overrides: Partial<VideoProviderConfig> = {},
): CloudflareStreamProvider {
  const config: VideoProviderConfig = { ...FULL_CONFIG, ...overrides };
  return new CloudflareStreamProvider({
    getOrThrow: () => config,
  } as unknown as ConfigService);
}

/** Builds the header Cloudflare itself would send. */
function signatureHeader(
  rawBody: string,
  timeSeconds: number,
  secret = WEBHOOK_SECRET,
): string {
  const sig = createHmac('sha256', secret)
    .update(`${timeSeconds.toString()}.${rawBody}`)
    .digest('hex');
  return `time=${timeSeconds.toString()},sig1=${sig}`;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('CloudflareStreamProvider.capabilities', () => {
  it('reports drm: false — Atlas ships signed URLs and deterrents, not DRM (D1)', () => {
    expect(providerWith().capabilities().drm).toBe(false);
  });

  /*
   * FINDING D-5, pinned down as a test.
   *
   * `issuePlaybackToken` signs Atlas's user, session and device into
   * custom JWT claims — and Cloudflare does not interpret claims it did
   * not define. The access rule it DOES read is `any/allow`. So a Stream
   * token lifted from one browser works in another for its full two
   * hours, and the only honest answer for both binding flags is `false`.
   *
   * This assertion exists because the opposite was previously asserted in
   * a code comment and would have been sold to customers as a security
   * property. If someone later "fixes" these to `true`, they must first
   * make Cloudflare actually enforce them.
   */
  it('reports the capabilities this adapter does have, and honestly reports the ones it does not', () => {
    expect(providerWith().capabilities()).toEqual({
      drm: false,
      signedPlayback: true,
      boundToSession: false,
      boundToDevice: false,
      revocableBeforeExpiry: false,
      originRestricted: true,
      directCreatorUpload: true,
      watermark: true,
      adaptiveBitrate: true,
      reportsReadinessAsynchronously: true,
      enforcesMaxDuration: true,
    });
  });

  it('never claims the session/device binding its own token claims describe (D-5)', () => {
    const capabilities = providerWith().capabilities();
    expect(capabilities.boundToSession).toBe(false);
    expect(capabilities.boundToDevice).toBe(false);
    // And its only kill switch is key revocation, which is not per-learner.
    expect(capabilities.revocableBeforeExpiry).toBe(false);
  });

  it('identifies itself as cloudflare_stream', () => {
    expect(providerWith().key).toBe('cloudflare_stream');
  });
});

describe('CloudflareStreamProvider.isConfigured', () => {
  it('is true only with a complete credential set', () => {
    expect(providerWith().isConfigured()).toBe(true);
  });

  const required: readonly (keyof VideoProviderConfig)[] = [
    'accountId',
    'apiToken',
    'signingKeyId',
    'signingKeyPem',
    'customerSubdomain',
  ];

  for (const key of required) {
    it(`is false when ${key} is missing`, () => {
      expect(providerWith({ [key]: undefined }).isConfigured()).toBe(false);
    });

    it(`is false when ${key} is an empty string`, () => {
      expect(providerWith({ [key]: '' }).isConfigured()).toBe(false);
    });
  }

  it('refuses to sign when it is not configured, rather than signing with nothing', async () => {
    const provider = providerWith({ signingKeyPem: undefined });
    await expect(
      provider.issuePlaybackToken({
        providerId: 'video-uid',
        expiresAt: new Date(Date.now() + 60_000),
        binding: { userId: 'u', sessionId: 's', deviceId: 'd' },
        allowedOrigins: ['https://academy.test'],
      }),
    ).rejects.toThrow(/not fully configured/i);
  });
});

describe('CloudflareStreamProvider.verifyWebhookSignature', () => {
  const rawBody = JSON.stringify({
    uid: 'abc123',
    status: { state: 'ready' },
    duration: 42,
  });
  const signedAt = 1_789_000_000;
  const now = new Date(signedAt * 1000);

  it('accepts a correctly signed header', () => {
    const provider = providerWith();
    expect(
      provider.verifyWebhookSignature({
        rawBody,
        signatureHeader: signatureHeader(rawBody, signedAt),
        now,
      }),
    ).toBe(true);
  });

  it('tolerates whitespace around the header parts', () => {
    const provider = providerWith();
    const header = signatureHeader(rawBody, signedAt).replace(',', ', ');
    expect(
      provider.verifyWebhookSignature({ rawBody, signatureHeader: header, now }),
    ).toBe(true);
  });

  /* FORGERY. Same shape, same length, wrong secret. */
  it('rejects a signature made with the wrong secret', () => {
    const provider = providerWith();
    expect(
      provider.verifyWebhookSignature({
        rawBody,
        signatureHeader: signatureHeader(rawBody, signedAt, 'not-the-secret'),
        now,
      }),
    ).toBe(false);
  });

  it('rejects a signature that is the right length but wrong', () => {
    const provider = providerWith();
    expect(
      provider.verifyWebhookSignature({
        rawBody,
        signatureHeader: `time=${signedAt.toString()},sig1=${'a'.repeat(64)}`,
        now,
      }),
    ).toBe(false);
  });

  /* TAMPERING. A body edited in flight no longer matches its signature. */
  it('rejects a body modified after signing', () => {
    const provider = providerWith();
    const header = signatureHeader(rawBody, signedAt);
    const tampered = rawBody.replace('"duration":42', '"duration":1');
    expect(
      provider.verifyWebhookSignature({
        rawBody: tampered,
        signatureHeader: header,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    const provider = providerWith();
    expect(
      provider.verifyWebhookSignature({ rawBody, signatureHeader: undefined, now }),
    ).toBe(false);
    expect(provider.verifyWebhookSignature({ rawBody, signatureHeader: '', now })).toBe(
      false,
    );
  });

  it('rejects malformed headers', () => {
    const provider = providerWith();
    const good = signatureHeader(rawBody, signedAt);
    const sig = good.split('sig1=')[1];
    const malformed = [
      'garbage',
      'sig1',
      `sig1=${sig}`, // no time
      `time=${signedAt.toString()}`, // no sig1
      `time=,sig1=${sig}`,
      `time=${signedAt.toString()},sig1=`,
      `time=not-a-number,sig1=${sig}`,
      `=${sig}`,
      ',,,',
    ];
    for (const signatureHeaderValue of malformed) {
      expect(
        provider.verifyWebhookSignature({
          rawBody,
          signatureHeader: signatureHeaderValue,
          now,
        }),
      ).toBe(false);
    }
  });

  /*
   * REPLAY. A stale message was genuine once — rejecting only forgeries
   * would let an old "ready, duration 30 s" event be replayed to rewrite a
   * reconciled quota figure.
   */
  it('rejects a timestamp older than the 300 s replay window', () => {
    const provider = providerWith();
    expect(
      provider.verifyWebhookSignature({
        rawBody,
        signatureHeader: signatureHeader(rawBody, signedAt),
        now: new Date((signedAt + 301) * 1000),
      }),
    ).toBe(false);
  });

  it('rejects a timestamp from the future, beyond the window', () => {
    const provider = providerWith();
    expect(
      provider.verifyWebhookSignature({
        rawBody,
        signatureHeader: signatureHeader(rawBody, signedAt),
        now: new Date((signedAt - 301) * 1000),
      }),
    ).toBe(false);
  });

  it('accepts a timestamp at the edge of the window in both directions', () => {
    const provider = providerWith();
    const header = signatureHeader(rawBody, signedAt);
    for (const skew of [300, -300]) {
      expect(
        provider.verifyWebhookSignature({
          rawBody,
          signatureHeader: header,
          now: new Date((signedAt + skew) * 1000),
        }),
      ).toBe(true);
    }
  });

  /*
   * THE LENGTH TRAP. `timingSafeEqual` THROWS when the two buffers differ
   * in length, and the attacker picks the length. This must be a refusal,
   * not an exception — asserted with an explicit `not.toThrow` because a
   * plain `toBe(false)` would report a regression as a confusing error
   * rather than as a failed security property.
   */
  it('does NOT throw on an attacker-supplied signature of the wrong length', () => {
    const provider = providerWith();
    const wrongLengths = ['ab', 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(4096), '0'];
    for (const provided of wrongLengths) {
      const call = () =>
        provider.verifyWebhookSignature({
          rawBody,
          signatureHeader: `time=${signedAt.toString()},sig1=${provided}`,
          now,
        });
      expect(call).not.toThrow();
      expect(call()).toBe(false);
    }
  });

  it('proves the length trap is real — timingSafeEqual itself throws', () => {
    // Documents WHY the guard in the provider exists, so nobody deletes it
    // as redundant.
    expect(() =>
      timingSafeEqual(Buffer.from('a'.repeat(64)), Buffer.from('ab')),
    ).toThrow();
  });

  /*
   * Fail closed, TWICE. A missing webhook secret verifies nothing (it does
   * not verify everything), AND it makes the provider report itself as not
   * configured — so a deployment in this state is refused at startup by
   * `env.validation.ts` rather than discovered later from assets that
   * never leave `processing`.
   */
  it('rejects everything when no webhook secret is configured, and reports itself unconfigured', () => {
    const provider = providerWith({ webhookSecret: undefined });
    expect(provider.isConfigured()).toBe(false);
    expect(
      provider.verifyWebhookSignature({
        rawBody,
        signatureHeader: signatureHeader(rawBody, signedAt),
        now,
      }),
    ).toBe(false);
  });
});

describe('CloudflareStreamProvider.parseWebhookEvent', () => {
  const provider = providerWith();

  const stateCases: readonly (readonly [string, string])[] = [
    ['ready', 'ready'],
    ['inprogress', 'processing'],
    ['queued', 'processing'],
    ['error', 'failed'],
    ['downloading', 'pending'],
    ['pendingupload', 'pending'],
  ];

  for (const [providerState, atlasStatus] of stateCases) {
    it(`maps Cloudflare's "${providerState}" to "${atlasStatus}"`, () => {
      const event = provider.parseWebhookEvent(
        JSON.stringify({ uid: 'abc123', status: { state: providerState } }),
      );
      expect(event?.status).toBe(atlasStatus);
      expect(event?.providerId).toBe('abc123');
    });
  }

  it('treats readyToStream as ready even without a state', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ uid: 'abc123', readyToStream: true }),
    );
    expect(event?.status).toBe('ready');
  });

  it('is pending when the payload says nothing about state', () => {
    const event = provider.parseWebhookEvent(JSON.stringify({ uid: 'abc123' }));
    expect(event?.status).toBe('pending');
  });

  it('carries the failure reason through, provider-agnostically', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({
        uid: 'abc123',
        status: { state: 'error', errorReasonText: 'Unsupported codec' },
      }),
    );
    expect(event?.status).toBe('failed');
    expect(event?.errorReason).toBe('Unsupported codec');
  });

  it('carries the thumbnail through', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({
        uid: 'abc123',
        status: { state: 'ready' },
        thumbnail: 'https://example.test/thumb.jpg',
      }),
    );
    expect(event?.thumbnailUrl).toBe('https://example.test/thumb.jpg');
  });

  /*
   * THE -1 TRAP. Stream reports `duration: -1` while the real duration is
   * still unknown. Storing that as a duration would corrupt the D5 video
   * quota it feeds — and it would corrupt it DOWNWARDS, which nobody
   * notices until an academy is over quota without knowing why.
   */
  it('treats a duration of -1 as unknown, not as a real duration', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ uid: 'abc123', status: { state: 'inprogress' }, duration: -1 }),
    );
    expect(event?.durationSeconds).toBeNull();
  });

  it('treats a missing duration as unknown', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ uid: 'abc123', status: { state: 'queued' } }),
    );
    expect(event?.durationSeconds).toBeNull();
  });

  it('rounds a real duration to whole seconds', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ uid: 'abc123', status: { state: 'ready' }, duration: 123.4 }),
    );
    expect(event?.durationSeconds).toBe(123);
  });

  it('keeps a zero duration, which is a measurement rather than an unknown', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ uid: 'abc123', status: { state: 'ready' }, duration: 0 }),
    );
    expect(event?.durationSeconds).toBe(0);
  });

  it('returns null for a body that is not JSON', () => {
    expect(provider.parseWebhookEvent('not json at all')).toBeNull();
    expect(provider.parseWebhookEvent('')).toBeNull();
    expect(provider.parseWebhookEvent('{"uid":')).toBeNull();
  });

  it('returns null for a body with no uid', () => {
    expect(
      provider.parseWebhookEvent(JSON.stringify({ status: { state: 'ready' } })),
    ).toBeNull();
    expect(provider.parseWebhookEvent(JSON.stringify({ uid: '' }))).toBeNull();
    expect(provider.parseWebhookEvent('null')).toBeNull();
    expect(provider.parseWebhookEvent('[]')).toBeNull();
  });
});

describe('CloudflareStreamProvider.issuePlaybackToken', () => {
  const expiresAt = new Date('2026-09-19T12:00:00.000Z');
  const request = {
    providerId: 'video-uid-123',
    expiresAt,
    binding: { userId: 'user-1', sessionId: 'session-1', deviceId: 'device-1' },
    allowedOrigins: ['https://academy.test'],
  };

  it('mints a three-segment base64url JWT', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);
    const segments = descriptor.token!.split('.');

    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no +, /, or =
    }
    expect(decodeSegment(segments[0])).toEqual({
      alg: 'RS256',
      kid: FULL_CONFIG.signingKeyId,
    });
  });

  it('signs the token with the configured key, over header.payload', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);
    const [header, payload, signature] = descriptor.token!.split('.');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(keyPair.publicKey, Buffer.from(signature, 'base64url'))).toBe(
      true,
    );
  });

  /* Phase 2 §I: tokens are never `downloadable`. Explicit, never omitted. */
  it('puts downloadable: false inside the SIGNED payload', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);
    const payload = decodeSegment(descriptor.token!.split('.')[1]);

    expect(payload).toHaveProperty('downloadable');
    expect(payload.downloadable).toBe(false);
    expect(descriptor.downloadable).toBe(false);
  });

  it('binds the token to the video, the session and the device', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);
    const payload = decodeSegment(descriptor.token!.split('.')[1]);

    expect(payload.sub).toBe('video-uid-123');
    expect(payload.atlasUserId).toBe('user-1');
    expect(payload.atlasSessionId).toBe('session-1');
    expect(payload.atlasDeviceId).toBe('device-1');
    // Covered by the signature, so none of them can be edited in flight.
  });

  it('expires exactly when the caller said, in seconds', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);
    const payload = decodeSegment(descriptor.token!.split('.')[1]);

    expect(payload.exp).toBe(Math.floor(expiresAt.getTime() / 1000));
    expect(payload.kid).toBe(FULL_CONFIG.signingKeyId);
    expect(descriptor.expiresAt).toEqual(expiresAt);
    // A small backdated nbf absorbs clock skew without widening the TTL.
    expect(payload.nbf as number).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('builds HLS playback on the configured customer subdomain', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);

    expect(descriptor.format).toBe('hls');
    expect(descriptor.playbackUrl).toBe(
      `https://${SUBDOMAIN}/${descriptor.token!}/manifest/video.m3u8`,
    );
    expect(descriptor.playbackUrl.startsWith(`https://${SUBDOMAIN}/`)).toBe(true);
    expect(descriptor.playbackUrl.endsWith('/manifest/video.m3u8')).toBe(true);
  });

  it('uses the same subdomain and token for the dash and poster URLs', async () => {
    const descriptor = await providerWith().issuePlaybackToken(request);
    const base = `https://${SUBDOMAIN}/${descriptor.token!}`;

    expect(descriptor.dashUrl).toBe(`${base}/manifest/video.mpd`);
    expect(descriptor.posterUrl).toBe(`${base}/thumbnails/thumbnail.jpg`);
  });
});
