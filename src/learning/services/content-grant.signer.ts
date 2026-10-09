/**
 * `ContentGrantSigner` — turns an ALREADY-MADE entitlement decision into
 * something a delivery layer will honour (master plan Phase 2 §D.2, AD-1).
 *
 * The split from `LessonContentService` is the important part. That
 * service decides; this one signs. Nothing in this file reads an
 * enrollment, a course status or a device — by the time it is called, all
 * of that has been checked, and if it had to check again the two would
 * eventually disagree and one of them would be wrong.
 *
 * It also never chooses a TTL from the request. The R2 presign is 10
 * minutes and the video token is 10 minutes too (W5; it was 2 hours), both clamped
 * further down in `ProtectedMediaStorage`/the provider, so a caller cannot
 * ask for a longer-lived credential by asking differently.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MediaAsset } from '@prisma/client';
import type {
  ProtectedMediaConfig,
  VideoProviderConfig,
} from '../../config/configuration';
import { ProtectedMediaStorage } from '../../media/storage/protected-media-storage.provider';
import { VideoProviderRegistry } from '../../media/video/video-provider.registry';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import type { GrantedVideoContract } from '../dto/lesson-content.contract';
import type { VideoProviderCapabilities } from '../../media/video/video-provider.interface';

export interface SignedFile {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface VideoBinding {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  /** The academy the request was verified against. A token is refused when the asset belongs to a different one (Phase 2 §H). */
  readonly academyId: string;
  readonly allowedOrigins: readonly string[];
}

@Injectable()
export class ContentGrantSigner {
  private readonly protectedConfig: ProtectedMediaConfig;
  private readonly videoConfig: VideoProviderConfig;

  constructor(
    private readonly storage: ProtectedMediaStorage,
    private readonly videoProviders: VideoProviderRegistry,
    private readonly metrics: LearningMetricsService,
    configService: ConfigService,
  ) {
    this.protectedConfig =
      configService.getOrThrow<ProtectedMediaConfig>('protectedMedia');
    this.videoConfig = configService.getOrThrow<VideoProviderConfig>('video');
  }

  get fileTtlSeconds(): number {
    return this.protectedConfig.signedUrlTtlSeconds;
  }

  get videoTtlSeconds(): number {
    return this.videoConfig.playbackTokenTtlSeconds;
  }

  /**
   * A presigned GET for a protected object.
   *
   * A PUBLIC asset is returned by its durable URL instead — there is no
   * credential to mint for something that is already world-readable, and
   * signing it would imply a protection it does not have. Callers know
   * which they are getting from `asset.access`; the grant reports it as
   * `protection`.
   */
  async signFile(asset: MediaAsset): Promise<SignedFile> {
    const expiresAt = new Date(Date.now() + this.fileTtlSeconds * 1000);
    if (asset.access !== 'protected') {
      return { url: asset.url, expiresAt };
    }
    return {
      url: await this.storage.presignGet(asset.storageKey, this.fileTtlSeconds),
      expiresAt,
    };
  }

  /**
   * A playback credential bound to this session and device.
   *
   * Refuses across academies before signing anything: `meta.academyId` was
   * stamped on the asset when it was created, and a token minted for an
   * asset belonging to another tenant would be a cross-tenant capability
   * Atlas itself issued. This is the check Phase 2 §H calls "the signer
   * refuses cross-academy tokens", and it is here rather than in the
   * provider because it is a TENANCY rule, not a provider one.
   */
  async signVideo(
    asset: MediaAsset,
    binding: VideoBinding,
  ): Promise<{
    readonly video: GrantedVideoContract;
    readonly expiresAt: Date;
    readonly capabilities: VideoProviderCapabilities;
  }> {
    if (asset.academyId !== binding.academyId) {
      throw new Error(
        'Refusing to sign a video grant for an asset belonging to a different academy.',
      );
    }
    if (!asset.providerId) {
      throw new Error('Refusing to sign a video grant for an asset with no provider id.');
    }

    // AD-7's PLAYBACK axis: the adapter is resolved from the provider
    // recorded on the ASSET, never from the academy's current plan. An
    // academy that downgraded still has Premium videos, and they still
    // play through Premium (D11). This is the reason `media_assets.provider`
    // has to record the acting adapter (finding D-1).
    const provider = this.videoProviders.forProvider(asset.provider);
    const tier = asset.securityTier ?? 'normal';
    const startedAt = Date.now();

    const descriptor = await provider
      .issuePlaybackToken({
        providerId: asset.providerId,
        expiresAt: new Date(Date.now() + this.videoTtlSeconds * 1000),
        binding: {
          userId: binding.userId,
          sessionId: binding.sessionId,
          deviceId: binding.deviceId,
        },
        allowedOrigins: binding.allowedOrigins,
      })
      .then((result) => {
        this.metrics.recordTokenMint(tier, Date.now() - startedAt, true);
        return result;
      })
      .catch((error: unknown) => {
        // Counted before rethrowing: §U alerts on provider errors above
        // 2%, and an error that is only ever thrown is invisible to that.
        this.metrics.recordTokenMint(tier, Date.now() - startedAt, false);
        throw error;
      });

    return {
      video: {
        format: descriptor.format,
        url: descriptor.playbackUrl,
        posterUrl: descriptor.posterUrl,
        downloadable: false,
      },
      // The adapter's OWN reported expiry, which may be shorter than what
      // was asked for — a credential's real life, never an optimistic one
      // (finding D-3).
      expiresAt: descriptor.expiresAt,
      capabilities: provider.capabilities(),
    };
  }
}
