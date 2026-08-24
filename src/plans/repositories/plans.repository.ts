/**
 * PlansRepository — `plans` is a PLATFORM-owned catalog table, no RLS, no
 * tenant context (see the P4 migration's doc comment). Unlike every
 * tenant-scoped repository in this codebase, this one takes the raw
 * `PrismaService` directly, not a `Prisma.TransactionClient` from
 * `TenancyContextService` — there is no tenant context to establish for a
 * table every caller reads identically.
 */
import { Injectable } from '@nestjs/common';
import type { Plan } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class PlansRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Plan[]> {
    return this.prisma.plan.findMany({ orderBy: { displayOrder: 'asc' } });
  }

  findByKey(key: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { key } });
  }

  findById(id: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { id } });
  }
}
