/** PaymentAttemptsRepository — `payment_attempts` reaches tenant scope transitively through `payment_id → payments.organization_id` (see the P12 migration's RLS comment); every method still takes a `Prisma.TransactionClient` from `TenancyContextService`. */
import { Injectable } from '@nestjs/common';
import type { PaymentAttempt, Prisma } from '@prisma/client';

@Injectable()
export class PaymentAttemptsRepository {
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.PaymentAttemptCreateInput,
  ): Promise<PaymentAttempt> {
    return tx.paymentAttempt.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.PaymentAttemptUpdateInput,
  ): Promise<PaymentAttempt> {
    return tx.paymentAttempt.update({ where: { id }, data });
  }

  findLatestForPayment(
    tx: Prisma.TransactionClient,
    paymentId: string,
  ): Promise<PaymentAttempt | null> {
    return tx.paymentAttempt.findFirst({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
