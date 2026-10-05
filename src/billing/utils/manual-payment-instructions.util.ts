/**
 * Manual payment instructions — the ONE normalisation of the bank-transfer,
 * mobile-wallet and InstaPay details a payer is shown.
 *
 * Shared by the Platform Owner's catalog (`PlatformPaymentMethodsService`,
 * Atlas's own accounts) and the academies' own methods
 * (`AcademyPaymentMethodsService`), so both store exactly the same shape
 * (`ManualPaymentInstructionsResponse`) under exactly the same rules:
 * trimmed values, whitespace-only details refused, IBAN/SWIFT upper-cased,
 * wallet numbers normalised to the national form, InstaPay addresses
 * lower-cased, Arabic texts kept only when given. The DTOs
 * (`platform-payment-method.dto.ts`) carry the format checks.
 */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  BankTransferInstructionsDto,
  InstapayInstructionsDto,
  WalletTransferInstructionsDto,
} from '../dto/platform-payment-method.dto';

/** What a manual transfer (bank, wallet, InstaPay) can do — fixed by the server, never sent by a client. */
export const MANUAL_TRANSFER_CAPABILITIES = {
  supportsManualReview: true,
  supportsProof: true,
  supportsRedirect: false,
  supportsEmbeddedCheckout: false,
  supportsAdditionalAuthentication: false,
  supportsWebhooks: false,
  supportsRefunds: false,
  supportsRecurring: false,
  supportsCancellation: true,
} as const;

export function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export type ManualMethodType =
  'manual_bank_transfer' | 'manual_wallet_transfer' | 'manual_instapay';

export function incomplete(): BadRequestException {
  // Whitespace-only values pass `@IsNotEmpty`; they are not real details.
  return new BadRequestException({
    messageKey: 'errors.paymentMethod.incompleteInstructions',
  });
}

/** The holder and texts every manual method has, trimmed; Arabic ones only when given. */
function storedTexts(input: {
  accountName: string;
  accountNameAr?: string;
  instructions: string;
  instructionsAr?: string;
  referenceInstructions: string;
  referenceInstructionsAr?: string;
}): Record<string, string> {
  const accountName = trimmed(input.accountName);
  const instructions = trimmed(input.instructions);
  const referenceInstructions = trimmed(input.referenceInstructions);
  if (!accountName || !instructions || !referenceInstructions) throw incomplete();
  const optional = {
    accountNameAr: trimmed(input.accountNameAr),
    instructionsAr: trimmed(input.instructionsAr),
    referenceInstructionsAr: trimmed(input.referenceInstructionsAr),
  };
  return {
    accountName,
    instructions,
    referenceInstructions,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v)),
  } as Record<string, string>;
}

/** The stored bank-transfer instructions: trimmed, optional fields omitted when blank. */
export function toStoredBankTransferInstructions(
  input: BankTransferInstructionsDto,
): Prisma.InputJsonValue {
  const bankName = trimmed(input.bankName);
  const accountNumber = trimmed(input.accountNumber);
  if (!bankName || !accountNumber) throw incomplete();
  const texts = storedTexts(input);
  const iban = trimmed(input.iban)?.replace(/\s+/g, '').toUpperCase();
  const swiftCode = trimmed(input.swiftCode)?.toUpperCase();
  const branchName = trimmed(input.branchName);
  return {
    type: 'manual_bank_transfer',
    bankName,
    ...(branchName ? { branchName } : {}),
    accountName: texts.accountName,
    accountNumber,
    ...(iban ? { iban } : {}),
    ...(swiftCode ? { swiftCode } : {}),
    ...texts,
  };
}

/** `+20 10 1234 5678`, `2010…`, `010 1234 5678` → `01012345678`. */
export function normalizeWalletNumber(raw: string): string {
  const digits = raw.replace(/\s+/g, '').replace(/^\+/, '');
  const national = digits.startsWith('20') ? digits.slice(2) : digits;
  return national.startsWith('0') ? national : `0${national}`;
}

export function toStoredWalletInstructions(
  input: WalletTransferInstructionsDto,
): Prisma.InputJsonValue {
  const walletProviderName = trimmed(input.walletProviderName);
  if (input.walletProvider === 'other' && !walletProviderName) {
    throw new BadRequestException({
      messageKey: 'errors.paymentMethod.walletProviderNameRequired',
    });
  }
  return {
    type: 'manual_wallet_transfer',
    walletProvider: input.walletProvider,
    ...(input.walletProvider === 'other' ? { walletProviderName } : {}),
    walletNumber: normalizeWalletNumber(input.walletNumber),
    ...storedTexts(input),
  };
}

export function toStoredInstapayInstructions(
  input: InstapayInstructionsDto,
): Prisma.InputJsonValue {
  return {
    type: 'manual_instapay',
    instapayAddress: input.instapayAddress.trim().toLowerCase(),
    ...storedTexts(input),
  };
}

export function isPlaceholder(instructions: unknown): boolean {
  return (
    !!instructions &&
    typeof instructions === 'object' &&
    (instructions as { placeholder?: unknown }).placeholder === true
  );
}
