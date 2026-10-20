/**
 * SubdomainAliasesRepository — an Academy's previous subdomain labels
 * (migration `20261123000100_subdomain_aliases`). Saving a new slug moves
 * the allocation to the new label and keeps the old one here, so its host
 * keeps answering — with a redirect to the Academy's canonical host — and
 * no other Academy can take it.
 *
 * Tenant-context only, like `SubdomainAllocationsRepository`: every method
 * takes the caller's `Prisma.TransactionClient`, and the table's RLS admits
 * a member of the Academy inside its organization. There is deliberately no
 * delete: an alias the Academy takes back as its address is renamed to the
 * label it gives up (`rename`), so an old name never becomes free again.
 * Cross-tenant availability is answered by
 * `SubdomainAllocationsRepository.isHeldByAnotherAcademy`.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, SubdomainAlias } from '@prisma/client';

@Injectable()
export class SubdomainAliasesRepository {
  /** This Academy's alias with exactly this label, if it has one. */
  findForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    subdomain: string,
  ): Promise<SubdomainAlias | null> {
    return tx.subdomainAlias.findFirst({ where: { academyId, subdomain } });
  }

  findAllForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<SubdomainAlias[]> {
    return tx.subdomainAlias.findMany({
      where: { academyId },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(
    tx: Prisma.TransactionClient,
    data: { readonly academyId: string; readonly subdomain: string },
  ): Promise<SubdomainAlias> {
    return tx.subdomainAlias.create({ data });
  }

  /** Re-points one alias row at another label (taking an old label back as the address). */
  rename(
    tx: Prisma.TransactionClient,
    id: string,
    subdomain: string,
  ): Promise<SubdomainAlias> {
    return tx.subdomainAlias.update({ where: { id }, data: { subdomain } });
  }
}
