/** PaymentProofsRepository — see `PaymentAttemptsRepository`'s doc comment for the shared transitive-RLS rule; append-only (no update method — a resubmission is a new row). */
import { Injectable } from '@nestjs/common';
import type { PaymentProof, Prisma } from '@prisma/client';

@Injectable()
export class PaymentProofsRepository {
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.PaymentProofCreateInput,
  ): Promise<PaymentProof> {
    return tx.paymentProof.create({ data });
  }

  findLatestForPayment(
    tx: Prisma.TransactionClient,
    paymentId: string,
  ): Promise<PaymentProof | null> {
    return tx.paymentProof.findFirst({
      where: { paymentId },
      orderBy: { uploadedAt: 'desc' },
    });
  }
}
