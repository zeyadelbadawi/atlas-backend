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
import { AcademyPaymentMethodsRepository } from '../../billing/repositories/academy-payment-methods.repository';
import { ACADEMY_MANUAL_PROVIDER_KEY } from '../../billing/dto/billing.constants';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { CourseOrdersRepository } from '../repositories/course-orders.repository';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
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
import { CommunicationService } from '../../communications/services/communication.service';
import {
  AcademyStudentsRepository,
  isRejectedRegistration,
} from '../../tenancy/repositories/academy-students.repository';
import type { EmitResult } from '../../communications/services/communication.service';

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
    private readonly metrics: LearningMetricsService,
    private readonly communications: CommunicationService,
    private readonly academyPaymentMethodsRepository: AcademyPaymentMethodsRepository,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
  ) {}

  /**
   * Fix round (20 Oct 2026, team) — a learner whose registration THIS
   * academy rejected cannot buy its courses: a purchase would otherwise
   * produce an enrollment that opens nothing (learning access needs an
   * active membership, and a purchase never re-admits an existing row).
   * Re-admission is a staff decision, or a new registration under the
   * academy's policy. Only a REJECTED row (`isRejectedRegistration`) is
   * refused here: a pending learner still buys and gets access once
   * approved; an active one is unaffected; someone with no membership at
   * all is admitted by the purchase as before. Runs under the buyer's own
   * context (`academy_students_self_select`).
   */
  async assertNotRejectedLearner(
    tx: Prisma.TransactionClient,
    studentId: string,
    academyId: string,
  ): Promise<void> {
    const membership = await this.academyStudentsRepository.findForUserInAcademy(
      tx,
      academyId,
      studentId,
    );
    if (membership && isRejectedRegistration(membership)) {
      throw new ForbiddenException({ messageKey: 'errors.academy.registrationRejected' });
    }
  }

  async createOrder(
    studentId: string,
    courseId: string,
    payload: CreateCourseOrderDto,
  ): Promise<CourseOrderResponse> {
    // P64 Communications C3 (plan §8 D1). Declared out here so the
    // after-commit hint can be sent once the transaction has returned.
    let emitted: EmitResult = { created: false, outboxId: null };

    // Course lookup, existing-order idempotency check, and the initial
    // enrollment/pricing validation all read under the buyer's own user
    // context — `courses_public_discovery_select` (P6) already makes a
    // published+public course visible with no organization membership at
    // all, exactly the access shape a prospective buyer has.
    const response = await this.tenancyContextService.runInUserContext(
      studentId,
      async (tx) => {
        const existing = await this.courseOrdersRepository.findByIdempotencyKey(
          tx,
          studentId,
          payload.idempotencyKey,
        );
        if (existing) return toCourseOrderResponse(existing);

        const course = await this.coursesRepository.findPublishedById(tx, courseId);
        if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
        await this.assertNotRejectedLearner(tx, studentId, course.academyId);
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

        const existingEnrollment =
          await this.enrollmentsRepository.findByStudentAndCourse(
            tx,
            studentId,
            course.id,
          );
        if (existingEnrollment && existingEnrollment.status !== 'unavailable') {
          throw new ConflictException({
            messageKey: 'errors.courseOrder.alreadyEnrolled',
          });
        }

        const activeOrder =
          await this.courseOrdersRepository.findActiveForStudentAndCourse(
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
        if (!organizationId)
          throw new NotFoundException({ messageKey: 'errors.notFound' });

        // §4.1's explicit, non-negotiable rule: an `unconfigured`
        // Organization must refuse paid-course checkout outright, never
        // silently default to a mode. Checked again, freshly, at Payment
        // creation (`CourseOrderPaymentsService`) — this is an early,
        // buyer-friendly rejection, not the only enforcement point.
        //
        // Academy Manual Payments — an academy with its own enabled manual
        // methods is configured for payment on its own, whatever the
        // organization's mode (read under the buyer's context through
        // `academy_payment_methods_buyer_select`: enabled rows only).
        const configured =
          (await this.academyPaymentMethodsRepository.hasEnabledForAcademy(
            tx,
            course.academyId,
          )) ||
          (await this.organizationPaymentSettingsService.isConfigured(organizationId));
        if (!configured) {
          throw new ConflictException({
            messageKey: 'errors.courseOrder.paymentSetupIncomplete',
          });
        }

        // CF-21 — the plan's `students` limit fences NEW paid enrollments
        // too. Checked when the order is STARTED, never at approval: a
        // learner who has already paid is always enrolled.
        await this.assertAcceptingNewStudent(organizationId, studentId);

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
          // P64 Phase 4 (§D.5) — counted only for a genuinely new order; the
          // idempotent replays above return without reaching here.
          this.metrics.recordCheckoutOrderState('created');

          // P64 Communications C3 (plan §8 D1, §10 "D1 order created | yes
          // | never — receipt comes with D3"). In-app only by the
          // catalogue; this call site only has to be inside the same
          // transaction as the order, so an order that rolls back (the
          // idempotency-key race below) leaves no feed row behind.
          emitted = await this.communications.emit(tx, {
            key: 'course.order.created',
            recipientUserId: studentId,
            organizationId,
            academyId: course.academyId,
            entity: { type: 'course_order', id: created.id },
            values: {
              courseId: course.id,
              courseTitle: course.title,
              amount: (snapshot.price.amountMinorUnits / 100).toFixed(2),
              currency: snapshot.price.currency,
              expiresInMinutes: COURSE_ORDER_EXPIRY_MINUTES,
            },
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
      },
    );

    // Step 2, after the transaction has committed — a hint to the
    // dispatcher, never a requirement (the sweep finds a lost one).
    await this.communications.enqueueAfterCommit(emitted.outboxId);
    return response;
  }

  async getOrder(studentId: string, orderId: string): Promise<CourseOrderResponse> {
    const result = await this.tenancyContextService.runInUserContext(
      studentId,
      async (tx) => {
        const order = await this.courseOrdersRepository.findByIdForStudent(
          tx,
          studentId,
          orderId,
        );
        if (!order) return null;
        const paidToAcademy = await this.paidToAcademyOrderIds(tx, [order.id]);
        return { order, paidToAcademy };
      },
    );
    if (!result) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toCourseOrderResponse(result.order, {
      paidToAcademy: result.paidToAcademy.has(result.order.id),
    });
  }

  /** Academy Manual Payments — which of these orders were paid to the academy directly (no self-service refund). */
  private async paidToAcademyOrderIds(
    tx: Prisma.TransactionClient,
    orderIds: readonly string[],
  ): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const rows = await tx.payment.findMany({
      where: {
        courseOrderId: { in: [...orderIds] },
        status: 'succeeded',
        provider: ACADEMY_MANUAL_PROVIDER_KEY,
      },
      select: { courseOrderId: true },
    });
    return new Set(rows.map((row) => row.courseOrderId!));
  }

  async listOrders(
    studentId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<CourseOrderResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems, paidToAcademy } =
      await this.tenancyContextService.runInUserContext(studentId, async (tx) => {
        const result = await this.courseOrdersRepository.findManyForStudent(
          tx,
          studentId,
          { skip: (page - 1) * pageSize, take: pageSize },
        );
        const academyPaid = await this.paidToAcademyOrderIds(
          tx,
          result.items.map((order) => order.id),
        );
        return { ...result, paidToAcademy: academyPaid };
      });

    return {
      items: items.map((order) =>
        toCourseOrderResponse(order, { paidToAcademy: paidToAcademy.has(order.id) }),
      ),
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

  /**
   * CF-21 / B0-BIL-05 — refuses to START a paid order when the academy's
   * organization is already at its plan's `students` limit.
   *
   * Before this, order creation and payment approval deliberately never
   * consulted the limit, so paid sales (the main way an academy grows)
   * could take a Teacher-plan academy past 100 students without an
   * upgrade. The check runs in its own tenant-and-user transaction (the
   * buyer is not an organization member, so the order transaction cannot
   * read the subscription), exactly the context self-enrollment already
   * uses for the same check.
   *
   * - A learner already counted in this organization (enrolled in another
   *   of its courses) occupies no new seat, so is never refused.
   * - Only "limit reached" refuses. An inactive or missing subscription is
   *   NOT handled here: that behaviour is unchanged by this fix.
   * - Approval of an order created before the limit was reached stays
   *   honoured (`CourseOrderPaymentApplicationService` is untouched).
   */
  private async assertAcceptingNewStudent(
    organizationId: string,
    studentId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      studentId,
      async (tx) => {
        const alreadyCounted =
          await this.enrollmentsRepository.countActiveForStudentInOrganization(
            tx,
            organizationId,
            studentId,
          );
        if (alreadyCounted > 0) return;
        try {
          await this.entitlementEnforcementService.assertWithinLimit(
            tx,
            organizationId,
            'students',
            1,
          );
        } catch (error) {
          if (
            error instanceof ConflictException &&
            (error.getResponse() as { code?: string }).code ===
              'ENTITLEMENT_LIMIT_REACHED'
          ) {
            throw new ConflictException({
              messageKey: 'errors.courseOrder.notAcceptingEnrollments',
            });
          }
          if (error instanceof ForbiddenException) return;
          throw error;
        }
      },
    );
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
