/**
 * Academy Manual Payments — `PUT academies/:id/payment-methods/<type>`.
 *
 * One endpoint per method type, so each body is validated against its own
 * typed details: a bank account for a bank transfer, an InstaPay address for
 * InstaPay, a wallet for a wallet. The detail DTOs are the platform
 * catalog's own (`platform-payment-method.dto.ts`) — one set of format
 * rules for every manual method Atlas shows a payer.
 *
 * `instructions` may be omitted to switch an EXISTING method on or off
 * without re-sending its details; creating a method requires them.
 */
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import {
  BankTransferInstructionsDto,
  InstapayInstructionsDto,
  WalletTransferInstructionsDto,
} from '../../billing/dto/platform-payment-method.dto';

export class SaveAcademyBankTransferMethodDto {
  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => BankTransferInstructionsDto)
  readonly instructions?: BankTransferInstructionsDto;
}

export class SaveAcademyInstapayMethodDto {
  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => InstapayInstructionsDto)
  readonly instructions?: InstapayInstructionsDto;
}

export class SaveAcademyWalletMethodDto {
  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => WalletTransferInstructionsDto)
  readonly instructions?: WalletTransferInstructionsDto;
}
