/**
 * Platform Owner configuration of the manual payment methods (2 Oct 2026):
 * bank transfer, Egyptian mobile wallets and InstaPay.
 *
 * The payment catalog had no write path, so production — which must never
 * run the development seed and its sample bank details — had no method and
 * could not offer Bank Transfer. This is the write path: the Platform Owner
 * enters the real details; type, provider and capabilities are fixed here;
 * every change is audited in the same transaction.
 *
 * A method is never deleted (payments keep their `methodKey`); it is
 * disabled. Existing payments are unaffected by later edits: each payment
 * keeps the instructions it was created with (`payments.instructions_snapshot`).
 *
 * Placeholders: the wallet and InstaPay rows the 20261102000400 migration
 * inserts carry `placeholder: true` and destinations that are not real.
 * One cannot be enabled in production until real details replace the
 * placeholder (any instructions saved here are real ones), and
 * `PaymentService` refuses to take a payment against one there either.
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PaymentMethodsRepository } from '../repositories/payment-methods.repository';
import {
  toPlatformPaymentMethodResponse,
  type PlatformPaymentMethodResponse,
} from '../dto/payment-method.contract';
import type {
  BankTransferInstructionsDto,
  CreatePlatformBankTransferMethodDto,
  CreatePlatformInstapayMethodDto,
  CreatePlatformWalletMethodDto,
  InstapayInstructionsDto,
  UpdatePlatformPaymentMethodDto,
  WalletTransferInstructionsDto,
} from '../dto/platform-payment-method.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/** What a manual transfer (bank, wallet, InstaPay) can do — fixed by the server, never sent by a client. */
const MANUAL_TRANSFER_CAPABILITIES = {
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

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

type ManualMethodType =
  'manual_bank_transfer' | 'manual_wallet_transfer' | 'manual_instapay';

function incomplete(): BadRequestException {
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
function toStoredInstructions(input: BankTransferInstructionsDto): Prisma.InputJsonValue {
  const bankName = trimmed(input.bankName);
  const accountNumber = trimmed(input.accountNumber);
  if (!bankName || !accountNumber) throw incomplete();
  const texts = storedTexts(input);
  const iban = trimmed(input.iban)?.replace(/\s+/g, '').toUpperCase();
  const swiftCode = trimmed(input.swiftCode)?.toUpperCase();
  return {
    type: 'manual_bank_transfer',
    bankName,
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

function toStoredWalletInstructions(
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

function toStoredInstapayInstructions(
  input: InstapayInstructionsDto,
): Prisma.InputJsonValue {
  return {
    type: 'manual_instapay',
    instapayAddress: input.instapayAddress.trim().toLowerCase(),
    ...storedTexts(input),
  };
}

function isPlaceholder(instructions: unknown): boolean {
  return (
    !!instructions &&
    typeof instructions === 'object' &&
    (instructions as { placeholder?: unknown }).placeholder === true
  );
}

@Injectable()
export class PlatformPaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly configService: ConfigService,
  ) {}

  private get isProduction(): boolean {
    return this.configService.getOrThrow<AppConfig>('app').isProduction;
  }

  async list(
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformPaymentMethodResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, totalItems } = await this.paymentMethodsRepository.findManyPaginated(
      (page - 1) * pageSize,
      pageSize,
    );
    return {
      items: items.map(toPlatformPaymentMethodResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  createBankTransfer(
    platformOwnerUserId: string,
    payload: CreatePlatformBankTransferMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    return this.createMethod(platformOwnerUserId, payload, {
      type: 'manual_bank_transfer',
      keyPrefix: 'bank_transfer',
      manualInstructions: toStoredInstructions(payload.instructions),
    });
  }

  createWallet(
    platformOwnerUserId: string,
    payload: CreatePlatformWalletMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    return this.createMethod(platformOwnerUserId, payload, {
      type: 'manual_wallet_transfer',
      keyPrefix: 'wallet',
      manualInstructions: toStoredWalletInstructions(payload.instructions),
    });
  }

  createInstapay(
    platformOwnerUserId: string,
    payload: CreatePlatformInstapayMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    return this.createMethod(platformOwnerUserId, payload, {
      type: 'manual_instapay',
      keyPrefix: 'instapay',
      manualInstructions: toStoredInstapayInstructions(payload.instructions),
    });
  }

  private async createMethod(
    platformOwnerUserId: string,
    payload: {
      readonly displayName: string;
      readonly description?: string;
      readonly enabled?: boolean;
      readonly displayOrder?: number;
    },
    method: {
      readonly type: ManualMethodType;
      readonly keyPrefix: string;
      readonly manualInstructions: Prisma.InputJsonValue;
    },
  ): Promise<PlatformPaymentMethodResponse> {
    const displayName = trimmed(payload.displayName);
    if (!displayName) throw incomplete();
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await this.paymentMethodsRepository.create(tx, {
        key: `${method.keyPrefix}_${randomUUID().slice(0, 8)}`,
        type: method.type,
        provider: 'atlas_manual',
        displayName,
        description: trimmed(payload.description) ?? null,
        enabled: payload.enabled ?? false,
        displayOrder: payload.displayOrder ?? 0,
        capabilities: MANUAL_TRANSFER_CAPABILITIES,
        manualInstructions: method.manualInstructions,
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerUserId,
        action: 'payment_method.created',
        targetType: 'payment_method',
        targetId: row.id,
        // Which method, never the account details themselves.
        context: { key: row.key, type: row.type, enabled: row.enabled },
      });
      return row;
    });
    return toPlatformPaymentMethodResponse(created);
  }

  async update(
    platformOwnerUserId: string,
    id: string,
    payload: UpdatePlatformPaymentMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    const existing = await this.paymentMethodsRepository.findById(id);
    if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
    // New details must be the method's own kind: a bank account for a bank
    // transfer, a wallet for a wallet, an InstaPay address for InstaPay.
    const given = [
      payload.instructions ? 'manual_bank_transfer' : null,
      payload.walletInstructions ? 'manual_wallet_transfer' : null,
      payload.instapayInstructions ? 'manual_instapay' : null,
    ].filter((type): type is ManualMethodType => type !== null);
    if (given.length > 1 || (given.length === 1 && given[0] !== existing.type)) {
      throw new BadRequestException({
        messageKey:
          existing.type === 'manual_bank_transfer' || !payload.instructions
            ? 'errors.paymentMethod.instructionsTypeMismatch'
            : 'errors.paymentMethod.notBankTransfer',
      });
    }
    if (payload.displayName !== undefined && !trimmed(payload.displayName))
      throw incomplete();
    const nextInstructions = payload.instructions
      ? toStoredInstructions(payload.instructions)
      : payload.walletInstructions
        ? toStoredWalletInstructions(payload.walletInstructions)
        : payload.instapayInstructions
          ? toStoredInstapayInstructions(payload.instapayInstructions)
          : undefined;
    // Enabling a manual method requires complete stored instructions…
    const isManual = existing.type !== 'gateway';
    if (
      payload.enabled === true &&
      isManual &&
      !nextInstructions &&
      !existing.manualInstructions
    ) {
      throw incomplete();
    }
    // …and, in production, real ones: a placeholder is never offered to
    // customers there. New details saved here are never a placeholder.
    if (
      payload.enabled === true &&
      this.isProduction &&
      !nextInstructions &&
      isPlaceholder(existing.manualInstructions)
    ) {
      throw new ConflictException({
        messageKey: 'errors.paymentMethod.placeholderDetails',
      });
    }

    const data: Prisma.PaymentMethodUpdateInput = {
      ...(payload.displayName !== undefined
        ? { displayName: trimmed(payload.displayName) }
        : {}),
      ...(payload.description !== undefined
        ? { description: trimmed(payload.description) ?? null }
        : {}),
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
      ...(payload.displayOrder !== undefined
        ? { displayOrder: payload.displayOrder }
        : {}),
      ...(nextInstructions ? { manualInstructions: nextInstructions } : {}),
    };
    const method = await this.prisma.$transaction(async (tx) => {
      const updated = await this.paymentMethodsRepository.update(tx, id, data);
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerUserId,
        action: 'payment_method.updated',
        targetType: 'payment_method',
        targetId: id,
        context: { fields: Object.keys(data).join(','), enabled: updated.enabled },
      });
      return updated;
    });
    return toPlatformPaymentMethodResponse(method);
  }
}
