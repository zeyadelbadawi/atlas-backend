/**
 * OrganizationsRepository — see `OrganizationMembershipsRepository`'s doc
 * comment: every method takes a `Prisma.TransactionClient` obtained from
 * `TenancyContextService`, never the raw `PrismaService`.
 */
import { Injectable } from '@nestjs/common';
import type { Organization, Prisma } from '@prisma/client';

@Injectable()
export class OrganizationsRepository {
  findById(tx: Prisma.TransactionClient, id: string): Promise<Organization | null> {
    return tx.organization.findUnique({ where: { id } });
  }

  /** All organizations RLS currently permits — meaningful only inside `runInUserContext` (see that method's doc comment), where it resolves to exactly the organizations the given user belongs to. */
  findAllVisible(tx: Prisma.TransactionClient): Promise<Organization[]> {
    return tx.organization.findMany();
  }
}
