/** CheckoutsRepository — `checkouts` is organization-scoped and RLS-protected; every method takes a `Prisma.TransactionClient` obtained from `TenancyContextService.runInTenantContext`, matching every other tenant-scoped repository in this codebase. */
import { Injectable } from '@nestjs/common';
import type { Checkout, Prisma } from '@prisma/client';

@Injectable()
export class CheckoutsRepository {
  findById(
    tx: Prisma.TransactionClient,
    organizationId: string,
    id: string,
  ): Promise<Checkout | null> {
    return tx.checkout.findFirst({ where: { id, organizationId } });
  }

  /** The exact lookup `createCheckout`'s idempotency-key replay safety depends on. */
  findByIdempotencyKey(
    tx: Prisma.TransactionClient,
    organizationId: string,
    idempotencyKey: string,
  ): Promise<Checkout | null> {
    return tx.checkout.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.CheckoutCreateInput,
  ): Promise<Checkout> {
    return tx.checkout.create({ data });
  }

  updateStatus(
    tx: Prisma.TransactionClient,
    id: string,
    status: Checkout['status'],
  ): Promise<Checkout> {
    return tx.checkout.update({ where: { id }, data: { status } });
  }
}
