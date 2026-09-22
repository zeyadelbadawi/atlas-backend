/**
 * `CloudflareStreamProvider` — the real `VideoProvider` adapter
 * (master plan Phase 2 §D.4).
 *
 * Everything Cloudflare-specific lives in this file and nowhere else: the
 * URL shapes, the JWT claim names, the webhook header format, the API
 * paths. Layers above it see only `VideoProvider`'s provider-agnostic
 * types, which is what AD-1 and the owner's standing constraint require —
 * business authorization is decided in `LessonContentService`, and this
 * class only turns an already-made decision into a credential Cloudflare's
 * edge will honour.
 *
 * THREE THINGS WORTH KNOWING BEFORE CHANGING ANYTHING HERE
 *
 * 1. Tokens are signed LOCALLY with the account's RSA signing key. Stream
 *    also offers a "sign this for me" API call, and using it would put a
 *    Cloudflare round-trip on the critical path of every single lesson
 *    play — an availability dependency Atlas does not need, since the same
 *    key signs offline.
 *
 * 2. `downloadable` is never set. Phase 2 §I states it as a rule; a token
 *    that permits download is a durable copy of protected content, which
 *    is the thing this whole phase exists to prevent.
 *
 * 3. Origin restriction is a property of the VIDEO, not of the token.
 *    Stream's `allowedOrigins` lives on the asset and is pushed by
 *    `syncAllowedOrigins`; the token's `accessRules` cannot express an
 *    origin. That is why the plan asks for an allowed-origins SYNC on
 *    domain go-live rather than a per-token origin claim — and why a
 *    manifest request from a foreign origin fails at Cloudflare's edge
 *    even with a perfectly valid token.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
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

/** Cloudflare rejects a webhook replayed outside this window (Phase 2 §D.4). */
const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

const API_BASE = 'https://api.cloudflare.com/client/v4';

interface StreamApiEnvelope<T> {
  readonly success: boolean;
  readonly errors?: readonly { readonly message?: string }[];
  readonly result?: T;
}

interface StreamVideoResult {
  readonly uid?: string;
  readonly readyToStream?: boolean;
  readonly duration?: number;
  readonly thumbnail?: string;
  readonly status?: { readonly state?: string; readonly errorReasonText?: string };
}

@Injectable()
export class CloudflareStreamProvider implements VideoProvider {
  readonly key = 'cloudflare_stream' as const;

  readonly storedAs = 'cloudflare_stream' as const;

