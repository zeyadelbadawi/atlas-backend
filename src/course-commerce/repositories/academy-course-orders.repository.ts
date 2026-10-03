/**
 * AcademyCourseOrdersRepository — the Organization Owner's read of ONE
 * academy's course orders (Academy Orders). Read-only by construction: it
 * has no write method, and the RLS policies that make these rows visible to
 * a tenant context are SELECT-only (migration
 * `20261103000000_tenant_course_order_read_rls`).
 *
 * Every query takes the `academyId` in its `where` clause even though the
 * tenant context already limits rows to the caller's organization — RLS is
 * never the only check, and a sibling academy's orders in the same
 * organization must not appear here.
 *
 * Selects only the columns `toAcademyCourseOrderResponse` reads: no
 * `idempotency_key`, no payment instructions, proofs or commission.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AcademyCourseOrderRow } from '../dto/academy-course-order.contract';
import type { AcademyCourseOrderQueryDto } from '../dto/academy-course-order-query.dto';
import { toCreatedAtRange } from '../dto/academy-course-order-query.dto';

const PAYMENT_SUMMARY_SELECT = {
  id: true,
  status: true,
  reviewStatus: true,
  methodType: true,
  providerReference: true,
  amountMinorUnits: true,
  currency: true,
  createdAt: true,
} satisfies Prisma.PaymentSelect;

function orderSelect(paymentsTake?: number) {
  return {
    id: true,
    status: true,
    snapshot: true,
    courseId: true,
    createdAt: true,
    paidAt: true,
    expiresAt: true,
    course: { select: { title: true } },
    student: { select: { name: true, email: true } },
    payments: {
      select: PAYMENT_SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
      ...(paymentsTake ? { take: paymentsTake } : {}),
    },
    refund: {
      select: {
        status: true,
        amountMinorUnits: true,
        currency: true,
        requestedAt: true,
        processedAt: true,
      },
    },
    _count: { select: { payments: true } },
  } satisfies Prisma.CourseOrderSelect;
}

export type AcademyCourseOrderFilter = Pick<
  AcademyCourseOrderQueryDto,
  | 'status'
  | 'paymentStatus'
  | 'reviewStatus'
  | 'methodType'
  | 'refundStatus'
  | 'courseId'
  | 'from'
  | 'to'
  | 'search'
  | 'sortBy'
  | 'sortDirection'
>;

export function buildAcademyCourseOrderWhere(
  academyId: string,
  filter: AcademyCourseOrderFilter,
): Prisma.CourseOrderWhereInput {
  const search = filter.search?.trim();
  const createdAt = toCreatedAtRange(filter.from, filter.to);
  const paymentMatch: Prisma.PaymentWhereInput = {
    ...(filter.paymentStatus ? { status: filter.paymentStatus } : {}),
    ...(filter.reviewStatus ? { reviewStatus: filter.reviewStatus } : {}),
    ...(filter.methodType ? { methodType: filter.methodType } : {}),
  };

  return {
    academyId,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.courseId ? { courseId: filter.courseId } : {}),
    ...(createdAt ? { createdAt } : {}),
    // One `some` holding every payment condition, so all of them must hold
    // for the SAME payment attempt.
    ...(Object.keys(paymentMatch).length > 0 ? { payments: { some: paymentMatch } } : {}),
    ...(filter.refundStatus === 'none'
      ? { refund: { is: null } }
      : filter.refundStatus
        ? { refund: { is: { status: filter.refundStatus } } }
        : {}),
    ...(search
      ? {
          OR: [
            { id: search },
            { course: { title: { contains: search, mode: 'insensitive' as const } } },
            { student: { name: { contains: search, mode: 'insensitive' as const } } },
            { student: { email: { contains: search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
}

@Injectable()
export class AcademyCourseOrdersRepository {
  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: AcademyCourseOrderFilter & { readonly skip: number; readonly take: number },
  ): Promise<{ items: AcademyCourseOrderRow[]; totalItems: number }> {
    const where = buildAcademyCourseOrderWhere(academyId, filter);
    const direction = filter.sortDirection ?? 'desc';
    const select = orderSelect(1);

    if (filter.sortBy === 'amount') {
      return this.findManyByAmount(tx, where, direction, filter.skip, filter.take);
    }

    const orderBy: Prisma.CourseOrderOrderByWithRelationInput[] =
      filter.sortBy === 'paidAt'
        ? [{ paidAt: { sort: direction, nulls: 'last' } }, { id: direction }]
        : [{ createdAt: direction }, { id: direction }];

    const [items, totalItems] = await Promise.all([
      tx.courseOrder.findMany({
        where,
        select,
        orderBy,
        skip: filter.skip,
        take: filter.take,
      }),
      tx.courseOrder.count({ where }),
    ]);
    return { items, totalItems };
  }

  findOneForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    orderId: string,
  ): Promise<AcademyCourseOrderRow | null> {
    return tx.courseOrder.findFirst({
      where: { id: orderId, academyId },
      select: orderSelect(),
    });
  }

  /**
   * The order's price lives in its frozen JSON snapshot, which Prisma cannot
   * order by. The filtered id set comes from the same Prisma `where` (so
   * filters and RLS behave identically to the other sorts), and one raw
   * query orders and pages it; the page is then loaded with the normal
   * select and put back in that order.
   */
  private async findManyByAmount(
    tx: Prisma.TransactionClient,
    where: Prisma.CourseOrderWhereInput,
    direction: 'asc' | 'desc',
    skip: number,
    take: number,
  ): Promise<{ items: AcademyCourseOrderRow[]; totalItems: number }> {
    const matching = await tx.courseOrder.findMany({ where, select: { id: true } });
    const totalItems = matching.length;
    if (totalItems === 0) return { items: [], totalItems };

    const ids = matching.map((row) => row.id);
    const sortSql = direction === 'asc' ? Prisma.raw('ASC') : Prisma.raw('DESC');
    const page = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "course_orders"
      WHERE "id" = ANY(${ids}::text[])
      ORDER BY COALESCE(("snapshot"->'price'->>'amountMinorUnits')::numeric, 0) ${sortSql},
               "created_at" DESC, "id" ASC
      OFFSET ${skip} LIMIT ${take}
    `;
    if (page.length === 0) return { items: [], totalItems };

    const pageIds = page.map((row) => row.id);
    const rows = await tx.courseOrder.findMany({
      where: { id: { in: pageIds } },
      select: orderSelect(1),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined);
    return { items, totalItems };
  }
}
