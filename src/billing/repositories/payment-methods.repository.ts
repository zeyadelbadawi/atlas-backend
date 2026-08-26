/** PaymentMethodsRepository — `payment_methods` is a PLATFORM-owned catalog table, no RLS, no tenant context (mirrors `PlansRepository`'s established precedent exactly). */
import { Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class PaymentMethodsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAllEnabled(): Promise<PaymentMethod[]> {
    return this.prisma.paymentMethod.findMany({
      where: { enabled: true },
      orderBy: { displayOrder: 'asc' },
    });
  }

  findByKey(key: string): Promise<PaymentMethod | null> {
    return this.prisma.paymentMethod.findUnique({ where: { key } });
  }
}