  private readonly logger = new Logger(CloudflareStreamProvider.name);
  private readonly config: VideoProviderConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<VideoProviderConfig>('video');
  }

  capabilities(): VideoProviderCapabilities {
    return {
      // D1: Cloudflare Stream offers no DRM at all, so this is a fact
      // about the provider, not only a choice Atlas made.
      drm: false,
      signedPlayback: true,
      // FINDING D-5, reported honestly (AD-16). `issuePlaybackToken`
      // signs Atlas's user/session/device into custom claims, and
      // Cloudflare does not interpret claims it did not define — the
      // access rule it DOES read is `any/allow`. A token lifted from one
      // browser therefore works in another for its full two hours.
      // Atlas still checks the session when the grant is issued; what it
      // cannot do is make Cloudflare re-check it. Claiming otherwise
      // would sell a protection that is not in force.
      boundToSession: false,
      boundToDevice: false,
      // Stream's only kill switch is revoking a SIGNING KEY, which
      // invalidates every token minted with it — not one learner's.
      revocableBeforeExpiry: false,
      // `allowedOrigins` is enforced on the asset by Cloudflare's edge.
      originRestricted: true,
      directCreatorUpload: true,
      watermark: true,
      adaptiveBitrate: true,
      reportsReadinessAsynchronously: true,
      // The direct-upload request carries `maxDurationSeconds` and the
      // provider refuses anything longer, which is what makes Atlas's
      // quota reservation a real bound rather than a declaration.
      enforcesMaxDuration: true,
    };
  }

  /**
   * `webhookSecret` is part of "configured", not an optional extra.
   *
   * Without it `verifyWebhookSignature` returns false for every inbound
   * delivery, so Atlas would accept uploads and then silently never learn
   * that any of them finished — every asset would sit at `processing`
   * until the status poll happened to catch it, and every reservation
   * would keep consuming quota in the meantime. That is a failure an
   * operator should see at startup (where `env.validation.ts` refuses to
   * boot without it), not one they discover from a stuck quota meter.
   */
  isConfigured(): boolean {
    return Boolean(
      this.config.accountId &&
      this.config.apiToken &&
      this.config.signingKeyId &&
      this.config.signingKeyPem &&
      this.config.customerSubdomain &&
      this.config.webhookSecret,
    );
  }

  async createDirectUpload(input: CreateDirectUploadInput): Promise<CreatedDirectUpload> {
    this.assertConfigured();
    const body: Record<string, unknown> = {
      // The provider-side ceiling that makes Atlas's quota RESERVATION
      // real: an uploader who declared 10 minutes cannot smuggle in 90.
      maxDurationSeconds: input.maxDurationSeconds,
      // Without this the asset would be playable by anyone with its uid.
      // It is the single most important field in this request.
      requireSignedURLs: true,
      allowedOrigins: [...input.allowedOrigins],
      meta: { ...input.metadata },
    };
    if (input.watermarkProfileId) {
      body.watermark = { uid: input.watermarkProfileId };
    }

    const result = await this.request<{ uid?: string; uploadURL?: string }>(
      'POST',
      `/accounts/${this.config.accountId}/stream/direct_upload`,
      body,
    );
    if (!result?.uid || !result.uploadURL) {
      throw new Error('Cloudflare Stream returned no upload URL.');
    }
    return {
      providerId: result.uid,
      uploadUrl: result.uploadURL,
      // Stream's direct-upload URLs are valid for 30 minutes.
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }

  /**
   * Mints the playback token.
   *
   * The `binding` claims (`atlasUserId`/`atlasSessionId`/`atlasDeviceId`)
   * are Atlas's, not Cloudflare's: Cloudflare does not interpret them, but
   * they ARE covered by the signature, so a token cannot be edited to
   * point at a different session and Atlas can verify on refresh that the
   * token it is being asked to extend belongs to the caller in front of
   * it. The device/lease rules themselves are enforced upstream at the
   * grant endpoint — stating that plainly here because a reader could
   * otherwise assume Cloudflare is checking something it is not.
   */
  async issuePlaybackToken(request: PlaybackTokenRequest): Promise<PlaybackDescriptor> {
    this.assertConfigured();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expSeconds = Math.floor(request.expiresAt.getTime() / 1000);

    const header = { alg: 'RS256', kid: this.config.signingKeyId };
    const payload = {
      sub: request.providerId,
      kid: this.config.signingKeyId,
      exp: expSeconds,
      nbf: nowSeconds - 5,
      // Explicit, never omitted (Phase 2 §I).
      downloadable: false,
      accessRules: [{ type: 'any', action: 'allow' }],
      atlasUserId: request.binding.userId,
      atlasSessionId: request.binding.sessionId,
      atlasDeviceId: request.binding.deviceId,
    };

    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
      JSON.stringify(payload),
    )}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer
      .sign(this.config.signingKeyPem as string)
      .toString('base64url');
    const token = `${signingInput}.${signature}`;

    const base = `https://${this.config.customerSubdomain}/${token}`;
    return {
      token,
      expiresAt: request.expiresAt,
      format: 'hls',
      playbackUrl: `${base}/manifest/video.m3u8`,
      dashUrl: `${base}/manifest/video.mpd`,
      posterUrl: `${base}/thumbnails/thumbnail.jpg`,
      downloadable: false,
    };
  }

  async fetchAsset(providerId: string): Promise<ProviderVideoAsset | null> {
    this.assertConfigured();
    const result = await this.request<StreamVideoResult>(
      'GET',
      `/accounts/${this.config.accountId}/stream/${encodeURIComponent(providerId)}`,
    ).catch((error: unknown) => {
      this.logger.warn(
        { providerId, error: error instanceof Error ? error.message : String(error) },
        'Cloudflare Stream asset lookup failed.',
      );
      return null;
    });
    if (!result?.uid) return null;
    return toProviderAsset(result);
  }

  async deleteAsset(providerId: string): Promise<void> {
    this.assertConfigured();
    await this.request(
      'DELETE',
      `/accounts/${this.config.accountId}/stream/${encodeURIComponent(providerId)}`,
    );
  }

  /**
   * `Webhook-Signature: time=<unix>,sig1=<hex>` where the HMAC-SHA256 is
   * taken over `time + "." + rawBody` with the account's webhook secret.
   *
   * Two failure modes are handled separately on purpose: a WRONG signature
   * is an attacker, and a STALE one is a replay of a message that was once
   * genuine. Rejecting only the first would let an old "ready, duration
   * 30s" event be replayed to rewrite a reconciled quota figure.
   */
  verifyWebhookSignature(args: {
    readonly rawBody: string;
    readonly signatureHeader: string | undefined;
    readonly now?: Date;
  }): boolean {
    const secret = this.config.webhookSecret;
    if (!secret || !args.signatureHeader) return false;

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
    if (Math.abs(nowSeconds - timeSeconds) > WEBHOOK_REPLAY_WINDOW_SECONDS) return false;

    const expected = createHmac('sha256', secret)
      .update(`${time}.${args.rawBody}`)
      .digest('hex');

    // Length is compared first because `timingSafeEqual` THROWS on a length
    // mismatch rather than returning false — an attacker-controlled header
    // must not be able to turn signature verification into a 500.
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  }

  parseWebhookEvent(rawBody: string): VideoWebhookEvent | null {
    let parsed: StreamVideoResult;
    try {
      parsed = JSON.parse(rawBody) as StreamVideoResult;
    } catch {
      return null;
    }
    if (!parsed?.uid) return null;
    const asset = toProviderAsset(parsed);
    return {
      providerId: asset.providerId,
      status: asset.status,
      durationSeconds: asset.durationSeconds,
      thumbnailUrl: asset.thumbnailUrl,
      errorReason: asset.errorReason,
    };
  }

  async syncAllowedOrigins(
    providerId: string,
    allowedOrigins: readonly string[],
  ): Promise<void> {
    this.assertConfigured();
    await this.request(
      'POST',
      `/accounts/${this.config.accountId}/stream/${encodeURIComponent(providerId)}`,
      { allowedOrigins: [...allowedOrigins], requireSignedURLs: true },
    );
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        'Cloudflare Stream is selected but not fully configured — refusing to act.',
      );
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    let envelope: StreamApiEnvelope<T> | undefined;
    try {
      envelope = text ? (JSON.parse(text) as StreamApiEnvelope<T>) : undefined;
    } catch {
      envelope = undefined;
    }

    if (!response.ok || (envelope && envelope.success === false)) {
      // The provider's own message, never its full payload — a raw body can
      // carry account identifiers that do not belong in Atlas's logs.
      const reason =
        envelope?.errors?.[0]?.message ?? `HTTP ${response.status.toString()}`;
      throw new Error(`Cloudflare Stream request failed: ${reason}`);
    }
    return envelope?.result ?? null;
  }
}

function toProviderAsset(result: StreamVideoResult): ProviderVideoAsset {
  const state = result.status?.state;
  const status: ProviderVideoAsset['status'] =
    state === 'ready' || result.readyToStream === true
      ? 'ready'
      : state === 'error'
        ? 'failed'
        : state === 'inprogress' || state === 'queued'
          ? 'processing'
          : 'pending';
  return {
    providerId: result.uid as string,
    status,
    // Stream reports `-1` while the duration is still unknown; treating
    // that as a real duration would corrupt the quota figure it feeds.
    durationSeconds:
      typeof result.duration === 'number' && result.duration >= 0
        ? Math.round(result.duration)
        : null,
    thumbnailUrl: result.thumbnail,
    errorReason: result.status?.errorReasonText,
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
