/**
 * `TenantInvoice` response contract — matches `TenantInvoice`
 * (`payment.types.ts`). Read-only; no creation endpoint in this phase (see
 * `schema.prisma`'s `TenantInvoice` doc comment).
 */
import type { TenantInvoice as PrismaTenantInvoice } from '@prisma/client';
import type { MoneyResponse } from './checkout.contract';

export interface TenantInvoiceResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly paymentId?: string;
  readonly number: string;
  readonly status: PrismaTenantInvoice['status'];
  readonly money: MoneyResponse;
  readonly issuedAt?: string;
  readonly dueAt?: string;
  readonly paidAt?: string;
}

export function toTenantInvoiceResponse(
  invoice: PrismaTenantInvoice,
): TenantInvoiceResponse {
  return {
    id: invoice.id,
    organizationId: invoice.organizationId,
    paymentId: invoice.paymentId ?? undefined,
    number: invoice.number,
    status: invoice.status,
    money: {
      amountMinorUnits: Number(invoice.amountMinorUnits),
      currency: invoice.currency,
    },
    issuedAt: invoice.issuedAt?.toISOString(),
    dueAt: invoice.dueAt?.toISOString(),
    paidAt: invoice.paidAt?.toISOString(),
  };
}
