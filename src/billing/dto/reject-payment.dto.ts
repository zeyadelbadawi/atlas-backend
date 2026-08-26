/** `POST /payments/:id/reject` request — matches `RejectPaymentPayload` (`payment.types.ts`) exactly. `notes` is required — the frontend's own `rejectPaymentSchema` floor (`MIN_PAYMENT_REJECTION_NOTES_LENGTH`): the Tenant needs an actionable reason. */
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import {
  MAX_PAYMENT_REVIEW_NOTES_LENGTH,
  MIN_PAYMENT_REJECTION_NOTES_LENGTH,
} from './billing.constants';

export class RejectPaymentDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(MIN_PAYMENT_REJECTION_NOTES_LENGTH)
  @MaxLength(MAX_PAYMENT_REVIEW_NOTES_LENGTH)
  readonly notes!: string;
}
