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
  CreatePlatformBankTransferMethodDto,
  CreatePlatformInstapayMethodDto,
  CreatePlatformWalletMethodDto,
  UpdatePlatformPaymentMethodDto,
} from '../dto/platform-payment-method.dto';
import {
  MANUAL_TRANSFER_CAPABILITIES,
  incomplete,
  isPlaceholder,
  toStoredBankTransferInstructions as toStoredInstructions,
  toStoredInstapayInstructions,
  toStoredWalletInstructions,
  trimmed,
  type ManualMethodType,
} from '../utils/manual-payment-instructions.util';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

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
