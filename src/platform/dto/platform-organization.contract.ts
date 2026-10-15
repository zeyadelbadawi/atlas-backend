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
import type { OrganizationOwnerPhoneEntry } from '../../identity/phone/user-phone.service';

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

/**
 * B0-IAM-08 — the owner's number, present ONLY when the owner opted in to
 * WhatsApp contact at signup (`platform_organization_owner_phones`). Absent
 * otherwise; never a learner's number.
 */
export interface PlatformOrganizationOwnerPhoneResponse {
  readonly e164: string;
  readonly country: string;
  readonly whatsappConsentAt: string;
  readonly whatsappConsentVersion: string;
}

export interface PlatformOrganizationDetailResponse extends PlatformOrganizationSummaryResponse {
  readonly ownerName?: string;
  readonly ownerEmail?: string;
  readonly ownerPhone?: PlatformOrganizationOwnerPhoneResponse;
  /** B0-ANL-04 — sanitised signup attribution (UTM / referrer domain / template), or null. */
  readonly signupAttribution: Record<string, string> | null;
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
  ownerPhone?: OrganizationOwnerPhoneEntry,
): PlatformOrganizationDetailResponse {
  const attribution = organization.signupAttribution;
  return {
    ...toPlatformOrganizationSummaryResponse(organization, subscription),
    ownerName: organization.owner.name,
    ownerEmail: organization.owner.email,
    ...(ownerPhone
      ? {
          ownerPhone: {
            e164: ownerPhone.e164,
            country: ownerPhone.country,
            whatsappConsentAt: ownerPhone.whatsappConsentAt.toISOString(),
            whatsappConsentVersion: ownerPhone.whatsappConsentVersion,
          },
        }
      : {}),
    signupAttribution:
      attribution && typeof attribution === 'object' && !Array.isArray(attribution)
        ? (attribution as Record<string, string>)
        : null,
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
