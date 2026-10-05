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

/**
 * `value` with LIKE's wildcards (`%`, `_`) and its escape character (`\`)
 * escaped. Prisma sends `contains` and an insensitive `equals` to Postgres
 * as `ILIKE` WITHOUT escaping them, so a raw search of `a%@x.test` would
 * turn the "exact address" match into a pattern that confirms which
 * addresses exist. Every search string goes through this first.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function buildAcademyCourseOrderWhere(
  academyId: string,
  filter: AcademyCourseOrderFilter,
): Prisma.CourseOrderWhereInput {
  const search = filter.search?.trim();
  const pattern = search ? escapeLikePattern(search) : undefined;
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
            { course: { title: { contains: pattern, mode: 'insensitive' as const } } },
            { student: { name: { contains: pattern, mode: 'insensitive' as const } } },
            // Exact address only: responses mask the email, and a substring
            // match would let the list confirm it one character at a time.
            // `equals` + `mode: 'insensitive'` compiles to ILIKE, hence the
            // ESCAPED pattern — the raw text would make `%` and `_` wildcards.
            { student: { email: { equals: pattern, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
}

/**
 * `buildAcademyCourseOrderWhere`, clause for clause, as a raw SQL
 * condition over `course_orders o` LEFT JOINed to `courses c`, `users u`
 * and `course_order_refunds r` — the same joins (and therefore the same
 * RLS visibility) Prisma generates for that `where`. Used only by the
 * amount sort, which Prisma cannot express. Every value is a bound
 * parameter; enums are compared as text so no cast can fail.
 *
 * Keep the two in step: `academy-course-orders.e2e-spec.ts` runs the
 * amount sort under each filter against the default sort's result set.
 */
function buildAcademyCourseOrderSqlCondition(
  academyId: string,
  filter: AcademyCourseOrderFilter,
): Prisma.Sql {
  const search = filter.search?.trim();
  const createdAt = toCreatedAtRange(filter.from, filter.to);
  const conditions: Prisma.Sql[] = [Prisma.sql`o."academy_id" = ${academyId}`];

  if (filter.status) conditions.push(Prisma.sql`o."status"::text = ${filter.status}`);
  if (filter.courseId) conditions.push(Prisma.sql`o."course_id" = ${filter.courseId}`);
  // `created_at` is a UTC `timestamp`; a bound Date is a `timestamptz`.
  // Converting the parameter, not the column, keeps the index usable and
  // the result independent of the session time zone.
  if (createdAt?.gte) {
    conditions.push(Prisma.sql`o."created_at" >= (${createdAt.gte} AT TIME ZONE 'UTC')`);
  }
  if (createdAt?.lt) {
    conditions.push(Prisma.sql`o."created_at" < (${createdAt.lt} AT TIME ZONE 'UTC')`);
  }

  const paymentConditions: Prisma.Sql[] = [];
  if (filter.paymentStatus) {
    paymentConditions.push(Prisma.sql`p."status"::text = ${filter.paymentStatus}`);
  }
  if (filter.reviewStatus) {
    paymentConditions.push(Prisma.sql`p."review_status"::text = ${filter.reviewStatus}`);
  }
  if (filter.methodType) {
    paymentConditions.push(Prisma.sql`p."method_type"::text = ${filter.methodType}`);
  }
  if (paymentConditions.length > 0) {
    // All conditions on the SAME payment attempt, as the Prisma `some`.
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "payments" p
       WHERE p."course_order_id" = o."id"
         AND ${Prisma.join(paymentConditions, ' AND ')})`);
  }

  if (filter.refundStatus === 'none') {
    conditions.push(Prisma.sql`r."course_order_id" IS NULL`);
  } else if (filter.refundStatus) {
    conditions.push(Prisma.sql`r."status"::text = ${filter.refundStatus}`);
  }

  if (search) {
    const pattern = escapeLikePattern(search);
    const contains = `%${pattern}%`;
    conditions.push(Prisma.sql`(
      o."id" = ${search}
      OR c."title" ILIKE ${contains}
      OR u."name" ILIKE ${contains}
      OR u."email" ILIKE ${pattern})`);
  }

  return Prisma.join(conditions, ' AND ');
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
      return this.findManyByAmount(tx, academyId, filter, where, direction);
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
   * order by. The count uses the Prisma `where`; the page is ONE raw query
   * with the same filters (`buildAcademyCourseOrderSqlCondition`) that the
   * database orders and pages itself, so no id list is ever materialised
   * here. Both run in the caller's tenant transaction, under the same RLS.
   * The page is then loaded with the normal select and put back in order.
   */
  private async findManyByAmount(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: AcademyCourseOrderFilter & { readonly skip: number; readonly take: number },
    where: Prisma.CourseOrderWhereInput,
    direction: 'asc' | 'desc',
  ): Promise<{ items: AcademyCourseOrderRow[]; totalItems: number }> {
    const sortSql = direction === 'asc' ? Prisma.raw('ASC') : Prisma.raw('DESC');
    const [page, totalItems] = await Promise.all([
      tx.$queryRaw<{ id: string }[]>`
        SELECT o."id" FROM "course_orders" o
          LEFT JOIN "courses" c ON c."id" = o."course_id"
          LEFT JOIN "users" u ON u."id" = o."student_id"
          LEFT JOIN "course_order_refunds" r ON r."course_order_id" = o."id"
         WHERE ${buildAcademyCourseOrderSqlCondition(academyId, filter)}
         ORDER BY COALESCE((o."snapshot"->'price'->>'amountMinorUnits')::numeric, 0) ${sortSql},
                  o."created_at" DESC, o."id" ASC
        OFFSET ${filter.skip} LIMIT ${filter.take}
      `,
      tx.courseOrder.count({ where }),
    ]);
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
