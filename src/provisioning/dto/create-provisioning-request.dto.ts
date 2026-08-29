/** `POST organizations/:id/provisioning-requests` request — matches `CreateProvisioningRequestPayload` (`provisioning.types.ts`) field-for-field. Validation floors mirror the frontend's own `createProvisioningRequestSchema` exactly. */
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  MAX_ACADEMY_NAME_LENGTH,
  MAX_SUBDOMAIN_LENGTH,
  MIN_SUBDOMAIN_LENGTH,
  SUBDOMAIN_REGEX,
} from './provisioning.constants';
import { WEBSITE_THEME_KEYS } from '../../website/constants/website.constants';

export class CreateProvisioningRequestDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_ACADEMY_NAME_LENGTH)
  readonly academyName!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(MIN_SUBDOMAIN_LENGTH)
  @MaxLength(MAX_SUBDOMAIN_LENGTH)
  @Matches(SUBDOMAIN_REGEX, { message: 'errors.provisioning.invalidSubdomain' })
  readonly requestedSubdomain!: string;

  @IsOptional()
  @IsString()
  readonly triggeringPaymentId?: string;

  /** Phase P19 — see `provisioning.constants.ts`'s `PROVISIONING_STEP_ORDER`'s own 'theme' step. Matches `WEBSITE_THEME_KEYS` exactly, the same real registry `UpdateWebsiteConfigurationDto` already validates against — never a second theme catalog. */
  @IsOptional()
  @IsIn(WEBSITE_THEME_KEYS)
  readonly selectedThemeKey?: (typeof WEBSITE_THEME_KEYS)[number];

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  readonly idempotencyKey!: string;
}
