/**
 * `OrganizationConnectedAccount` response contract (master plan §4.1/§5.8).
 * Schema/service foundation only — every field is honestly `not_started`/
 * disabled until a future phase integrates a real Connect-style processor;
 * never a fabricated "connected" status (matches P11's Cloudflare "honest
 * not-configured" precedent).
 */
import type { OrganizationConnectedAccount } from '@prisma/client';

export interface OrganizationConnectedAccountResponse {
  readonly organizationId: string;
  readonly providerKey: string | null;
  readonly onboardingStatus: OrganizationConnectedAccount['onboardingStatus'];
  readonly payoutsEnabled: boolean;
  readonly updatedAt?: string;
}

export function toOrganizationConnectedAccountResponse(
  organizationId: string,
  account: OrganizationConnectedAccount | null,
): OrganizationConnectedAccountResponse {
  return {
    organizationId,
    providerKey: account?.providerKey ?? null,
    onboardingStatus: account?.onboardingStatus ?? 'not_started',
    payoutsEnabled: account?.payoutsEnabled ?? false,
    updatedAt: account?.updatedAt.toISOString(),
  };
}
