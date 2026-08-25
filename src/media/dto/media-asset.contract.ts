/** `MediaAsset` response contract — matches `MediaAssetSummary`/`MediaAssetDetail` (`media.types.ts`) field-for-field; the frontend has no separate detail shape, so this one projection backs both. */
import type { MediaAsset as PrismaMediaAsset } from '@prisma/client';

export interface MediaAssetDimensionsResponse {
  readonly width: number;
  readonly height: number;
}

export interface MediaAssetResponse {
  readonly id: string;
  readonly academyId: string;
  readonly type: PrismaMediaAsset['type'];
  readonly status: PrismaMediaAsset['status'];
  readonly fileName: string;
  readonly url: string;
  readonly altText?: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dimensions?: MediaAssetDimensionsResponse;
  readonly createdAt: string;
}

export function toMediaAssetResponse(asset: PrismaMediaAsset): MediaAssetResponse {
  return {
    id: asset.id,
    academyId: asset.academyId,
    type: asset.type,
    status: asset.status,
    fileName: asset.fileName,
    url: asset.url,
    altText: asset.altText ?? undefined,
    mimeType: asset.mimeType,
    // `bigint` at rest (master plan §5.9) — a `Number` conversion is safe
    // here: `MEDIA_MAX_UPLOAD_BYTES` (10MB default) is nowhere near
    // `Number.MAX_SAFE_INTEGER`, and the frontend's `sizeBytes` field is a
    // plain `number` (`media.types.ts`), never a bigint-safe string.
    sizeBytes: Number(asset.sizeBytes),
    dimensions:
      asset.width !== null && asset.height !== null
        ? { width: asset.width, height: asset.height }
        : undefined,
    createdAt: asset.createdAt.toISOString(),
  };
}
