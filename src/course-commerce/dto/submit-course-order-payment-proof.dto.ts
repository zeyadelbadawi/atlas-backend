/** `PATCH course-orders/:id/payments/:paymentId/proof` request — identical shape to `SubmitPaymentProofDto` (P12), duplicated rather than imported because it is a distinct route with its own controller/module, matching this codebase's "one DTO per real route" convention (never a cross-module DTO import for a coincidentally-identical shape). */
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_PAYMENT_PROOF_NOTE_LENGTH } from '../../billing/dto/billing.constants';

export class SubmitCourseOrderPaymentProofDto {
  @IsNotEmpty()
  @IsString()
  readonly fileName!: string;

  @IsNotEmpty()
  @IsString()
  readonly fileData!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PAYMENT_PROOF_NOTE_LENGTH)
  readonly note?: string;
}
