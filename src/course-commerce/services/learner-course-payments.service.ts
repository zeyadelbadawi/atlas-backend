/**
 * LearnerCoursePaymentsService — `GET course-payments`, the learner's own
 * payment history ("My payments", Academy Manual Payments).
 *
 * Self-scoped: the learner id comes from the session, never the request,
 * and the read runs in the learner's own user context, where
 * `payments_payer_select` admits only their own payments; the query also
 * filters by `payerUserId`. Superseded selections (a method the learner
 * chose and then switched away from before sending proof — `cancelled` with
 * no review) are not history and are left out.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../common/dto/collection-query.dto';
import {
  LEARNER_COURSE_PAYMENT_SELECT,
  toLearnerCoursePaymentResponse,
  type LearnerCoursePaymentResponse,
} from '../dto/learner-course-payment.contract';
import type { LearnerCoursePaymentQueryDto } from '../dto/learner-course-payment-query.dto';

@Injectable()
export class LearnerCoursePaymentsService {
  constructor(private readonly tenancyContextService: TenancyContextService) {}

  async list(
    studentId: string,
    query: LearnerCoursePaymentQueryDto,
  ): Promise<PaginatedResult<LearnerCoursePaymentResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.PaymentWhereInput = {
      payerUserId: studentId,
      courseOrderId: { not: null },
      ...(query.academyId ? { payeeAcademyId: query.academyId } : {}),
      NOT: { status: 'cancelled', reviewStatus: 'not_required' },
    };
    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      studentId,
      async (tx) => {
        const [rows, count] = await Promise.all([
          tx.payment.findMany({
            where,
            select: LEARNER_COURSE_PAYMENT_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.payment.count({ where }),
        ]);
        return { items: rows, totalItems: count };
      },
    );
    return {
      items: items.map(toLearnerCoursePaymentResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }
}
