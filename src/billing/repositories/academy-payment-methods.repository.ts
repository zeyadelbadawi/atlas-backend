/**
 * AcademyPaymentMethodsRepository — `academy_payment_methods`, one academy's
 * own manual methods (Academy Manual Payments). Every method takes the
 * caller's `Prisma.TransactionClient`:
 *
 *   - tenant context (`app.current_organization_id`) reads and writes the
 *     organization's rows (`academy_payment_methods_tenant_*`);
 *   - any signed-in user context reads ENABLED rows only
 *     (`academy_payment_methods_buyer_select`) — the learner's checkout.
 *
 * Every query also filters by `academyId` explicitly: RLS is never the only
 * check. There is no delete — a method is disabled, never removed.
 */
import { Injectable } from '@nestjs/common';
import type { AcademyPaymentMethod, PaymentMethodType, Prisma } from '@prisma/client';

const ORDER_BY: Prisma.AcademyPaymentMethodOrderByWithRelationInput[] = [
  { displayOrder: 'asc' },
  { type: 'asc' },
];

@Injectable()
export class AcademyPaymentMethodsRepository {
  findAllForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<AcademyPaymentMethod[]> {
    return tx.academyPaymentMethod.findMany({ where: { academyId }, orderBy: ORDER_BY });
  }

  findEnabledForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<AcademyPaymentMethod[]> {
    return tx.academyPaymentMethod.findMany({
      where: { academyId, enabled: true },
      orderBy: ORDER_BY,
    });
  }

  async hasEnabledForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<boolean> {
    const count = await tx.academyPaymentMethod.count({
      where: { academyId, enabled: true },
    });
    return count > 0;
  }

  findByAcademyAndType(
    tx: Prisma.TransactionClient,
    academyId: string,
    type: PaymentMethodType,
  ): Promise<AcademyPaymentMethod | null> {
    return tx.academyPaymentMethod.findUnique({
      where: { academyId_type: { academyId, type } },
    });
  }

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<AcademyPaymentMethod | null> {
    return tx.academyPaymentMethod.findUnique({ where: { id } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AcademyPaymentMethodUncheckedCreateInput,
  ): Promise<AcademyPaymentMethod> {
    return tx.academyPaymentMethod.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AcademyPaymentMethodUncheckedUpdateInput,
  ): Promise<AcademyPaymentMethod> {
    return tx.academyPaymentMethod.update({ where: { id }, data });
  }

  /**
   * Inserts each method whose type the academy does not have yet and leaves
   * existing rows untouched — the provisioning step's write, safe to repeat
   * on a retried step and never overwriting what the owner saved since.
   */
  async insertMissing(
    tx: Prisma.TransactionClient,
    rows: readonly Prisma.AcademyPaymentMethodCreateManyInput[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.academyPaymentMethod.createMany({
      data: [...rows],
      skipDuplicates: true,
    });
    return result.count;
  }
}
