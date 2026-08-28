/**
 * `PlatformAcademySummary`/`.Detail` response contracts — match
 * `platform-academy.types.ts` (atlas frontend) field-for-field, reusing
 * `AcademyStatus`/`ProvisioningStatus`/`WebsitePublishStatus`/
 * `DomainStatus` verbatim (never a re-declared vocabulary).
 */
import type {
  AcademyStatus,
  Course,
  DomainConnection,
  ProvisioningRequest,
  WebsiteConfiguration,
} from '@prisma/client';
import type { AcademyWithOrganizationAndCounts } from '../../academy/repositories/academies.repository';
import type { AcademyMemberWithUser } from '../../academy/repositories/academy-members.repository';

export interface PlatformAcademyCourseRefResponse {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export interface PlatformAcademyMemberRefResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
}

export interface PlatformAcademySummaryResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly status: AcademyStatus;
  readonly ownerName?: string;
  readonly courseCount: number;
  readonly memberCount: number;
  readonly createdAt: string;
}

export interface PlatformAcademyDetailResponse extends PlatformAcademySummaryResponse {
  readonly description?: string;
  readonly logo?: string;
  readonly provisioningStatus?: ProvisioningRequest['status'];
  readonly websiteStatus?: WebsiteConfiguration['status'];
  readonly domainStatus?: DomainConnection['status'];
  readonly courses: readonly PlatformAcademyCourseRefResponse[];
  readonly members: readonly PlatformAcademyMemberRefResponse[];
}

export function toPlatformAcademySummaryResponse(
  academy: AcademyWithOrganizationAndCounts,
  ownerName?: string,
): PlatformAcademySummaryResponse {
  return {
    id: academy.id,
    name: academy.name,
    slug: academy.slug,
    organizationId: academy.organizationId,
    organizationName: academy.organization.name,
    status: academy.status,
    ownerName,
    courseCount: academy._count.courses,
    memberCount: academy._count.members,
    createdAt: academy.createdAt.toISOString(),
  };
}

export function toPlatformAcademyDetailResponse(
  academy: AcademyWithOrganizationAndCounts,
  members: readonly AcademyMemberWithUser[],
  courses: readonly Pick<Course, 'id' | 'title' | 'status'>[],
  provisioningStatus: ProvisioningRequest['status'] | undefined,
  websiteStatus: WebsiteConfiguration['status'] | undefined,
  domainStatus: DomainConnection['status'] | undefined,
): PlatformAcademyDetailResponse {
  const owner = members.find((member) => member.role === 'owner');

  return {
    ...toPlatformAcademySummaryResponse(academy, owner?.user.name),
    description: academy.description ?? undefined,
    logo: academy.logoUrl ?? undefined,
    provisioningStatus,
    websiteStatus,
    domainStatus,
    courses: courses.map((course) => ({
      id: course.id,
      title: course.title,
      status: course.status,
    })),
    members: members.map((member) => ({
      id: member.id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
    })),
  };
}
