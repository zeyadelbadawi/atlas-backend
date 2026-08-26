/** TenantInvoicesRepository — `tenant_invoices` is organization-scoped and RLS-protected. No creation method exists yet — see `schema.prisma`'s `TenantInvoice` doc comment for why (no invoice-generation trigger is specified anywhere). */
import { Injectable } from '@nestjs/common';
import type { Prisma, TenantInvoice } from '@prisma/client';

@Injectable()
export class TenantInvoicesRepository {
  async findManyForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    filter: { readonly skip: number; readonly take: number },
  ): Promise<{ items: TenantInvoice[]; totalItems: number }> {
    const where: Prisma.TenantInvoiceWhereInput = { organizationId };
    const [items, totalItems] = await Promise.all([
      tx.tenantInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.tenantInvoice.count({ where }),
    ]);
    return { items, totalItems };
  }
}
