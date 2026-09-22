/**
 * The seam between Atlas and a video hosting/delivery provider
 * (master plan Phase 2 §D.4, AD-1).
 *
 * WHAT THIS INTERFACE IS NOT
 *
 * It is not an authorization layer, and nothing in it decides whether a
 * person may watch something. AD-1 states the rule plainly: *Atlas is the
 * sole authorization authority; the provider is a delivery layer that only
 * honours capabilities Atlas signs.* By the time `issuePlaybackToken` is
 * called, `LessonContentService` has already checked all seven entitlement
 * conditions; the provider's only job is to turn an already-made decision
 * into something its own edge will honour.
 *
 * That separation is what keeps Atlas provider-independent. A second
 * provider is a new class implementing this interface plus a new
 * `MediaAssetProvider` enum value — no change to the policy decision
 * point, no change to any RLS policy, no change to the grant contract the
 * frontend consumes. Concretely, the rules this file follows so that stays
 * true:
 *
 *   - No method takes a `userId`, an enrollment, a course or a lesson as a
 *     thing to REASON about. `binding` carries opaque identifiers the
 *     provider echoes into a token and never interprets.
 *   - No method returns a decision. `issuePlaybackToken` returns a signed
 *     credential; refusing to issue one is Atlas's job, upstream.
 *   - Provider-shaped URLs are built HERE, by the adapter that knows them,
 *     and handed up as an already-assembled `PlaybackDescriptor`. Nothing
 *     above this layer concatenates a provider hostname.
 *   - `capabilities()` is how the layers above ask what is possible
 *     without naming a provider: the UI asks "is DRM available?", never
 *     "is this Cloudflare?".
 *
 * Mirrors `LiveProviderAdapter`'s established shape deliberately (one
 * interface, adapters that receive configuration rather than reaching for
 * it), which is the same pattern `PaymentProviderAdapter` set before it.
 */

import type { MediaAssetProvider } from '@prisma/client';

/**
 * What this provider can actually do.
 *
 * Exists so the rest of Atlas can branch on a CAPABILITY instead of on a
 * provider name. `drm` is reported `false` by every adapter today and that
 * is a recorded decision, not an oversight: D1 chose signed-URL protection
 * plus deterrents over DRM, and the honest way to express that is a
 * capability flag the UI can read, so the day a provider offers it the
 * answer changes in one place.
 */
export interface VideoProviderCapabilities {
  /** True only if the provider can enforce hardware/software DRM. `false` on every adapter — Cloudflare Stream does not offer it at all (D1). */
  readonly drm: boolean;
  /** Whether playback requires a credential Atlas mints. A provider that cannot do this cannot host protected video at all. */
  readonly signedPlayback: boolean;
  /**
   * Whether the DELIVERY EDGE re-checks the session the credential was
   * issued to, on every request.
   *
   * This is the flag finding D-5 exists for. Cloudflare Stream reports
   * `false`: it mints `accessRules: any/allow` and does not interpret
   * Atlas's custom JWT claims, so a Stream token lifted from one browser
   * works in another for its full life. Atlas still checks the session at
   * grant-issue time on both tiers — but "we checked once, two hours ago"
   * and "we check every request" are different promises, and AD-16
   * requires the grant to say which one the learner is getting.
   */
  readonly boundToSession: boolean;
  /** As `boundToSession`, for the registered device. */
  readonly boundToDevice: boolean;
  /**
   * Whether access can be cut off BEFORE the credential expires.
   *
   * `false` for Cloudflare Stream, whose only kill switch is revoking a
   * signing key — which invalidates every token minted with it, not one
   * learner's. `true` for a gate Atlas controls per request.
   */
  readonly revocableBeforeExpiry: boolean;
  /** Whether the provider's edge refuses a request from an origin Atlas did not allow. */
  readonly originRestricted: boolean;
  /** Whether the browser can upload straight to the provider, keeping video bytes off the VPS (AD-1). */
  readonly directCreatorUpload: boolean;
  /** Whether a per-academy visible watermark profile can be applied by the PROVIDER (a client-side overlay is always available and is not this). */
  readonly watermark: boolean;
  /** Whether the provider produces an adaptive-bitrate ladder. `false` on the Normal tier by decision (DL-19), not by accident. */
  readonly adaptiveBitrate: boolean;
  /**
   * Whether the provider reports processing completion asynchronously, by
   * webhook. When `false`, the upload is finalised synchronously through
   * the completion endpoint — a provider with no webhook must never be
   * asked to implement one dishonestly.
   */
  readonly reportsReadinessAsynchronously: boolean;
  /**
   * Whether the provider itself refuses an upload longer than the
   * `maxDurationSeconds` Atlas reserved against.
   *
   * `false` for a presigned PUT, which can bound `Content-Length` but not
   * runtime minutes. Reported rather than silently dropped, because the
   * quota reservation's guarantee is only as strong as this flag.
   */
  readonly enforcesMaxDuration: boolean;
}

