/**
 * AcademyCourseOrdersService — `academies/:id/course-orders*`, the
 * Organization Owner's read-only view of one academy's course sales.
 *
 * Authorization is the academy-finance rule verbatim
 * (`assertCanViewAcademyFinance`: Organization Owner only — a manager,
 * instructor or academy-level member gets 403), the same gate as the
 * academy's payouts and revenue summary. Reads run in the organization's
 * tenant context, where the SELECT-only `*_tenant_select` policies of
 * `20261103000000_tenant_course_order_read_rls` admit exactly that
 * organization's orders; the repository additionally filters by academy.
 *
 * No financial action lives here: approving, rejecting and refunding stay
 * with the Platform Owner and the buyer respectively.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { AcademyContext } from '../../academy/guards/academy-scope.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyCourseOrdersRepository } from '../repositories/academy-course-orders.repository';
import { assertCanViewAcademyFinance } from './academy-payouts.service';
import {
  toAcademyCourseOrderDetailResponse,
  toAcademyCourseOrderResponse,
  type AcademyCourseOrderDetailResponse,
  type AcademyCourseOrderResponse,
} from '../dto/academy-course-order.contract';
import type { AcademyCourseOrderQueryDto } from '../dto/academy-course-order-query.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../common/dto/collection-query.dto';

@Injectable()
export class AcademyCourseOrdersService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyCourseOrdersRepository: AcademyCourseOrdersRepository,
  ) {}

  async listForAcademy(
    context: AcademyContext,
    academyId: string,
    query: AcademyCourseOrderQueryDto,
  ): Promise<PaginatedResult<AcademyCourseOrderResponse>> {
    const organizationId = assertCanViewAcademyFinance(context);
    const page = query.page ?? DEFAULT_PAGE;
    // The DTO already refuses > MAX_PAGE_SIZE; clamped again so a caller
    // that bypasses validation still cannot pull an unbounded page.
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.academyCourseOrdersRepository.findManyForAcademy(tx, academyId, {
          status: query.status,
          paymentStatus: query.paymentStatus,
          reviewStatus: query.reviewStatus,
          methodType: query.methodType,
          refundStatus: query.refundStatus,
          courseId: query.courseId,
          from: query.from,
          to: query.to,
          search: query.search,
          sortBy: query.sortBy,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toAcademyCourseOrderResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getForAcademy(
    context: AcademyContext,
    academyId: string,
    orderId: string,
  ): Promise<AcademyCourseOrderDetailResponse> {
    const organizationId = assertCanViewAcademyFinance(context);
    const order = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.academyCourseOrdersRepository.findOneForAcademy(tx, academyId, orderId),
    );
    if (!order) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toAcademyCourseOrderDetailResponse(order);
  }
}
