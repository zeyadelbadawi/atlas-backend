/** Matches `MediaAssetStatus`/`MediaAssetType` (`media.types.ts`) exactly — mirrors `course.constants.ts`'s identical precedent. */
export const MEDIA_ASSET_STATUS_VALUES = ['active', 'archived'] as const;
export const MEDIA_ASSET_TYPE_VALUES = ['image', 'video', 'document', 'other'] as const;
