/**
 * `FakeVideoProvider` — the local/test `VideoProvider` (master plan
 * Phase 2 §D.4: "`FakeVideoProvider` for local/tests").
 *
 * WHY THIS IS NOT "FAKING PRODUCTION BEHAVIOUR IN APPLICATION CODE"
 *
 * The repository's standing rule is that application code must never
 * pretend a production integration succeeded. This class does the
 * opposite: it is a SELECTED adapter behind the same interface, chosen by
 * an explicit `VIDEO_PROVIDER=fake`, and it refuses to run in production
 * at all (`assertNotProduction`). Nothing branches on environment to
 * decide whether to be real — the wiring differs, the code does not.
 *
 * What it does provide is a genuinely protected local path, because a
 * "fake" that hands out an unprotected URL would make every local
 * validation of this phase meaningless:
 *
 *   - It mints a real, signed, expiring token (HMAC-SHA256 over the same
 *     binding claims the real provider signs) and refuses to verify a
 *     tampered or expired one.
 *   - Playback resolves to a presigned object in the PROTECTED bucket,
 *     so a local reviewer watching the network panel sees exactly what
 *     production shows: a short-lived signed URL, never a durable one.
 *
 * It reports `drm: false` (D1) and `watermark: false` — it has no
 * provider-side watermarking, and saying otherwise would let the UI
 * promise an overlay that is not there.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VideoProviderConfig } from '../../config/configuration';
import type {
  CreateDirectUploadInput,
  CreatedDirectUpload,
  PlaybackDescriptor,
  PlaybackTokenRequest,
  ProviderVideoAsset,
  VideoProvider,
  VideoProviderCapabilities,
  VideoWebhookEvent,
} from './video-provider.interface';
// A VALUE import, not `import type`: Nest resolves constructor
// parameters from emitted design-time metadata, and a type-only import is
// erased at compile time — leaving `ProtectedMediaStorage` as `Object`
// and the provider unresolvable at boot.
import { ProtectedMediaStorage } from '../storage/protected-media-storage.provider';

/** The object key a fake asset's bytes are expected at, mirroring the real provider's "the provider owns the bytes" shape. */
export function fakeVideoObjectKey(providerId: string): string {
  return `fake-video/${providerId}.mp4`;
}

interface FakeAsset {
  status: ProviderVideoAsset['status'];
  durationSeconds: number | null;
  reservedSeconds: number;
  metadata: Record<string, string>;
  allowedOrigins: string[];
}

@Injectable()
export class FakeVideoProvider implements VideoProvider {
  readonly key = 'fake' as const;
  /** Local stand-in: the bytes genuinely live in R2, so that is what the column records. */
  readonly storedAs = 'r2_worker' as const;

  private readonly config: VideoProviderConfig;
  /**
   * Process-local. A fake provider that persisted would be a second,
   * divergent source of truth about assets Atlas already tracks in
   * `media_assets`; the only thing kept here is what a REMOTE provider
   * would know and Atlas would not.
   */
  private readonly assets = new Map<string, FakeAsset>();

  constructor(
    configService: ConfigService,
    private readonly storage: ProtectedMediaStorage,
  ) {
    this.config = configService.getOrThrow<VideoProviderConfig>('video');
  }

  capabilities(): VideoProviderCapabilities {
    return {
      drm: false,
      signedPlayback: true,
      // The fake adapter presigns an R2 GET, which is bound to time and
      // key and nothing else — the same honest answer the Normal tier
      // gives for a bare presign.
      boundToSession: false,
      boundToDevice: false,
      revocableBeforeExpiry: false,
      originRestricted: false,
      directCreatorUpload: true,
      watermark: false,
      adaptiveBitrate: false,
      // Local development has no provider to call back, so readiness is
      // driven by the completion endpoint exactly as the Normal tier's is.
      reportsReadinessAsynchronously: false,
      enforcesMaxDuration: false,
    };
  }

