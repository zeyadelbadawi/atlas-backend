/**
 * `PATCH organizations/:id/payments/:paymentId/proof` request — matches
 * `SubmitPaymentProofPayload` (`payment.types.ts`) exactly: `fileData` is
 * the base64 `data:<mime>;base64,<payload>` URL, the same no-upload-
 * endpoint bridge every base64 file field in Atlas uses (matches
 * `UploadMediaAssetDto.dataUrl`'s identical shape/precedent). `mimeType`/
 * `fileName` here are the client's claims only — never trusted; the real
 * kind/size are derived from the decoded bytes in `PaymentService.
 * submitProof` (mirrors `MediaService.upload`'s doc comment verbatim).
 */
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_PAYMENT_PROOF_NOTE_LENGTH } from './billing.constants';

export class SubmitPaymentProofDto {
  @IsNotEmpty()
  @IsString()
  readonly fileData!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  readonly fileName!: string;

  @IsNotEmpty()
  @IsString()
  readonly mimeType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PAYMENT_PROOF_NOTE_LENGTH)
  readonly note?: string;
}
