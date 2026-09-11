/**
 * `MediaAsset` response contract — matches `MediaAssetSummary`/
 * `MediaAssetDetail` (`media.types.ts`) field-for-field; the frontend has
 * no separate detail shape, so this one projection backs both.
 *
 * `url` IS DERIVED FROM `storageKey`, NOT READ FROM THE STORED COLUMN.
 * That column holds whatever base URL happened to be configured at upload
 * time, and in production that was R2's S3 API endpoint — a URL no browser
 * can load without signing the request, which is exactly why uploaded
 * images rendered broken. Deriving it means every existing row is correct
 * from the next response onward, with no data migration, which is the
 * precise reason the schema keeps the key and the URL as separate fields:
 * "kept separate from `url` so the CDN/domain can change without a data
 * migration".
 */
import type { MediaAsset as PrismaMediaAsset } from '@prisma/client';

/**
 * Where Atlas serves its own media from, RELATIVE on purpose.
 *
 * A relative path resolves against whatever origin is asking — the
 * dashboard, an academy subdomain, or a custom domain bound to an academy —
 * so one stored value is correct everywhere and there is no host to keep in
 * sync with deployment. An absolute URL would have to name one origin and
 * would then be wrong on the others.
 */
const MEDIA_PUBLIC_PATH = '/api/v1/public/media';

/** The browser-loadable URL for a stored object. */
export function toMediaAssetUrl(storageKey: string): string {
  return `${MEDIA_PUBLIC_PATH}/${storageKey}`;
}

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
    url: toMediaAssetUrl(asset.storageKey),
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
