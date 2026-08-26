/**
 * `POST organizations/:id/checkouts` request — matches `CreateCheckoutPayload`
 * (`checkout.types.ts`). Shallow, structural validation only (the global
 * `ValidationPipe` runs `whitelist: true`, so `target`'s nested shape must
 * still be declared here to pass through) — the real discriminated-union
 * validation of `target` happens in `CheckoutService` via
 * `checkoutTargetSchema` (`../validation/checkout.schemas.ts`), matching
 * `UpdateWebsiteConfigurationDto`'s identical "class-validator for shallow
 * shape, Zod for deep validation" precedent (P9/P10).
 */
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateCheckoutDto {
  @IsObject()
  readonly target!: Record<string, unknown>;

  @IsOptional()
  @IsIn(['monthly', 'yearly'])
  readonly billingCycle?: 'monthly' | 'yearly';

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  readonly idempotencyKey!: string;
}
