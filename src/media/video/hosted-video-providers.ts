/**
 * Which `media_assets.provider` values are PROVIDER-HOSTED VIDEO.
 *
 * One constant because the answer is used by four independent queries —
 * quota enforcement, usage reporting, webhook reconciliation and the
 * status poll — and the master plan (AD-14) requires the enforcement and
 * reporting aggregates to agree. They are separate implementations of the
 * same number by design, so the only way they cannot drift is by sharing
 * the definition rather than each spelling out a filter.
 *
 * `r2` is deliberately NOT in this set. That value is the protected FILE
 * tier — lesson attachments and documents — which is metered in gigabytes
 * by `videoStorage`. Counting a PDF against a video-minutes quota would be
 * meaningless, and counting a hosted video against both quotas would make
 * the Normal and Premium tiers incomparable to a customer choosing between
 * them (D5).
 */
import type { MediaAssetProvider } from '@prisma/client';

export const HOSTED_VIDEO_PROVIDERS: readonly MediaAssetProvider[] = [
  'r2_worker',
  'cloudflare_stream',
];
