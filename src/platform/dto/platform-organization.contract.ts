/**
 * `PlatformOrganizationSummary`/`.Detail` response contracts — match
 * `platform-organization.types.ts` (atlas frontend) field-for-field.
 * `subscription`/`usage` are passed in already built by
 * `TenantSubscriptionService.getSubscription`/`.getUsage` (P4) — reused
 * verbatim, never a re-shaped copy of `tenant_subscriptions`/
 * `tenant_usage` data.
 */
import type { Academy, OrganizationStatus } from '@prisma/client';
import type { TenantSubscriptionResponse } from '../../plans/dto/tenant-subscription.contract';
import type { TenantUsageResponse } from '../../plans/dto/tenant-usage.contract';
import type {
  OrganizationWithCounts,
  OrganizationWithOwnerAndCounts,
} from '../../tenancy/repositories/organizations.repository';
import type { OrganizationMembershipWithUser } from '../../tenancy/repositories/organization-memberships.repository';

export interface PlatformOrganizationAcademyRefResponse {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface PlatformOrganizationMemberRefResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
}

export interface PlatformOrganizationSummaryResponse {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  readonly status: OrganizationStatus;
  readonly planName?: string;
  readonly subscriptionStatus?: string;
  readonly academyCount: number;
  readonly memberCount: number;
  readonly createdAt: string;
}

export interface PlatformOrganizationDetailResponse extends PlatformOrganizationSummaryResponse {
  readonly ownerName?: string;
  readonly ownerEmail?: string;
  readonly subscription?: TenantSubscriptionResponse;
  readonly usage?: TenantUsageResponse;
  readonly academies: readonly PlatformOrganizationAcademyRefResponse[];
  readonly members: readonly PlatformOrganizationMemberRefResponse[];
}

export function toPlatformOrganizationSummaryResponse(
  organization: OrganizationWithCounts,
  subscription?: TenantSubscriptionResponse,
): PlatformOrganizationSummaryResponse {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    planName: subscription?.plan.name,
    subscriptionStatus: subscription?.status,
    academyCount: organization._count.academies,
    memberCount: organization._count.memberships,
    createdAt: organization.createdAt.toISOString(),
  };
}

export function toPlatformOrganizationDetailResponse(
  organization: OrganizationWithOwnerAndCounts,
  subscription: TenantSubscriptionResponse | undefined,
  usage: TenantUsageResponse | undefined,
  academies: readonly Pick<Academy, 'id' | 'name' | 'status'>[],
  members: readonly OrganizationMembershipWithUser[],
): PlatformOrganizationDetailResponse {
  return {
    ...toPlatformOrganizationSummaryResponse(organization, subscription),
    ownerName: organization.owner.name,
    ownerEmail: organization.owner.email,
    subscription,
    usage,
    academies: academies.map((academy) => ({
      id: academy.id,
      name: academy.name,
      status: academy.status,
    })),
    members: members.map((membership) => ({
      id: membership.id,
      name: membership.user.name,
      email: membership.user.email,
      role: membership.role,
    })),
  };
}
