/**
 * `GET /organizations/:id` response contract.
 *
 * There is no dedicated bare `Organization` type in the frontend today
 * (see the P2 final report's "SPECIFICATION-UNDEFINED" section) — this
 * shape is taken directly from the master plan §5.2 column definition
 * (`name`, `slug`, `status`, `ownerUserId`, `createdAt`, `updatedAt`),
 * camelCased to match every other response contract in this codebase.
 * Deliberately excludes any membership/role/permission data — that's
 * `OrganizationContext`, derived client-side from `CurrentUser.organizations`,
 * never fetched from this endpoint.
 */
import type { Organization, OrganizationStatus } from '@prisma/client';

export interface OrganizationResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: OrganizationStatus;
  readonly ownerUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toOrganizationResponse(organization: Organization): OrganizationResponse {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    ownerUserId: organization.ownerUserId,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}
