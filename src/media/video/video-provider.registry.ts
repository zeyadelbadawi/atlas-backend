/**
 * `VideoProviderRegistry` — picks the adapter (master plan AD-7, D10).
 *
 * WHY A REGISTRY REPLACED A TERNARY. The previous wiring chose one
 * adapter per process with `config.provider === 'cloudflare_stream' ?
 * cloudflare : fake`. With two production tiers that is wrong twice over:
 * it cannot serve a Normal asset and a Premium asset in the same academy
 * (D11 says mixed state is normal and expected), and a third enum value
 * would silently fall through to the fake adapter, which throws only in
 * production. A keyed lookup fails loudly instead, and follows the shape
 * `PaymentProviderAdapter` already established in this codebase.
 *
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT AXES. This is the part worth
 * reading carefully, because conflating them is how a two-provider system
 * starts lying about old content:
 *
 *   - **On UPLOAD**, resolve by the SECURITY TIER the academy is entitled
 *     to right now. This is a forward-looking product decision.
 *   - **On PLAYBACK**, resolve by `media_assets.provider` — the adapter
 *     that actually holds the bytes. This is a historical fact, and it
 *     must not be re-derived from the academy's current plan. An academy
 *     that downgraded still has Premium videos, and they still play
 *     through Premium (D11).
 *
 * Atlas authorization never enters this file. `LessonContentService` has
 * already decided; the registry only answers "who delivers it".
 */
import { Injectable } from '@nestjs/common';
import type { MediaAssetProvider, VideoSecurityTier } from '@prisma/client';
import { CloudflareStreamProvider } from './cloudflare-stream.provider';
import { BasicVideoProvider } from './basic-video.provider';
import { FakeVideoProvider } from './fake-video.provider';
import type { VideoProvider } from './video-provider.interface';

@Injectable()
export class VideoProviderRegistry {
  private readonly byKey: ReadonlyMap<string, VideoProvider>;

  constructor(
    cloudflare: CloudflareStreamProvider,
    basic: BasicVideoProvider,
    fake: FakeVideoProvider,
  ) {
    // Keyed on `storedAs` — the value `media_assets.provider` actually
    // holds — so `forProvider` can route an existing asset back to the
    // adapter that created it.
    //
    // The local stand-in occupies the `r2_worker` slot only while the real
    // Normal adapter is unconfigured, which is the local-development case.
    // A configured Normal adapter always wins, so a real deployment can
    // never silently serve through the stand-in — and the stand-in refuses
    // to run under `NODE_ENV=production` regardless.
    this.byKey = new Map<string, VideoProvider>([
      [cloudflare.storedAs, cloudflare],
      [basic.storedAs, basic.isConfigured() ? basic : fake],
    ]);
  }

  /**
   * The adapter that delivers a given tier.
   *
   * `premium` → Cloudflare Stream, `normal` → the R2 gate. The mapping
   * lives HERE and nowhere else: `premium` must never be hard-wired to a
   * provider class in the authorization layer (D10), and having exactly
   * one place that knows it is what makes changing the Normal tier's
   * provider a change to this method rather than to the plan model.
   *
   * Falls back to the local adapter only when the real one for that tier
   * is not configured, and says so — so a half-configured environment
   * behaves predictably in development and fails at the boot check in
   * production.
   */
  forTier(tier: VideoSecurityTier): VideoProvider {
    const key: MediaAssetProvider =
      tier === 'premium' ? 'cloudflare_stream' : 'r2_worker';
    const provider = this.byKey.get(key);
    if (!provider) {
      throw new Error(`No video provider is registered for the ${tier} tier.`);
    }
    if (!provider.isConfigured()) {
      // Reached only when an operator enabled a tier's rollout flag
      // without configuring its provider. Refused rather than silently
      // downgraded to the other tier: delivering Normal-tier protection
      // to an academy that bought Premium would be the worst possible
      // silent failure, and the caller turns this into the same
      // `videoNotEnabled` refusal an unconfigured tier already produces.
      throw new Error(`The ${tier} video tier is not configured.`);
    }
    return provider;
  }

  /**
   * The adapter that owns an existing asset.
   *
   * Keyed on the provider recorded when the asset was created, which is
   * why that column must record the ACTING adapter rather than a constant
   * (finding D-1). An unknown value throws rather than guessing: silently
   * routing an asset to the wrong adapter would mint a credential the
   * wrong edge honours, or none at all.
   */
  forProvider(provider: MediaAssetProvider): VideoProvider {
    const adapter = this.byKey.get(provider);
    if (!adapter) {
      throw new Error(`No video provider adapter is registered for "${provider}".`);
    }
    return adapter;
  }

  /**
   * Every adapter that reports readiness by webhook.
   *
   * The webhook controller has no asset until it has parsed a body it has
   * not yet verified, so it cannot resolve an adapter the way the upload
   * and playback paths do. Resolving from the process-wide default was
   * wrong in a specific and damaging way (security audit SEC-5): with the
   * Normal tier selected as the default — which is exactly what §T's
   * Normal-first rollout recommends — every Cloudflare Stream webhook was
   * rejected, so Premium video never reached `ready` and its quota
   * reservation never reconciled.
   *
   * Trying each webhook-capable verifier in turn is safe because the
   * SIGNATURE IS THE AUTHORIZATION: a forged body fails every one of
   * them, and a genuine one can only be verified by the provider that
   * actually sent it.
   */
  webhookCapable(): readonly VideoProvider[] {
    return [...new Set(this.byKey.values())].filter(
      (provider) =>
        provider.isConfigured() && provider.capabilities().reportsReadinessAsynchronously,
    );
  }

  /** Whether a tier can actually be used right now — the upload path's gate. */
  isTierAvailable(tier: VideoSecurityTier): boolean {
    const key: MediaAssetProvider =
      tier === 'premium' ? 'cloudflare_stream' : 'r2_worker';
    return this.byKey.get(key)?.isConfigured() ?? false;
  }
}
