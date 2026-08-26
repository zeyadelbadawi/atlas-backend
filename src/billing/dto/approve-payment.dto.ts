/** `POST /payments/:id/approve` request — matches `ApprovePaymentPayload` (`payment.types.ts`) exactly. Notes are optional — an approval is usually self-explanatory (matches the frontend's own `approvePaymentSchema`). */
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_PAYMENT_REVIEW_NOTES_LENGTH } from './billing.constants';

export class ApprovePaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PAYMENT_REVIEW_NOTES_LENGTH)
  readonly notes?: string;
}