export interface CreateDirectUploadInput {
  /**
   * The ceiling Atlas RESERVES quota against before the upload starts
   * (D5/AD-14). The provider is asked to refuse anything longer, so the
   * reservation cannot be exceeded by uploading a file bigger than
   * declared.
   */
  readonly maxDurationSeconds: number;
  /**
   * The exact hosts allowed to play this video back. Built by Atlas from
   * the academy's own live hostnames — never a wildcard the adapter
   * invents.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Opaque tenancy tags the provider stores alongside the asset and
   * returns on its webhooks. Atlas puts `academyId`/`courseId` here so a
   * webhook can be attributed and so a token request for the wrong
   * academy can be refused (Phase 2 §H) — the provider never interprets
   * them.
   */
  readonly metadata: Readonly<Record<string, string>>;
  /** Provider-side watermark profile id, when the academy has one configured. */
  readonly watermarkProfileId?: string;
}

export interface CreatedDirectUpload {
  /** The provider's own asset identifier. Stored as `media_assets.provider_id`. */
  readonly providerId: string;
  /** One-shot, short-lived upload endpoint handed to the browser. Never stored. */
  readonly uploadUrl: string;
  readonly expiresAt: Date;
}

/**
 * Everything the provider needs to mint ONE playback credential.
 *
 * `binding` carries the identifiers Atlas checked on the way in.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE (finding D-5, AD-16). Whether
 * these identifiers are ENFORCED depends entirely on the adapter, and the
 * two production adapters differ:
 *
 *   - An adapter with a gate Atlas controls re-checks them on every
 *     request, and reports `boundToSession`/`boundToDevice` as `true`.
 *   - Cloudflare Stream signs them into custom JWT claims and then IGNORES
 *     them: its `accessRules` are `any/allow`, and it does not interpret
 *     claims it did not define. A token lifted from one browser works in
 *     another for its full life. It reports both flags as `false`.
 *
 * An earlier version of this comment asserted the first behaviour for
 * both. It was wrong, and the grant contract now reports the capability
 * rather than repeating the assumption.
 */
export interface PlaybackTokenRequest {
  readonly providerId: string;
  readonly expiresAt: Date;
  readonly binding: {
    readonly userId: string;
    readonly sessionId: string;
    readonly deviceId: string;
  };
  readonly allowedOrigins: readonly string[];
}

/**
 * A ready-to-play descriptor. Assembled by the adapter, because only the
 * adapter knows the provider's URL shapes; consumed verbatim above.
 */
export interface PlaybackDescriptor {
  /**
   * The provider's own credential, when it has one that is separable from
   * the URL.
   *
   * OPTIONAL since P64 Phase 2: for a presigned or gate-signed URL the
   * credential IS the query string, and there is no second artefact to
   * return. It was previously required and read by nobody, so an adapter
   * in that shape had to return a duplicate or an empty string — both
   * lies. Nothing consumes this field today; it exists for a provider
   * whose player needs the token separately from the manifest URL.
   */
  readonly token?: string;
  readonly expiresAt: Date;
  /**
   * Which container the player should expect at `playbackUrl`.
   *
   * Present because "the URL ends in .m3u8" is not something the layers
   * above should have to infer from a string: the frontend adapter picks
   * hls.js or the browser's native element from THIS field, and a future
   * provider that serves progressive MP4 is then a new adapter rather than
   * a new special case in the player.
   */
  readonly format: 'hls' | 'mp4';
  readonly playbackUrl: string;
  readonly dashUrl?: string;
  readonly posterUrl?: string;
  /**
   * Whether this descriptor permits DOWNLOAD as well as playback. ALWAYS
   * `false` (Phase 2 §I: "tokens never `downloadable`"). Present as an
   * explicit field rather than an unstated assumption so that a future
   * adapter cannot quietly enable it and so a test can assert it.
   */
  readonly downloadable: false;
}

