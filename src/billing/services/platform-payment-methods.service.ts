/**
 * Platform Owner configuration of manual bank-transfer methods (2 Oct 2026).
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
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  UpdatePlatformPaymentMethodDto,
} from '../dto/platform-payment-method.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/** What a manual bank transfer can do — fixed by the server, never sent by a client. */
const BANK_TRANSFER_CAPABILITIES = {
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

/** The stored instructions: trimmed, optional fields omitted when blank. */
function toStoredInstructions(input: BankTransferInstructionsDto): Prisma.InputJsonValue {
  const bankName = trimmed(input.bankName);
  const accountName = trimmed(input.accountName);
  const accountNumber = trimmed(input.accountNumber);
  const instructions = trimmed(input.instructions);
  const referenceInstructions = trimmed(input.referenceInstructions);
  if (
    !bankName ||
    !accountName ||
    !accountNumber ||
    !instructions ||
    !referenceInstructions
  ) {
    // Whitespace-only values pass `@IsNotEmpty`; they are not real details.
    throw new BadRequestException({
      messageKey: 'errors.paymentMethod.incompleteInstructions',
    });
  }
  const iban = trimmed(input.iban)?.replace(/\s+/g, '').toUpperCase();
  const swiftCode = trimmed(input.swiftCode)?.toUpperCase();
  return {
    type: 'manual_bank_transfer',
    bankName,
    accountName,
    accountNumber,
    ...(iban ? { iban } : {}),
    ...(swiftCode ? { swiftCode } : {}),
    instructions,
    referenceInstructions,
  };
}

@Injectable()
export class PlatformPaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

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

  async createBankTransfer(
    platformOwnerUserId: string,
    payload: CreatePlatformBankTransferMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    const displayName = trimmed(payload.displayName);
    if (!displayName) {
      throw new BadRequestException({
        messageKey: 'errors.paymentMethod.incompleteInstructions',
      });
    }
    const manualInstructions = toStoredInstructions(payload.instructions);
    const method = await this.prisma.$transaction(async (tx) => {
      const created = await this.paymentMethodsRepository.create(tx, {
        key: `bank_transfer_${randomUUID().slice(0, 8)}`,
        type: 'manual_bank_transfer',
        provider: 'atlas_manual',
        displayName,
        description: trimmed(payload.description) ?? null,
        enabled: payload.enabled ?? false,
        displayOrder: payload.displayOrder ?? 0,
        capabilities: BANK_TRANSFER_CAPABILITIES,
        manualInstructions,
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerUserId,
        action: 'payment_method.created',
        targetType: 'payment_method',
        targetId: created.id,
        // Which fields were set, never the account details themselves.
        context: { key: created.key, type: created.type, enabled: created.enabled },
      });
      return created;
    });
    return toPlatformPaymentMethodResponse(method);
  }

  async update(
    platformOwnerUserId: string,
    id: string,
    payload: UpdatePlatformPaymentMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    const existing = await this.paymentMethodsRepository.findById(id);
    if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
    if (payload.instructions && existing.type !== 'manual_bank_transfer') {
      throw new BadRequestException({
        messageKey: 'errors.paymentMethod.notBankTransfer',
      });
    }
    if (payload.displayName !== undefined && !trimmed(payload.displayName)) {
      throw new BadRequestException({
        messageKey: 'errors.paymentMethod.incompleteInstructions',
      });
    }
    // Enabling a bank transfer requires complete stored instructions.
    const nextInstructions = payload.instructions
      ? toStoredInstructions(payload.instructions)
      : undefined;
    if (
      payload.enabled === true &&
      existing.type === 'manual_bank_transfer' &&
      !nextInstructions &&
      !existing.manualInstructions
    ) {
      throw new BadRequestException({
        messageKey: 'errors.paymentMethod.incompleteInstructions',
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
