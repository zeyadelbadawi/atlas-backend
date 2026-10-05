/**
 * AcademyPaymentMethodsService — `academies/:id/payment-methods*`, the
 * Client Owner's configuration of the manual methods ONE academy accepts
 * (Academy Manual Payments): bank transfer, InstaPay and mobile wallet,
 * with the details a learner is shown at checkout.
 *
 * Authorization is the academy-finance rule (`assertCanViewAcademyFinance`:
 * the Organization Owner only — a manager, instructor or academy member is
 * refused), the same gate as the academy's orders, revenue and payouts:
 * where an academy's money goes is the owner's decision. Writes run in the
 * organization's tenant context, where `academy_payment_methods_tenant_*`
 * admit exactly this organization's rows and refuse an academy of another
 * organization; `AcademyScopeGuard` has already checked the academy id.
 *
 * Details are normalised by the same rules as the platform catalog
 * (`manual-payment-instructions.util.ts`). A method is never deleted —
 * disabling it hides it from checkout, and every payment keeps the
 * instructions it was created with. Every save is audited in the same
 * transaction, without the account details themselves.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AcademyContext } from '../../academy/guards/academy-scope.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AcademyPaymentMethodsRepository } from '../../billing/repositories/academy-payment-methods.repository';
import {
  incomplete,
  toStoredBankTransferInstructions,
  toStoredInstapayInstructions,
  toStoredWalletInstructions,
  type ManualMethodType,
} from '../../billing/utils/manual-payment-instructions.util';
import { assertCanViewAcademyFinance } from './academy-payouts.service';
import {
  toAcademyPaymentMethodResponse,
  type AcademyPaymentMethodResponse,
} from '../dto/academy-payment-method.contract';
import type {
  SaveAcademyBankTransferMethodDto,
  SaveAcademyInstapayMethodDto,
  SaveAcademyWalletMethodDto,
} from '../dto/academy-payment-method.dto';

/** Checkout order: bank transfer, then InstaPay, then wallet. */
const DISPLAY_ORDER: Record<ManualMethodType, number> = {
  manual_bank_transfer: 0,
  manual_instapay: 1,
  manual_wallet_transfer: 2,
};

@Injectable()
export class AcademyPaymentMethodsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyPaymentMethodsRepository: AcademyPaymentMethodsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async list(
    context: AcademyContext,
    academyId: string,
  ): Promise<AcademyPaymentMethodResponse[]> {
    const organizationId = assertCanViewAcademyFinance(context);
    const rows = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.academyPaymentMethodsRepository.findAllForAcademy(tx, academyId),
    );
    return rows.map(toAcademyPaymentMethodResponse);
  }

  saveBankTransfer(
    context: AcademyContext,
    userId: string,
    academyId: string,
    payload: SaveAcademyBankTransferMethodDto,
  ): Promise<AcademyPaymentMethodResponse> {
    return this.save(context, userId, academyId, 'manual_bank_transfer', {
      enabled: payload.enabled,
      instructions: payload.instructions
        ? toStoredBankTransferInstructions(payload.instructions)
        : undefined,
    });
  }

  saveInstapay(
    context: AcademyContext,
    userId: string,
    academyId: string,
    payload: SaveAcademyInstapayMethodDto,
  ): Promise<AcademyPaymentMethodResponse> {
    return this.save(context, userId, academyId, 'manual_instapay', {
      enabled: payload.enabled,
      instructions: payload.instructions
        ? toStoredInstapayInstructions(payload.instructions)
        : undefined,
    });
  }

  saveWallet(
    context: AcademyContext,
    userId: string,
    academyId: string,
    payload: SaveAcademyWalletMethodDto,
  ): Promise<AcademyPaymentMethodResponse> {
    return this.save(context, userId, academyId, 'manual_wallet_transfer', {
      enabled: payload.enabled,
      instructions: payload.instructions
        ? toStoredWalletInstructions(payload.instructions)
        : undefined,
    });
  }

  private async save(
    context: AcademyContext,
    userId: string,
    academyId: string,
    type: ManualMethodType,
    change: {
      readonly enabled?: boolean;
      readonly instructions?: Prisma.InputJsonValue;
    },
  ): Promise<AcademyPaymentMethodResponse> {
    const organizationId = assertCanViewAcademyFinance(context);
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const existing = await this.academyPaymentMethodsRepository.findByAcademyAndType(
        tx,
        academyId,
        type,
      );

      let row;
      let created = false;
      if (!existing) {
        // A method without details cannot exist: there would be nothing to
        // show the learner.
        if (!change.instructions) throw incomplete();
        row = await this.academyPaymentMethodsRepository.create(tx, {
          academyId,
          organizationId,
          type,
          enabled: change.enabled ?? true,
          instructions: change.instructions,
          displayOrder: DISPLAY_ORDER[type],
          updatedByUserId: userId,
        });
        created = true;
      } else {
        if (change.enabled === undefined && change.instructions === undefined) {
          return toAcademyPaymentMethodResponse(existing);
        }
        row = await this.academyPaymentMethodsRepository.update(tx, existing.id, {
          ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
          ...(change.instructions !== undefined
            ? { instructions: change.instructions }
            : {}),
          updatedByUserId: userId,
        });
      }

      const fields = [
        change.enabled !== undefined ? 'enabled' : null,
        change.instructions !== undefined ? 'instructions' : null,
      ].filter((field): field is string => field !== null);
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role: context.academyRole,
        action: 'academy.payment_method.saved',
        targetType: 'academy_payment_method',
        targetId: row.id,
        // Which method and what changed — never the account details.
        context: { type, enabled: row.enabled, created, fields: fields.join(',') },
      });
      return toAcademyPaymentMethodResponse(row);
    });
  }
}
