/**
 * Academy Manual Payments — the manual methods an owner chose in the
 * academy setup form, carried by the provisioning request
 * (`provisioning_requests.requested_payment_methods`) and saved to
 * `academy_payment_methods` by the `academy` step once the Academy exists
 * (an academy row is what a method belongs to, so they cannot be saved
 * earlier).
 *
 * Validation happens at create, synchronously: each given method is a typed
 * DTO (`CreateProvisioningRequestDto.paymentMethods`, the same detail DTOs as
 * the settings page and the platform catalog) and is normalised here by the
 * shared rules, so a whitespace-only value is a 400 before the request
 * exists. A method given here is saved ENABLED; "set up later" sends none.
 */
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import type { Prisma } from '@prisma/client';
import {
  BankTransferInstructionsDto,
  InstapayInstructionsDto,
  WalletTransferInstructionsDto,
} from '../../billing/dto/platform-payment-method.dto';
import {
  toStoredBankTransferInstructions,
  toStoredInstapayInstructions,
  toStoredWalletInstructions,
  type ManualMethodType,
} from '../../billing/utils/manual-payment-instructions.util';

export class RequestedPaymentMethodsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => BankTransferInstructionsDto)
  readonly bankTransfer?: BankTransferInstructionsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => InstapayInstructionsDto)
  readonly instapay?: InstapayInstructionsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WalletTransferInstructionsDto)
  readonly wallet?: WalletTransferInstructionsDto;
}

/** What is stored: the normalised instructions per method type. */
export type RequestedPaymentMethods = Partial<
  Record<ManualMethodType, Prisma.InputJsonObject>
>;

/** Normalises the create payload's methods; `null` when none was chosen. Throws 400 on blank details. */
export function parseRequestedPaymentMethods(
  raw: RequestedPaymentMethodsDto | undefined,
): RequestedPaymentMethods | null {
  if (!raw) return null;
  const stored: RequestedPaymentMethods = {
    ...(raw.bankTransfer
      ? {
          manual_bank_transfer: toStoredBankTransferInstructions(
            raw.bankTransfer,
          ) as Prisma.InputJsonObject,
        }
      : {}),
    ...(raw.instapay
      ? {
          manual_instapay: toStoredInstapayInstructions(
            raw.instapay,
          ) as Prisma.InputJsonObject,
        }
      : {}),
    ...(raw.wallet
      ? {
          manual_wallet_transfer: toStoredWalletInstructions(
            raw.wallet,
          ) as Prisma.InputJsonObject,
        }
      : {}),
  };
  return Object.keys(stored).length > 0 ? stored : null;
}

const STORED_TYPES: readonly ManualMethodType[] = [
  'manual_bank_transfer',
  'manual_instapay',
  'manual_wallet_transfer',
];

/** Reads the stored column back; anything unexpected is ignored, never trusted. */
export function readRequestedPaymentMethods(value: unknown): RequestedPaymentMethods {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: RequestedPaymentMethods = {};
  for (const type of STORED_TYPES) {
    const instructions = (value as Record<string, unknown>)[type];
    if (
      instructions &&
      typeof instructions === 'object' &&
      !Array.isArray(instructions) &&
      (instructions as { type?: unknown }).type === type
    ) {
      result[type] = instructions as Prisma.InputJsonObject;
    }
  }
  return result;
}
