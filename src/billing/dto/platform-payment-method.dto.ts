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
 * Configurable: `manual_bank_transfer`, `manual_wallet_transfer` (Egyptian
 * mobile wallets: Vodafone Cash, Orange Cash, Etisalat Cash, WE Pay, or
 * another provider by name) and `manual_instapay`. The type, provider
 * (`atlas_manual`) and capabilities are fixed by the server, never sent;
 * a method created or edited here is never a placeholder.
 *
 * Every customer-facing text has an optional Arabic version (`…Ar`); the
 * English one is required and is the fallback.
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
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

  @IsOptional()
  @IsString()
  @MaxLength(120)
  readonly accountNameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly instructionsAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  readonly referenceInstructionsAr?: string;
}

/** The account holder and the customer-facing texts every manual method shares. */
class ManualMethodTextsDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  readonly accountName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  readonly accountNameAr?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  readonly instructions!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly instructionsAr?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(1000)
  readonly referenceInstructions!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  readonly referenceInstructionsAr?: string;
}

/** The wallet providers Atlas names; `other` takes the provider's name. */
export const WALLET_PROVIDERS = [
  'vodafone_cash',
  'orange_cash',
  'etisalat_cash',
  'we_pay',
  'other',
] as const;
export type WalletProvider = (typeof WALLET_PROVIDERS)[number];

export class WalletTransferInstructionsDto extends ManualMethodTextsDto {
  @IsIn(WALLET_PROVIDERS)
  readonly walletProvider!: WalletProvider;

  /** Required for `other`: the provider's name as customers know it. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  readonly walletProviderName?: string;

  /** An Egyptian mobile wallet number: 01[0,1,2,5] + 8 digits; `+20`, spaces allowed. */
  @IsString()
  @Matches(/^(\+?20|0)?\s*1[0125](\s*\d){8}$/, {
    message: 'validation:invalidWalletNumber',
  })
  readonly walletNumber!: string;
}

export class InstapayInstructionsDto extends ManualMethodTextsDto {
  /** An InstaPay payment address: `name@instapay`. */
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{2,64}@instapay$/i, {
    message: 'validation:invalidInstapayAddress',
  })
  readonly instapayAddress!: string;
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

export class CreatePlatformWalletMethodDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  readonly displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  readonly description?: string;

  @ValidateNested()
  @Type(() => WalletTransferInstructionsDto)
  readonly instructions!: WalletTransferInstructionsDto;

  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  readonly displayOrder?: number;
}

export class CreatePlatformInstapayMethodDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  readonly displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  readonly description?: string;

  @ValidateNested()
  @Type(() => InstapayInstructionsDto)
  readonly instructions!: InstapayInstructionsDto;

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

  /** New details for a bank-transfer method. */
  @IsOptional()
  @ValidateNested()
  @Type(() => BankTransferInstructionsDto)
  readonly instructions?: BankTransferInstructionsDto;

  /** New details for a wallet method. */
  @IsOptional()
  @ValidateNested()
  @Type(() => WalletTransferInstructionsDto)
  readonly walletInstructions?: WalletTransferInstructionsDto;

  /** New details for an InstaPay method. */
  @IsOptional()
  @ValidateNested()
  @Type(() => InstapayInstructionsDto)
  readonly instapayInstructions?: InstapayInstructionsDto;

  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  readonly displayOrder?: number;
}
