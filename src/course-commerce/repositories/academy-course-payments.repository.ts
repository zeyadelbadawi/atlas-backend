/**
 * AcademyCoursePaymentsRepository — the Client Owner's read of ONE
 * academy's `academy_manual` course payments (Academy Manual Payments).
 *
 * Runs in the organization's tenant context: `payments_tenant_course_order_select`
 * admits the organization's course payments, and every query here also
 * filters by `payeeAcademyId` and `provider = 'academy_manual'` — RLS is never
 * the only check, a sibling academy's payments must not appear, and
 * Atlas-collected payments are reviewed by the Platform Owner, not here.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ACADEMY_MANUAL_PROVIDER_KEY } from '../../billing/dto/billing.constants';
import { escapeLikePattern } from './academy-course-orders.repository';
import { toCreatedAtRange } from '../dto/academy-course-order-query.dto';
import type { AcademyCoursePaymentQueryDto } from '../dto/academy-course-payment-query.dto';
import {
  ACADEMY_COURSE_PAYMENT_DETAIL_SELECT,
  ACADEMY_COURSE_PAYMENT_SELECT,
  type AcademyCoursePaymentDetailRow,
  type AcademyCoursePaymentRow,
} from '../dto/academy-course-payment.contract';

const REVIEWABLE: Prisma.EnumManualReviewStatusFilter = {
  in: ['pending', 'approved', 'rejected'],
};

export type AcademyCoursePaymentFilter = Pick<
  AcademyCoursePaymentQueryDto,
  'reviewStatus' | 'methodType' | 'from' | 'to' | 'search' | 'sortBy' | 'sortDirection'
>;

function baseWhere(academyId: string): Prisma.PaymentWhereInput {
  return {
    payeeAcademyId: academyId,
    provider: ACADEMY_MANUAL_PROVIDER_KEY,
    courseOrderId: { not: null },
  };
}

export function buildAcademyCoursePaymentWhere(
  academyId: string,
  filter: AcademyCoursePaymentFilter,
): Prisma.PaymentWhereInput {
  const search = filter.search?.trim();
  const pattern = search ? escapeLikePattern(search) : undefined;
  const createdAt = toCreatedAtRange(filter.from, filter.to);
  return {
    ...baseWhere(academyId),
    reviewStatus: filter.reviewStatus ?? REVIEWABLE,
    ...(filter.methodType ? { methodType: filter.methodType } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(search
      ? {
          OR: [
            { id: search },
            { courseOrderId: search },
            {
              courseOrder: {
                is: {
                  course: { title: { contains: pattern, mode: 'insensitive' as const } },
                },
              },
            },
            {
              payer: {
                is: { name: { contains: pattern, mode: 'insensitive' as const } },
              },
            },
            // Exact address only — responses mask the email (see the Orders list).
            // `equals` + `mode: 'insensitive'` compiles to ILIKE, so it takes the
            // ESCAPED pattern: the raw text would let `%` and `_` act as wildcards.
            {
              payer: { is: { email: { equals: pattern, mode: 'insensitive' as const } } },
            },
            {
              proofs: {
                some: {
                  payerReference: { contains: pattern, mode: 'insensitive' as const },
                },
              },
            },
          ],
        }
      : {}),
  };
}

@Injectable()
export class AcademyCoursePaymentsRepository {
  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: AcademyCoursePaymentFilter & { readonly skip: number; readonly take: number },
  ): Promise<{ items: AcademyCoursePaymentRow[]; totalItems: number }> {
    const where = buildAcademyCoursePaymentWhere(academyId, filter);
    const direction = filter.sortDirection ?? 'desc';
    const orderBy: Prisma.PaymentOrderByWithRelationInput[] =
      filter.sortBy === 'amount'
        ? [{ amountMinorUnits: direction }, { id: direction }]
        : [{ createdAt: direction }, { id: direction }];
    const [items, totalItems] = await Promise.all([
      tx.payment.findMany({
        where,
        select: ACADEMY_COURSE_PAYMENT_SELECT,
        orderBy,
        skip: filter.skip,
        take: filter.take,
      }),
      tx.payment.count({ where }),
    ]);
    return { items, totalItems };
  }

  async countByReviewStatus(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<{ pending: number; approved: number; rejected: number }> {
    const groups = await tx.payment.groupBy({
      by: ['reviewStatus'],
      where: { ...baseWhere(academyId), reviewStatus: REVIEWABLE },
      _count: { _all: true },
    });
    const count = (status: string) =>
      groups.find((group) => group.reviewStatus === status)?._count._all ?? 0;
    return {
      pending: count('pending'),
      approved: count('approved'),
      rejected: count('rejected'),
    };
  }

  findOneForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    paymentId: string,
  ): Promise<AcademyCoursePaymentDetailRow | null> {
    return tx.payment.findFirst({
      where: { ...baseWhere(academyId), id: paymentId },
      select: ACADEMY_COURSE_PAYMENT_DETAIL_SELECT,
    });
  }
}
