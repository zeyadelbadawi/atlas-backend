/**
 * Body for PATCH platform-add-ons/:key/arabic-text (B5 (UX audit) V21).
 *
 * The add-on's Arabic name and description, shown in the Arabic customer
 * store and checkout in place of the English ones. Both are optional
 * texts: an empty (or blank) value clears it, so the English one shows
 * again. The English name and description stay as the registry seeds them.
 *
 * Same lengths as a payment method's Arabic texts; `expectedVersion` is
 * the usual optimistic-concurrency token (`stale_resource_version` on a
 * miss), shared with the catalog-status change.
 */
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export const ADD_ON_NAME_AR_MAX_LENGTH = 80;
export const ADD_ON_DESCRIPTION_AR_MAX_LENGTH = 300;

export class UpdateAddOnArabicTextDto {
  @IsString()
  @MaxLength(ADD_ON_NAME_AR_MAX_LENGTH)
  readonly nameAr!: string;

  @IsString()
  @MaxLength(ADD_ON_DESCRIPTION_AR_MAX_LENGTH)
  readonly descriptionAr!: string;

  @IsInt()
  @Min(0)
  readonly expectedVersion!: number;
}
