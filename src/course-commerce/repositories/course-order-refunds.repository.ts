/** CourseOrderRefundsRepository — `course_order_refunds` (Phase P13). `courseOrderId` is `@unique` at the database level (see schema.prisma) — the real "duplicate refunds impossible" guarantee; `create` here relies on that constraint, never re-implements it in application code alone. */
import { Injectable } from '@nestjs/common';
import type { CourseOrderRefund, Prisma } from '@prisma/client';

@Injectable()
export class CourseOrderRefundsRepository {
  findByCourseOrderId(
    tx: Prisma.TransactionClient,
    courseOrderId: string,
  ): Promise<CourseOrderRefund | null> {
    return tx.courseOrderRefund.findUnique({ where: { courseOrderId } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.CourseOrderRefundCreateInput,
  ): Promise<CourseOrderRefund> {
    return tx.courseOrderRefund.create({ data });
  }
}
