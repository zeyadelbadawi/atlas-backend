/**
 * `BasicVideoProvider` — the NORMAL video tier (master plan D10, DL-19).
 *
 * WHAT IT IS. The bytes live in the protected R2 bucket Atlas already
 * owns. Delivery goes through the Cloudflare CDN on an Atlas-controlled
 * hostname, behind a Worker that validates a token Atlas mints. Playback
 * is a single progressive MP4 at 720p — no adaptive ladder, by decision
 * (DL-19), so Atlas does not inherit a transcoding pipeline in order to
 * ship a cheaper tier.
 *
 * WHY A WORKER AND NOT A BARE PRESIGN. A presigned S3 URL is bound to
 * time and key and nothing else: it cannot be tied to a session, it
 * cannot be revoked before it expires, and — the decisive constraint —
 * presigned URLs only work on the S3 API hostname, so a presign forgoes
 * the CDN entirely. A Worker is an arbitrary verifier Atlas controls, so
 * the Normal tier gets per-request authorization and revocation before
 * expiry, which is more than Cloudflare Stream enforces at its own edge
 * (finding D-5). That is why the two tiers are sold as *self-managed*
 * versus *platform-managed* delivery rather than "less secure" versus
 * "secure".
 *
 * WHAT IT HONESTLY CANNOT DO, and reports as such through
 * `capabilities()`:
 *   - `adaptiveBitrate: false` — one rendition, by decision.
 *   - `enforcesMaxDuration: false` — a presigned PUT can bound
 *     `Content-Length`, never runtime minutes, so the quota reservation
 *     is a declaration until Atlas measures the real duration itself.
 *   - `reportsReadinessAsynchronously: false` — there is no webhook.
 *     Readiness is finalised by the completion endpoint.
 *
 * ATLAS REMAINS THE AUTHORIZATION AUTHORITY (AD-1). Nothing in this file
 * decides whether a person may watch something; by the time
 * `issuePlaybackToken` is called, `LessonContentService` has already
 * checked all seven entitlement conditions. This adapter turns an
 * already-made decision into a credential the gate will honour.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BasicVideoConfig } from '../../config/configuration';
import { ProtectedMediaStorage } from '../storage/protected-media-storage.provider';
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

/**
 * The object key a Normal-tier video's bytes live at.
 *
 * Prefixed by academy and course from VERIFIED context, exactly like every
 * other protected object (Phase 2 §H), so a bucket listing is already
 * grouped by tenant for an incident response and a key built for one
 * academy can never be mistaken for another's.
 */
export function basicVideoObjectKey(args: {
  readonly academyId: string;
  readonly courseId?: string | null;
  readonly assetId: string;
}): string {
  return ProtectedMediaStorage.objectKey({ ...args, extension: 'mp4' });
}

/** What the Worker is handed, and what it verifies. Kept small on purpose — every field costs URL length on every segment request. */
interface GateClaims {
  /** Object key. */
  readonly k: string;
  /** Expiry, unix seconds. */
  readonly e: number;
  /** Atlas user id. */
  readonly u: string;
  /** Session id. */
  readonly s: string;
  /** Device id. */
  readonly d: string;
}

@Injectable()
export class BasicVideoProvider implements VideoProvider {
  readonly key = 'r2_worker' as const;
  readonly storedAs = 'r2_worker' as const;

  private readonly config: BasicVideoConfig;

  constructor(
    configService: ConfigService,
    private readonly storage: ProtectedMediaStorage,
  ) {
    this.config = configService.getOrThrow<BasicVideoConfig>('basicVideo');
  }

  capabilities(): VideoProviderCapabilities {
    return {
      drm: false,
      signedPlayback: true,
      // FALSE, and this is a correction made in review rather than a
      // limitation accepted at design time.
      //
      // The claim was that the Worker "re-checks the session on every
      // request". It does not, and it cannot: the delivery host is an
      // Atlas-owned hostname, cross-site from the academy the learner is
      // signed in to, so no Atlas session cookie reaches it. What the
      // Worker actually verifies is the token's signature, its object
      // key, its expiry, the request Origin and the revocation list.
      //
      // The token is MINTED for one session and carries its identifiers,
      // so it can be revoked by session — but a token lifted from one
      // browser will play in another until it expires or is revoked.
      // That is precisely the shape of finding D-5, and asserting the
      // opposite here would have reproduced D-5 on the tier the plan
      // presents as the stronger of the two. AD-16 exists for this.
      boundToSession: false,
      boundToDevice: false,
      // Revocation is real ONLY when the denylist is wired: the Worker
      // consults it per request, but a capability is a statement about
      // what is enforced, not about what the Worker could enforce if
      // Atlas were publishing to it. Reported from configuration so it
      // can never be an aspiration (AD-16).
      revocableBeforeExpiry: this.canRevoke(),
      // Enforced by the Worker's own Origin check against the academy
      // origins Atlas pushes to it. Honest caveat, the same one that
      // applies to the Premium tier: `Origin` is a header, and a
      // non-browser client sets it to anything. False when no origin
      // list has been configured, because then nothing is restricted.
      originRestricted: Boolean(this.config.allowedOriginsConfigured),
      directCreatorUpload: true,
      // No provider-side watermark. The player's per-viewer overlay is
      // still drawn — that is a client capability, not this one.
      watermark: false,
      // DL-19: single 720p rendition, deliberately.
      adaptiveBitrate: false,
      reportsReadinessAsynchronously: false,
      // A presigned PUT cannot bound runtime minutes.
      enforcesMaxDuration: false,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.config.deliveryHost && this.config.signingSecret);
  }