  /**
   * Only outside production.
   *
   * Returning an unconditional `true` made
   * `VideoProviderRegistry.isTierAvailable('normal')` answer `true` on a
   * deployment with no Normal-tier configuration at all — so the upload
   * gate admitted the request, a reservation row was written, and the
   * failure surfaced only later from `assertNotProduction`. The registry
   * documents that "a configured Normal adapter always wins, so a real
   * deployment can never silently serve through the stand-in"; this is
   * what makes that true rather than aspirational.
   */
  isConfigured(): boolean {
    return process.env.NODE_ENV !== 'production';
  }

  async createDirectUpload(input: CreateDirectUploadInput): Promise<CreatedDirectUpload> {
    this.assertNotProduction();
    const providerId = `fake-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    this.assets.set(providerId, {
      status: 'pending',
      durationSeconds: null,
      reservedSeconds: input.maxDurationSeconds,
      metadata: { ...input.metadata },
      allowedOrigins: [...input.allowedOrigins],
    });
    // FINDING D-2. This used to return an empty string and defer the real
    // presign to a second method nobody called, so the ticket handed to
    // the browser had no upload URL in it at all. A local presigned PUT
    // is the whole point of this adapter — the browser uploads straight
    // to object storage and never through the API, which is the same
    // shape the real direct-creator-upload takes.
    return {
      providerId,
      uploadUrl: await this.storage.presignPut(
        fakeVideoObjectKey(providerId),
        'video/mp4',
        undefined,
        input.contentLength,
      ),
      // The REAL ceiling of the presign, not an optimistic 30 minutes
      // (the same honesty finding D-3 is about).
      expiresAt: new Date(Date.now() + this.storage.maxTtlSeconds * 1000),
    };
  }

  /** Test/local hook: what a provider webhook would report once processing finished. */
  markReady(providerId: string, durationSeconds: number): VideoWebhookEvent {
    const asset = this.assets.get(providerId);
    if (asset) {
      asset.status = 'ready';
      asset.durationSeconds = durationSeconds;
    }
    return { providerId, status: 'ready', durationSeconds };
  }

  async issuePlaybackToken(request: PlaybackTokenRequest): Promise<PlaybackDescriptor> {
    this.assertNotProduction();
    const claims = {
      sub: request.providerId,
      exp: Math.floor(request.expiresAt.getTime() / 1000),
      downloadable: false,
      atlasUserId: request.binding.userId,
      atlasSessionId: request.binding.sessionId,
      atlasDeviceId: request.binding.deviceId,
    };
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const token = `${body}.${this.sign(body)}`;

    // FINDING D-3. `presignGet` CLAMPS the TTL it is given down to the
    // protected store's own ceiling (ten minutes by default). This used
    // to ask for up to two hours, get ten minutes, and then report two
    // hours as `expiresAt` — so the grant advertised an expiry the URL
    // inside it did not have, and a learner would have been thrown out
    // mid-lesson with the player believing it still had 110 minutes left.
    //
    // The effective TTL is now computed from the store's real ceiling and
    // reported as the truth. The player refreshes against THAT, which is
    // what the mandatory refresh endpoint exists for.
    const requestedTtl = Math.max(
      1,
      Math.ceil((request.expiresAt.getTime() - Date.now()) / 1000),
    );
    const effectiveTtl = Math.min(requestedTtl, this.storage.maxTtlSeconds);
    const playbackUrl = await this.storage.presignGet(
      fakeVideoObjectKey(request.providerId),
      effectiveTtl,
    );

    return {
      token,
      expiresAt: new Date(Date.now() + effectiveTtl * 1000),
      format: 'mp4',
      playbackUrl,
      downloadable: false,
    };
  }

  /** Verifies a token this provider minted. Used by the refresh path and by tests asserting tampering fails. */
  verifyPlaybackToken(token: string, now: Date = new Date()): boolean {
    const [body, signature] = token.split('.');
    if (!body || !signature) return false;
    const expected = this.sign(body);
    if (expected.length !== signature.length) return false;
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        exp?: number;
      };
      return typeof claims.exp === 'number' && claims.exp * 1000 > now.getTime();
    } catch {
      return false;
    }
  }

  fetchAsset(providerId: string): Promise<ProviderVideoAsset | null> {
    const asset = this.assets.get(providerId);
    if (!asset) return Promise.resolve(null);
    return Promise.resolve({
      providerId,
      status: asset.status,
      durationSeconds: asset.durationSeconds,
    });
  }

  deleteAsset(providerId: string): Promise<void> {
    this.assets.delete(providerId);
    return Promise.resolve();
  }

  /**
   * The fake provider signs its webhooks with exactly the same scheme the
   * real one verifies (`time + "." + body`, HMAC-SHA256, 5-minute window),
   * so the webhook controller under test exercises the real verification
   * path rather than a bypass.
   */
  verifyWebhookSignature(args: {
    readonly rawBody: string;
    readonly signatureHeader: string | undefined;
    readonly now?: Date;
  }): boolean {
    // SEC-6 — this adapter's HMAC key falls back to a constant published
    // in this repository. Verifying against it in production would mean
    // anyone holding a copy of the source could forge a reconciliation
    // event. Every other method already refuses in production; this one
    // did not, and it is the only one an unauthenticated caller can
    // reach.
    if (process.env.NODE_ENV === 'production') return false;
    if (!args.signatureHeader) return false;
    const parts = new Map<string, string>();
    for (const segment of args.signatureHeader.split(',')) {
      const index = segment.indexOf('=');
      if (index > 0) {
        parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
      }
    }
    const time = parts.get('time');
    const provided = parts.get('sig1');
    if (!time || !provided) return false;
    const timeSeconds = Number(time);
    if (!Number.isFinite(timeSeconds)) return false;
    const nowSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - timeSeconds) > 300) return false;
    const expected = this.sign(`${time}.${args.rawBody}`);
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  }

  /** Signs a body the way the fake provider would send it — used by tests and the local seeding path. */
  signWebhook(rawBody: string, now: Date = new Date()): string {
    const time = Math.floor(now.getTime() / 1000).toString();
    return `time=${time},sig1=${this.sign(`${time}.${rawBody}`)}`;
  }

  parseWebhookEvent(rawBody: string): VideoWebhookEvent | null {
    try {
      const parsed = JSON.parse(rawBody) as {
        uid?: string;
        readyToStream?: boolean;
        duration?: number;
        status?: { state?: string };
      };
      if (!parsed.uid) return null;
      const state = parsed.status?.state;
      return {
        providerId: parsed.uid,
        status:
          state === 'ready' || parsed.readyToStream === true
            ? 'ready'
            : state === 'error'
              ? 'failed'
              : 'processing',
        durationSeconds:
          typeof parsed.duration === 'number' && parsed.duration >= 0
            ? Math.round(parsed.duration)
            : null,
      };
    } catch {
      return null;
    }
  }

  syncAllowedOrigins(
    providerId: string,
    allowedOrigins: readonly string[],
  ): Promise<void> {
    const asset = this.assets.get(providerId);
    if (asset) asset.allowedOrigins = [...allowedOrigins];
    return Promise.resolve();
  }

  private sign(value: string): string {
    // Keyed on the webhook secret when one is configured, otherwise on a
    // fixed local string. Not a security boundary — this adapter never
    // runs in production — but it must still be a real signature so that
    // "tampered token is rejected" is genuinely tested.
    return createHmac('sha256', this.config.webhookSecret ?? 'atlas-local-fake-video')
      .update(value)
      .digest('hex');
  }

  private assertNotProduction(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FakeVideoProvider refuses to run with NODE_ENV=production — configure a real VIDEO_PROVIDER.',
      );
    }
  }
}
