/**
 * The response shape for PROTECTED and provider-hosted assets
 * (master plan Phase 2 §D.1/§D.4, finding S1).
 *
 * WHY THIS IS NOT `toMediaAssetResponse`. That mapper derives
 * `url: toMediaAssetUrl(asset.storageKey)` — a path under the PUBLIC
 * media route. For a public library image that is exactly right. For a
 * protected asset it is finding S1 in miniature: it advertises a public
 * address for something that must only ever be reachable through a
 * short-lived signed grant. Worse, a provider-hosted video has an EMPTY
 * `storageKey` (the provider holds the bytes), so the field came out as a
 * public path pointing at nothing.
 *
 * A protected asset therefore has NO `url` at all. There is no durable
 * address to report, and inventing one would be the dishonest option; the
 * only way to a byte is `GET …/lessons/:lessonId/content`, which
 * re-decides entitlement and signs something that expires.
 *
 * It also reports what the upload path's caller actually needs and the
 * generic mapper omits: whether processing finished, the duration and
 * where that duration came from, and which tier and provider the asset
 * belongs to.
 */
import type { MediaAsset as PrismaMediaAsset } from '@prisma/client';

export interface ProtectedMediaAssetResponse {
  readonly id: string;
  readonly academyId: string;
  readonly courseId: string | null;
  readonly type: PrismaMediaAsset['type'];
  readonly status: PrismaMediaAsset['status'];
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** `protected` for everything this contract describes — stated rather than implied. */
  readonly access: PrismaMediaAsset['access'];
  readonly provider: PrismaMediaAsset['provider'];
  /** AD-15 — what Atlas promised for THIS asset. Null for a protected file, which is not tiered video. */
  readonly securityTier: PrismaMediaAsset['securityTier'];
  readonly processingStatus: PrismaMediaAsset['processingStatus'];
  readonly durationSeconds: number | null;
  /**
   * How the duration was established (D5). Surfaced because `declared`
   * means the quota is resting on the uploader's word for this asset, and
   * staff should be able to see that rather than having to infer it.
   */
  readonly durationSource: PrismaMediaAsset['durationSource'];
  readonly createdAt: string;
}

export function toProtectedMediaAssetResponse(
  asset: PrismaMediaAsset,
): ProtectedMediaAssetResponse {
  return {
    id: asset.id,
    academyId: asset.academyId,
    courseId: asset.courseId,
    type: asset.type,
    status: asset.status,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    // Safe: the protected upload ceiling is far below `MAX_SAFE_INTEGER`,
    // and provider-hosted video carries zero bytes of Atlas's own.
    sizeBytes: Number(asset.sizeBytes),
    access: asset.access,
    provider: asset.provider,
    securityTier: asset.securityTier,
    processingStatus: asset.processingStatus,
    durationSeconds: asset.durationSeconds,
    durationSource: asset.durationSource,
    createdAt: asset.createdAt.toISOString(),
    // Deliberately no `url`. See the header.
  };
}