/** The provider's view of one asset — the reconciliation source for D5's real duration. */
export interface ProviderVideoAsset {
  readonly providerId: string;
  readonly status: 'pending' | 'processing' | 'ready' | 'failed';
  /** The REAL measured duration, once known. Null while the provider is still processing. */
  readonly durationSeconds: number | null;
  readonly thumbnailUrl?: string;
  /** Provider-agnostic failure summary — never a raw provider payload. */
  readonly errorReason?: string;
}

/** One asset-status change reported by a webhook. */
export interface VideoWebhookEvent {
  readonly providerId: string;
  readonly status: ProviderVideoAsset['status'];
  readonly durationSeconds: number | null;
  readonly thumbnailUrl?: string;
  readonly errorReason?: string;
}

export interface VideoProvider {
  /**
   * The adapter's identity, matching a `MediaAssetProvider` value so an
   * asset can be routed back to the adapter that created it. Widened in
   * P64 Phase 2 (D10) — `CloudflareStreamProvider` is no longer the only
   * production implementation (superseded AD-7, recorded as DL-16).
   */
  readonly key: 'fake' | 'cloudflare_stream' | 'r2_worker';

  /**
   * What `media_assets.provider` records for an asset this adapter
   * created — i.e. WHERE THE BYTES ARE (AD-15).
   *
   * Usually the same as `key`, and deliberately separate for the local
   * adapter: `fake` is not a place bytes can live, but its objects really
   * do sit in Atlas's R2 bucket and really are delivered by a signed URL,
   * so recording them as `r2_worker` is the true statement about their
   * storage. Writing `fake` into the column would make the value
   * unroutable on playback the moment a real adapter took over.
   */
  readonly storedAs: MediaAssetProvider;

  capabilities(): VideoProviderCapabilities;

  /** Whether this adapter holds enough configuration to do real work. A provider that answers `false` must never be asked to sign. */
  isConfigured(): boolean;

  createDirectUpload(input: CreateDirectUploadInput): Promise<CreatedDirectUpload>;

  /**
   * Mints a short-lived playback credential for an ALREADY-AUTHORIZED
   * request. Implementations sign locally where the provider allows it —
   * a network round-trip per play would put the provider on the critical
   * path of every lesson.
   */
  issuePlaybackToken(request: PlaybackTokenRequest): Promise<PlaybackDescriptor>;

  /** Status poll — the fallback for a webhook that never arrived (Phase 2 §D.4). */
  fetchAsset(providerId: string): Promise<ProviderVideoAsset | null>;

  deleteAsset(providerId: string): Promise<void>;

  /**
   * Verifies an inbound webhook is genuinely from the provider. Returns a
   * boolean rather than throwing so the caller decides the HTTP shape.
   * Implementations MUST use a timing-safe comparison and MUST reject
   * stale timestamps.
   */
  verifyWebhookSignature(args: {
    readonly rawBody: string;
    readonly signatureHeader: string | undefined;
    readonly now?: Date;
  }): boolean;

  /** Parses an already-verified webhook body. Returns null for events Atlas does not act on. */
  parseWebhookEvent(rawBody: string): VideoWebhookEvent | null;

  /**
   * Pushes the academy's current live hostnames to the provider so its
   * edge refuses a manifest request from anywhere else (Phase 2 §D.4/§H).
   * Called on domain go-live and release, not per request.
   */
  syncAllowedOrigins(
    providerId: string,
    allowedOrigins: readonly string[],
  ): Promise<void>;
}

export const VIDEO_PROVIDER = Symbol('VIDEO_PROVIDER');
