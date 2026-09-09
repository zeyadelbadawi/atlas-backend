/**
 * Request bodies for the Phase 10.2 subscription lifecycle endpoints.
 *
 * `confirm` is required and must be literally `true` on every mutating
 * request. It is not security — a client can always send it — but it
 * makes accidental invocation impossible: no stray retry, prefetch, or
 * mis-wired button can cancel a subscription or burn a trial without an
 * explicit, deliberate payload. The product requirement is that these
 * actions happen only on explicit confirmation, and this encodes that in
 * the contract rather than leaving it to the UI.
 */
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Equals } from 'class-validator';
import { CANCELLATION_REASONS } from '../services/trial-redemption.service';

export class StartTrialDto {
  /** Must be `true`. See this file's header for why explicit confirmation is part of the contract. */
  @IsBoolean()
  @Equals(true, { message: 'validation:confirmationRequired' })
  confirm!: boolean;

  /**
   * The plan chosen on the Plans page. Optional — omitting it falls back
   * to the default trial tier — but validated against the real catalog
   * server-side when present.
   */
  @IsOptional()
  @IsUUID()
  planId?: string;
}

export class CancelSubscriptionDto {
  @IsBoolean()
  @Equals(true, { message: 'validation:confirmationRequired' })
  confirm!: boolean;

  /** Closed vocabulary, so the admin dashboard can aggregate it. */
  @IsIn(CANCELLATION_REASONS as unknown as string[], {
    message: 'validation:invalidValue',
  })
  reason!: string;

  /**
   * Optional elaboration. Deliberately optional at every layer — DTO,
   * service and database column — because requiring feedback to cancel
   * turns leaving into a hostage negotiation.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'validation:maxLength' })
  feedback?: string;
}
