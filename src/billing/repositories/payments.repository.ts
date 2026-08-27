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
import type { Payment } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

const WITH_RELATIONS = {
  attempts: true,
  proofs: true,
} satisfies Prisma.PaymentInclude;

type PaymentWithRelations = Payment & {
  attempts: Prisma.PaymentAttemptGetPayload<Record<string, never>>[];
  proofs: Prisma.PaymentProofGetPayload<Record<string, never>>[];
};

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

  /** Platform-review listing, across every organization — see `findByIdAnyOrganization`'s doc comment for the RLS mechanism this relies on. */
  async findManyAnyOrganization(
    tx: Prisma.TransactionClient,
    filter: { readonly search?: string; readonly skip: number; readonly take: number },
  ): Promise<{ items: PaymentWithRelations[]; totalItems: number }> {
    const where: Prisma.PaymentWhereInput = {
      checkoutId: { not: null },
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
    filter: { readonly search?: string; readonly skip: number; readonly take: number },
  ): Promise<{ items: PaymentWithRelations[]; totalItems: number }> {
    const where: Prisma.PaymentWhereInput = {
      courseOrderId: { not: null },
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
