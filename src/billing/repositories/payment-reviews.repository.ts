/** PaymentReviewsRepository — see `PaymentAttemptsRepository`'s doc comment for the shared transitive-RLS rule; append-only. */
import { Injectable } from '@nestjs/common';
import type { PaymentReview, Prisma } from '@prisma/client';

@Injectable()
export class PaymentReviewsRepository {
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.PaymentReviewCreateInput,
  ): Promise<PaymentReview> {
    return tx.paymentReview.create({ data });
  }

  findManyForPayment(
    tx: Prisma.TransactionClient,
    paymentId: string,
  ): Promise<PaymentReview[]> {
    return tx.paymentReview.findMany({
      where: { paymentId },
      orderBy: { reviewedAt: 'desc' },
    });
  }
}
