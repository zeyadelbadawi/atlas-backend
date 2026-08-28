/** SupportCaseMessagesRepository — see `SupportCasesRepository`'s doc comment for the shared RLS/context rule. */
import { Injectable } from '@nestjs/common';
import type { Prisma, SupportCaseMessage } from '@prisma/client';

@Injectable()
export class SupportCaseMessagesRepository {
  findManyForCase(
    tx: Prisma.TransactionClient,
    caseId: string,
  ): Promise<SupportCaseMessage[]> {
    return tx.supportCaseMessage.findMany({
      where: { caseId },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.SupportCaseMessageUncheckedCreateInput,
  ): Promise<SupportCaseMessage> {
    return tx.supportCaseMessage.create({ data });
  }
}
