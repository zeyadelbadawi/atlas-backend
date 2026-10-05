/**
 * PaymentsRepository — `payments` is organization-scoped AND, additionally,
 * readable/writable by a verified Platform Owner across every organization
 * (see the P12 migration's own RLS header comment: `payments_platform_
 * review_select`/`_update`, paired with `TenancyContextService.
 * runInUserContext`). Every tenant-facing method still takes an explicit
 * `organizationId` in its `where` clause as defense-in-depth, matching
 * every other repository in this codebase's established rule — RLS is
 * never the ONLY check.
 *
 * `resolvePaymentOrganization` is the one method that takes the raw
 * `PrismaService` instead of a `Prisma.TransactionClient` — it calls the
 * `resolve_payment_organization` `SECURITY DEFINER` function, which by
 * design needs no tenant/user context to already be set (see the
 * migration's own doc comment for the full justification, mirroring P11's
 * `resolve_academy_organization`).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ManualReviewStatus, Payment } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ACADEMY_MANUAL_PROVIDER_KEY } from '../dto/billing.constants';

const WITH_RELATIONS = {
  attempts: true,
  proofs: true,
} satisfies Prisma.PaymentInclude;

type PaymentWithRelations = Payment & {
  attempts: Prisma.PaymentAttemptGetPayload<Record<string, never>>[];
  proofs: Prisma.PaymentProofGetPayload<Record<string, never>>[];
};

/**
 * Platform review context for a SUBSCRIPTION payment: which organization
 * paid and what the checkout was for. Readable cross-tenant through the
 * `organizations_platform_select`/`checkouts_platform_select` policies.
 */
const WITH_SUBSCRIPTION_REVIEW_CONTEXT = {
  ...WITH_RELATIONS,
  organization: { select: { id: true, name: true } },
  checkout: {
    select: { targetType: true, targetKey: true, billingCycle: true, snapshot: true },
  },
} satisfies Prisma.PaymentInclude;

export type PaymentWithSubscriptionReviewContext = Prisma.PaymentGetPayload<{
  include: typeof WITH_SUBSCRIPTION_REVIEW_CONTEXT;
}>;

/**
 * Platform review context for a COURSE payment: the academy paid, the
 * course and the order's own status and refund status. Readable through
 * the `academies`/`courses`/`course_orders`/`course_order_refunds`
 * `*_platform_select` policies.
 */
const WITH_COURSE_REVIEW_CONTEXT = {
  ...WITH_RELATIONS,
  payeeAcademy: { select: { id: true, name: true } },
  courseOrder: {
    select: {
      status: true,
      snapshot: true,
      courseId: true,
      course: { select: { title: true } },
      refund: { select: { status: true } },
    },
  },
} satisfies Prisma.PaymentInclude;

export type PaymentWithCourseReviewContext = Prisma.PaymentGetPayload<{
  include: typeof WITH_COURSE_REVIEW_CONTEXT;
}>;

/** The Platform review lists' shared filter/sort/page input. */
export interface PlatformPaymentListFilter {
  readonly search?: string;
  readonly reviewStatus?: ManualReviewStatus;
  readonly status?: Payment['status'];
  readonly methodType?: Payment['methodType'];
  readonly from?: string;
  readonly to?: string;
  readonly sortBy?: 'createdAt' | 'updatedAt' | 'amount';
  readonly sortDirection?: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive UTC calendar dates → a `createdAt` range; `undefined` when neither bound is usable. */
function createdAtRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  const start = from ? new Date(`${from}T00:00:00.000Z`) : undefined;
  const end = to ? new Date(`${to}T00:00:00.000Z`) : undefined;
  const gte = start && !Number.isNaN(start.getTime()) ? start : undefined;
  const lt =
    end && !Number.isNaN(end.getTime()) ? new Date(end.getTime() + DAY_MS) : undefined;
  if (!gte && !lt) return undefined;
  return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
}

