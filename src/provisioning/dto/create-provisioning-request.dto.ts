/** `POST organizations/:id/provisioning-requests` request — matches `CreateProvisioningRequestPayload` (`provisioning.types.ts`) field-for-field. Validation floors mirror the frontend's own `createProvisioningRequestSchema` exactly. */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  ValidateNested,
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
import {
  SELECTABLE_WEBSITE_THEME_KEYS,
  WEBSITE_SETUP_MODES,
} from '../../website/constants/website.constants';
import { RequestedPaymentMethodsDto } from './requested-payment-methods';

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

  /** Phase P19 — see `provisioning.constants.ts`'s `PROVISIONING_STEP_ORDER`'s own 'theme' step. Matches `SELECTABLE_WEBSITE_THEME_KEYS` exactly, the same real registry `UpdateWebsiteConfigurationDto` already validates against — never a second theme catalog. */
  @IsOptional()
  @IsIn(SELECTABLE_WEBSITE_THEME_KEYS)
  readonly selectedThemeKey?: (typeof SELECTABLE_WEBSITE_THEME_KEYS)[number];

  /**
   * Phase 6 (Bilingual Academy Websites) — how the generated website
   * starts once `selectedThemeKey` is applied (`executeThemeStep`).
   * Omitted (e.g. a caller that predates this field, or one that never
   * renders the setup-mode UI) is treated as `'empty'` — the safe,
   * backward-compatible default: a real, structured, theme-appropriate
   * shell, same as before this field existed. The real provisioning form
   * (`ProvisioningStartPage.tsx`) pre-selects `'complete'` for a human
   * filling it out, but that is a UI default, not this field's schema
   * default — the two are deliberately different (see the specification's
   * own §3.2). Meaningless without a `selectedThemeKey` — no theme means
   * no generation at all, exactly as before this field existed.
   */
  @IsOptional()
  @IsIn(WEBSITE_SETUP_MODES)
  readonly websiteSetupMode?: (typeof WEBSITE_SETUP_MODES)[number];

  /**
   * W2 — the brand chosen in the setup form, applied server-side by the
   * orchestrator's `branding` step: `{ palette?, logoPending? }`. Its
   * contents are validated by `parseRequestedBrand` (`requested-brand.ts`)
   * — strict keys, hex or `"H S% L%"` colours, an accessible palette, and
   * never a `data:` URI — so this decorator only asserts the shape is an
   * object. Omitted (older clients) means "theme default colours".
   */
  @IsOptional()
  @IsObject()
  readonly brand?: Record<string, unknown>;

  /**
   * Academy Manual Payments — the manual methods the owner chose in the
   * setup form (bank transfer, InstaPay, wallet), each with its typed
   * details. Saved enabled to the new Academy by the `academy` step.
   * Omitted ("set up later", or an older client) saves none.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => RequestedPaymentMethodsDto)
  readonly paymentMethods?: RequestedPaymentMethodsDto;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  readonly idempotencyKey!: string;
}
