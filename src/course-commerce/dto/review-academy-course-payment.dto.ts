/**
 * Academy Manual Payments — the Client Owner's decision on a learner's
 * payment. Both texts are optional: approving needs no comment, and the
 * rejection reason (shown to the learner and sent in their email) is
 * encouraged by the UI but never required.
 */
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_PAYMENT_REVIEW_NOTES_LENGTH } from '../../billing/dto/billing.constants';

export class ApproveAcademyCoursePaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PAYMENT_REVIEW_NOTES_LENGTH)
  readonly notes?: string;
}

export class RejectAcademyCoursePaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PAYMENT_REVIEW_NOTES_LENGTH)
  readonly reason?: string;
}