/** Filters common to both Platform review lists (search is list-specific). */
function platformListCommonWhere(
  filter: PlatformPaymentListFilter,
): Prisma.PaymentWhereInput {
  const createdAt = createdAtRange(filter.from, filter.to);
  return {
    ...(filter.reviewStatus ? { reviewStatus: filter.reviewStatus } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.methodType ? { methodType: filter.methodType } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

/** Search terms every payment row can answer: its id (exact), provider reference, method key and provider. */
function paymentSearchTerms(search: string): Prisma.PaymentWhereInput[] {
  const contains = { contains: search, mode: 'insensitive' as const };
  return [
    { id: search },
    { providerReference: contains },
    { methodKey: contains },
    { provider: contains },
  ];
}

function platformListOrderBy(
  filter: PlatformPaymentListFilter,
): Prisma.PaymentOrderByWithRelationInput[] {
  const direction = filter.sortDirection ?? 'desc';
  const column =
    filter.sortBy === 'amount'
      ? 'amountMinorUnits'
      : filter.sortBy === 'updatedAt'
        ? 'updatedAt'
        : 'createdAt';
  return [{ [column]: direction }, { id: direction }];
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(
    tx: Prisma.TransactionClient,
    organizationId: string,
    id: string,
  ): Promise<PaymentWithRelations | null> {
    return tx.payment.findFirst({
      where: { id, organizationId },
      include: WITH_RELATIONS,
    });
  }

  /** Platform-review lookup — no `organizationId` filter; RLS's `payments_platform_review_select` policy is the only thing that makes this return a row, requiring `TenancyContextService.runInUserContext` with a verified Platform Owner's id already active. */
  findByIdAnyOrganization(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<PaymentWithRelations | null> {
    return tx.payment.findFirst({ where: { id }, include: WITH_RELATIONS });
  }

  async findManyForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    filter: { readonly search?: string; readonly skip: number; readonly take: number },
  ): Promise<{ items: PaymentWithRelations[]; totalItems: number }> {
    const where: Prisma.PaymentWhereInput = {
      organizationId,
      ...(filter.search
        ? {
            OR: [
              { methodKey: { contains: filter.search, mode: 'insensitive' as const } },
              { provider: { contains: filter.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.payment.findMany({
        where,
        include: WITH_RELATIONS,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.payment.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** Platform-review listing, across every organization — see `findByIdAnyOrganization`'s doc comment for the RLS mechanism this relies on. Carries the organization's name and the checkout's plan/billing cycle so the reviewer never has to read a raw id. */
  async findManyAnyOrganization(
    tx: Prisma.TransactionClient,
    filter: PlatformPaymentListFilter,
  ): Promise<{ items: PaymentWithSubscriptionReviewContext[]; totalItems: number }> {
    const search = filter.search?.trim();
    const where: Prisma.PaymentWhereInput = {
      checkoutId: { not: null },
      ...platformListCommonWhere(filter),
      ...(search
        ? {
            OR: [
              ...paymentSearchTerms(search),
              {
                organization: {
                  is: { name: { contains: search, mode: 'insensitive' as const } },
                },
              },
            ],
          }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.payment.findMany({
        where,
        include: WITH_SUBSCRIPTION_REVIEW_CONTEXT,
        orderBy: platformListOrderBy(filter),
        skip: filter.skip,
        take: filter.take,
      }),
      tx.payment.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** `findByIdAnyOrganization` plus the subscription review context (organization name, checkout plan/cycle) — Platform detail read. */
  findByIdAnyOrganizationWithSubscriptionContext(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<PaymentWithSubscriptionReviewContext | null> {
    return tx.payment.findFirst({
      where: { id },
      include: WITH_SUBSCRIPTION_REVIEW_CONTEXT,
    });
  }

  /** `findByIdAnyOrganization` plus the course review context (academy name, course title, order and refund status) — Platform detail read. */
  findByIdAnyOrganizationWithCourseContext(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<PaymentWithCourseReviewContext | null> {
    return tx.payment.findFirst({
      where: { id },
      include: WITH_COURSE_REVIEW_CONTEXT,
    });
  }

  /**
   * Platform-review listing for Course Commerce (P13) rows only, across
   * every Academy — the course-order analog of `findManyAnyOrganization`
   * immediately above, which is now itself scoped to `checkoutId IS NOT
   * NULL` (Atlas-subscription-billing rows only) so the two flows never
   * bleed into each other's review queue, matching this codebase's
   * "structurally distinguishable even though they share a table" rule
   * (ADR-010).
   */
  async findManyAnyOrganizationCourseOrders(
    tx: Prisma.TransactionClient,
    filter: PlatformPaymentListFilter,
  ): Promise<{ items: PaymentWithCourseReviewContext[]; totalItems: number }> {
    const search = filter.search?.trim();
    const contains = search
      ? { contains: search, mode: 'insensitive' as const }
      : undefined;
    const where: Prisma.PaymentWhereInput = {
      courseOrderId: { not: null },
      // Academy Manual Payments are paid to the academy and reviewed by its
      // Client Owner, never in the Platform Owner's queue.
      provider: { not: ACADEMY_MANUAL_PROVIDER_KEY },
      ...platformListCommonWhere(filter),
      ...(search && contains
        ? {
            OR: [
              ...paymentSearchTerms(search),
              { courseOrderId: search },
              { payeeAcademy: { is: { name: contains } } },
              { courseOrder: { is: { course: { title: contains } } } },
            ],
          }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.payment.findMany({
        where,
        include: WITH_COURSE_REVIEW_CONTEXT,
        orderBy: platformListOrderBy(filter),
        skip: filter.skip,
        take: filter.take,
      }),
      tx.payment.count({ where }),
    ]);

    return { items, totalItems };
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.PaymentCreateInput,
  ): Promise<Payment> {
    return tx.payment.create({ data });
  }

  /**
   * Phase P13 — course-order Payment creation. `UncheckedCreateInput`
   * (plain scalar `payerUserId`/`payeeAcademyId`/`courseOrderId`), not the
   * relational `CreateInput` `create()` above uses — deliberately, and for
   * the identical reason `CourseOrdersRepository.create`'s own doc comment
   * explains: the buying student is never an Academy/Organization member,
   * so a nested `connect`'s pre-flight existence SELECT against
   * `academies`/`payee_academy_id` would be RLS-invisible even though the
   * row exists. `create()` above is untouched — Atlas-subscription-billing
   * Payments still connect through `checkout`/`organization`, both
   * genuinely visible under the paying Organization's own tenant context.
   */
  createCourseOrderPayment(
    tx: Prisma.TransactionClient,
    data: Prisma.PaymentUncheckedCreateInput,
  ): Promise<Payment> {
    return tx.payment.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.PaymentUpdateInput,
  ): Promise<Payment> {
    return tx.payment.update({ where: { id }, data });
  }

  /**
   * W8 D2 — the ONE conditional transition into `succeeded`.
   *
   * `UPDATE ... WHERE id = ? AND status <> 'succeeded'`: a manual approval
   * followed by a signed `payment.succeeded` webhook (different event id),
   * or two concurrent appliers, both reach here; Postgres row-locks the
   * payment, the second re-evaluates the predicate after the first commits,
   * matches zero rows and reports `false` — so the commercial effect (a
   * paid period) is applied exactly once per payment.
   */
  async markSucceededIfNotAlready(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<boolean> {
    const result = await tx.payment.updateMany({
      where: { id, status: { not: 'succeeded' } },
      data: { status: 'succeeded', failureReason: null, nextAction: Prisma.JsonNull },
    });
    return result.count === 1;
  }

  /** Open (not yet settled) payments for one subscription checkout. */
  findOpenForCheckout(
    tx: Prisma.TransactionClient,
    checkoutId: string,
  ): Promise<Payment[]> {
    return tx.payment.findMany({
      where: {
        checkoutId,
        status: {
          in: [
            'created',
            'pending',
            'processing',
            'requires_action',
            'requires_confirmation',
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Moves a payment out of `pending` review in ONE conditional write — the
   * claim that makes a review happen once. Two reviewers (or a double
   * click) approving at the same moment both read `pending`; only one of
   * these updates matches, the other gets 0 and must refuse.
   */
  async claimPendingReview(
    tx: Prisma.TransactionClient,
    id: string,
    reviewStatus: 'approved' | 'rejected',
    reviewNotes: string | undefined,
  ): Promise<boolean> {
    const result = await tx.payment.updateMany({
      where: { id, reviewStatus: 'pending' },
      data: { reviewStatus, reviewNotes },
    });
    return result.count === 1;
  }

  /** Phase P13 — the succeeded Payment for a CourseOrder, if one exists. A CourseOrder may have more than one Payment row (retried attempts after an earlier failure/rejection, mirroring `Checkout`'s own precedent) — this resolves the one that actually succeeded, needed by `CourseOrderRefundsService` to attach a refund to the correct Payment. */
  findSucceededForCourseOrder(
    tx: Prisma.TransactionClient,
    courseOrderId: string,
  ): Promise<Payment | null> {
    return tx.payment.findFirst({
      where: { courseOrderId, status: 'succeeded' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Bare id→organizationId lookup, callable with NO tenant/user context set at all — see this class's own doc comment. */
  async resolvePaymentOrganization(paymentId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ organization_id: string }[]>(
      Prisma.sql`SELECT * FROM resolve_payment_organization(${paymentId})`,
    );
    return rows[0]?.organization_id ?? null;
  }
}
