/**
 * Platform Owner configuration of the manual bank-transfer methods
 * (`/platform-payment-methods`, 2 Oct 2026).
 *
 * Until now `payment_methods` had no write path at all — it was filled by
 * the development seed with sample bank details, which must never reach
 * production — so a production database had no method and Bank Transfer
 * could not be offered. These DTOs are that write path: real details are
 * entered by the Platform Owner, validated here, and nothing is invented.
 *
 * Only `manual_bank_transfer` is configurable: the type, provider
 * (`atlas_manual`) and capabilities are fixed by the server, never sent.
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class BankTransferInstructionsDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  readonly bankName!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  readonly accountName!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9 -]+$/, { message: 'validation:invalidAccountNumber' })
  readonly accountNumber!: string;

  /** ISO 13616: two letters, two check digits, up to 30 alphanumerics (spaces allowed for readability). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}[0-9]{2}[A-Za-z0-9 ]{10,32}$/, {
    message: 'validation:invalidIban',
  })
  readonly iban?: string;

  /** Optional SWIFT/BIC (8 or 11 characters). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/, {
    message: 'validation:invalidSwift',
  })
  readonly swiftCode?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  readonly instructions!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(1000)
  readonly referenceInstructions!: string;
}

export class CreatePlatformBankTransferMethodDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  readonly displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  readonly description?: string;

  @ValidateNested()
  @Type(() => BankTransferInstructionsDto)
  readonly instructions!: BankTransferInstructionsDto;

  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  readonly displayOrder?: number;
}

export class UpdatePlatformPaymentMethodDto {
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  readonly displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  readonly description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BankTransferInstructionsDto)
  readonly instructions?: BankTransferInstructionsDto;

  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  readonly displayOrder?: number;
}
