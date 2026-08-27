/**
 * CourseOrdersService — `courses/:id/course-orders` (create, buyer-scoped)
 * and `/course-orders` (flat list/get, buyer-scoped). The course-purchase
 * analog of `CheckoutService` (master plan §5.8's own documented reason
 * this is its own table/service rather than overloading `Checkout`).
 *
 * `studentId` is always resolved from the authenticated session
 * (`request.authContext.userId`), never accepted as a request parameter —
 * the same non-negotiable rule `EnrollmentsService`/every other
 * student-scoped service in this codebase already follows (master plan
 * §5.3).
 *
 * Enforces §4.1's "no silent default" rule at the EARLIEST possible point
 * — an order is refused outright for an `unconfigured` Organization,
 * before a Payment ever gets a chance to exist for it.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Course } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { EnrollmentsRepository } from '../../learning/repositories/enrollments.repository';
import { OrganizationPaymentSettingsService } from '../../billing/services/organization-payment-settings.service';
import { CourseOrdersRepository } from '../repositories/course-orders.repository';
import { COURSE_ORDER_EXPIRY_MINUTES } from '../dto/course-commerce.constants';
import { toCourseOrderResponse } from '../dto/course-order.contract';
import type {
  CourseOrderResponse,
  CourseOrderSnapshotResponse,
} from '../dto/course-order.contract';
import type { CreateCourseOrderDto } from '../dto/create-course-order.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class CourseOrdersService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly organizationPaymentSettingsService: OrganizationPaymentSettingsService,
    private readonly courseOrdersRepository: CourseOrdersRepository,
  ) {}

  async createOrder(
    studentId: string,
    courseId: string,
    payload: CreateCourseOrderDto,
  ): Promise<CourseOrderResponse> {
    // Course lookup, existing-order idempotency check, and the initial
    // enrollment/pricing validation all read under the buyer's own user
    // context — `courses_public_discovery_select` (P6) already makes a
    // published+public course visible with no organization membership at
    // all, exactly the access shape a prospective buyer has.
    return this.tenancyContextService.runInUserContext(studentId, async (tx) => {
      const existing = await this.courseOrdersRepository.findByIdempotencyKey(
        tx,
        studentId,
        payload.idempotencyKey,
      );
      if (existing) return toCourseOrderResponse(existing);

      const course = await this.coursesRepository.findPublishedById(tx, courseId);
      if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (course.pricingType !== 'paid') {
        throw new ConflictException({ messageKey: 'errors.courseOrder.courseNotPaid' });
      }
      if (
        course.pricingAmountMinorUnits == null ||
        course.pricingAmountMinorUnits <= 0n ||
        !course.pricingCurrency
      ) {
        throw new ConflictException({
          messageKey: 'errors.courseOrder.pricingUnavailable',
        });
      }

      const existingEnrollment = await this.enrollmentsRepository.findByStudentAndCourse(
        tx,
        studentId,
        course.id,
      );
      if (existingEnrollment && existingEnrollment.status !== 'unavailable') {
        throw new ConflictException({ messageKey: 'errors.courseOrder.alreadyEnrolled' });
      }

      const activeOrder = await this.courseOrdersRepository.findActiveForStudentAndCourse(
        tx,
        studentId,
        course.id,
      );
      if (activeOrder) return toCourseOrderResponse(activeOrder);

      // A student is never an organization member of the Academy selling
      // the course, so the ordinary `AcademiesRepository.findById` read
      // (tenant/membership-RLS-gated) is structurally invisible here —
      // `resolveOrganizationId` reuses the existing P11
      // `resolve_academy_organization` `SECURITY DEFINER` function
      // instead, exactly like `PaymentsRepository.resolvePaymentOrganization`
      // does for the same "no legitimate session context yet" shape.
      const organizationId = await this.academiesRepository.resolveOrganizationId(
        course.academyId,
      );
      if (!organizationId) throw new NotFoundException({ messageKey: 'errors.notFound' });

      // §4.1's explicit, non-negotiable rule: an `unconfigured`
      // Organization must refuse paid-course checkout outright, never
      // silently default to a mode. Checked again, freshly, at Payment
      // creation (`CourseOrderPaymentsService`) — this is an early,
      // buyer-friendly rejection, not the only enforcement point.
      const configured =
        await this.organizationPaymentSettingsService.isConfigured(organizationId);
      if (!configured) {
        throw new ConflictException({
          messageKey: 'errors.courseOrder.paymentSetupIncomplete',
        });
      }

      const snapshot = this.buildSnapshot(course);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + COURSE_ORDER_EXPIRY_MINUTES * 60_000);

      try {
        const created = await this.courseOrdersRepository.create(tx, {
          studentId,
          courseId: course.id,
          academyId: course.academyId,
          organizationId,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          status: 'draft',
          expiresAt,
          idempotencyKey: payload.idempotencyKey,
        });
        return toCourseOrderResponse(created);
      } catch (error) {
        // Two concurrent requests replaying the same idempotency key raced
        // the check above — same race-safe fallback `CheckoutService`
        // already established.
        if (isUniqueConstraintViolation(error)) {
          const raced = await this.courseOrdersRepository.findByIdempotencyKey(
            tx,
            studentId,
            payload.idempotencyKey,
          );
          if (raced) return toCourseOrderResponse(raced);
        }
        throw error;
      }
    });
  }

  async getOrder(studentId: string, orderId: string): Promise<CourseOrderResponse> {
    const order = await this.tenancyContextService.runInUserContext(studentId, (tx) =>
      this.courseOrdersRepository.findByIdForStudent(tx, studentId, orderId),
    );
    if (!order) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toCourseOrderResponse(order);
  }

  async listOrders(
    studentId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<CourseOrderResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      studentId,
      (tx) =>
        this.courseOrdersRepository.findManyForStudent(tx, studentId, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toCourseOrderResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /** Exposed for `CourseOrderPaymentsService`, which needs the raw row inside its own already-open transaction — matches `CheckoutService.findCheckoutOrThrow`'s identical precedent. */
  async findOrderOrThrow(
    tx: Prisma.TransactionClient,
    studentId: string,
    orderId: string,
  ): Promise<Prisma.CourseOrderGetPayload<Record<string, never>>> {
    const order = await this.courseOrdersRepository.findByIdForStudent(
      tx,
      studentId,
      orderId,
    );
    if (!order) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return order;
  }

  private buildSnapshot(course: Course): CourseOrderSnapshotResponse {
    if (course.pricingAmountMinorUnits == null || !course.pricingCurrency) {
      // Unreachable — the caller already validated this immediately
      // before calling. Kept as a real throw, not a non-null assertion,
      // matching this codebase's "never trust an upstream check silently"
      // discipline.
      throw new ForbiddenException({
        messageKey: 'errors.courseOrder.pricingUnavailable',
      });
    }
    return {
      course: { id: course.id, title: course.title },
      price: {
        amountMinorUnits: Number(course.pricingAmountMinorUnits),
        currency: course.pricingCurrency,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