  /**
   * Whether Atlas can actually withdraw a credential before it expires.
   *
   * True only when a revocation endpoint is configured AND reachable in
   * principle — i.e. when Atlas has somewhere to publish a revoked
   * session to. Without it the Worker's denylist is an empty list that
   * nobody writes to, and `revocableBeforeExpiry` would be a promise the
   * system cannot keep.
   */
  private canRevoke(): boolean {
    return Boolean(this.config.revocationEndpoint && this.config.revocationToken);
  }

  /**
   * A presigned PUT straight into the protected bucket.
   *
   * The browser uploads to object storage directly — no video byte passes
   * through the API (AD-1). `providerId` is the object key, because for
   * this adapter the key IS the asset's identity; there is no separate
   * remote record to correlate with.
   */
  async createDirectUpload(input: CreateDirectUploadInput): Promise<CreatedDirectUpload> {
    this.assertConfigured();
    const assetId = input.metadata.assetId;
    const academyId = input.metadata.academyId;
    if (!assetId || !academyId) {
      throw new Error(
        'BasicVideoProvider requires academyId and assetId metadata to build an object key.',
      );
    }
    const key = basicVideoObjectKey({
      academyId,
      courseId: input.metadata.courseId,
      assetId,
    });
    return {
      providerId: key,
      uploadUrl: await this.storage.presignPut(key, 'video/mp4'),
      // The presign ceiling governs; reporting the real expiry rather than
      // an optimistic one is the D-3 lesson applied here from the start.
      expiresAt: new Date(Date.now() + this.storage.maxTtlSeconds * 1000),
    };
  }

  /**
   * Mints a gate token and assembles the delivery URL.
   *
   * The token binds the object key, the expiry and the viewer's identity.
   * It is carried in the query string; the Worker validates it before the
   * CDN is allowed to serve anything, and Atlas can stop honouring a
   * session at any time because the Worker asks Atlas's own rules rather
   * than a static signature.
   */
  issuePlaybackToken(request: PlaybackTokenRequest): Promise<PlaybackDescriptor> {
    this.assertConfigured();
    const expiresAt = new Date(
      Math.min(
        request.expiresAt.getTime(),
        Date.now() + this.config.playbackTtlSeconds * 1000,
      ),
    );
    const claims: GateClaims = {
      k: request.providerId,
      e: Math.floor(expiresAt.getTime() / 1000),
      u: request.binding.userId,
      s: request.binding.sessionId,
      d: request.binding.deviceId,
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;

    return Promise.resolve({
      token,
      // The REAL expiry of the credential in the URL, never the one the
      // caller hoped for (finding D-3).
      expiresAt,
      format: 'mp4',
      playbackUrl: `https://${this.config.deliveryHost}/v/${encodeURIComponent(
        request.providerId,
      )}?t=${token}`,
      downloadable: false,
    });
  }

  /**
   * Verifies a gate token. Exposed because the Worker delegates to Atlas
   * for anything beyond signature and expiry, and because the refresh path
   * and the tests need to prove that tampering fails.
   */
  verifyGateToken(
    token: string,
    now: Date = new Date(),
  ): { readonly valid: boolean; readonly claims?: GateClaims } {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return { valid: false };
    const expected = this.sign(payload);
    // Length first: `timingSafeEqual` THROWS on a length mismatch, and an
    // attacker-controlled token must not be able to turn verification
    // into a 500.
    if (expected.length !== signature.length) return { valid: false };
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return { valid: false };
    }
    try {
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as GateClaims;
      if (typeof claims.e !== 'number' || claims.e * 1000 <= now.getTime()) {
        return { valid: false };
      }
      return { valid: true, claims };
    } catch {
      return { valid: false };
    }
  }

  /**
   * There is no remote to poll: Atlas already knows everything there is to
   * know about an object in its own bucket. Returns null so the shared
   * status-poll path simply finds nothing to do for this adapter, rather
   * than inventing a status.
   */
  fetchAsset(): Promise<ProviderVideoAsset | null> {
    return Promise.resolve(null);
  }

  async deleteAsset(providerId: string): Promise<void> {
    await this.storage.deleteObject(providerId);
  }

  /**
   * This adapter has no webhook, and says so. Returning `false`
   * unconditionally is the only honest implementation — a `true` here
   * would admit an unauthenticated caller to the reconciliation path.
   */
  verifyWebhookSignature(): boolean {
    return false;
  }

  /** Unreachable: nothing verifies, so nothing parses. */
  parseWebhookEvent(): VideoWebhookEvent | null {
    return null;
  }

  /**
   * Origin restriction for this tier is a WAF rule on the delivery
   * hostname, set once for the zone rather than per asset. A no-op here
   * rather than a stub that pretends to have pushed something.
   */
  syncAllowedOrigins(): Promise<void> {
    return Promise.resolve();
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.signingSecret as string)
      .update(value)
      .digest('hex');
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        'The Normal video tier is selected but BASIC_VIDEO_DELIVERY_HOST / ' +
          'BASIC_VIDEO_SIGNING_SECRET are not configured — refusing to act.',
      );
    }
  }
}
