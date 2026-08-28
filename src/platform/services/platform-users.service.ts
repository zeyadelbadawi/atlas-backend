/**
 * PlatformUsersService — `GET /platform-users`/`GET /platform-users/:id`
 * (master plan §21 Phase P15), the Platform Owner's cross-tenant,
 * read-only user directory. `users` carries no RLS at all (see
 * `PlatformUsersRepository`'s own doc comment) — `PlatformOwnerGuard` at
 * the controller is the real, sole authorization boundary this surface
 * relies on. `organizationMemberships` reuses `UserOrganizationsService.
 * getMembershipsForUser` (P2's own `CurrentUser` projection logic)
 * verbatim, for the TARGET user's own id — the identical "resolve the
 * target, delegate into existing scoped logic" pattern this whole phase
 * uses elsewhere, needing no new RLS policy for this specific read (the
 * existing `organization_memberships_self_select` policy already grants
 * it, since the delegated call runs under the TARGET user's own
 * `runInUserContext`, not the platform owner's).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { UserOrganizationsService } from '../../tenancy/services/user-organizations.service';
import { PlatformUsersRepository } from '../repositories/platform-users.repository';
import {
  toPlatformUserDetailResponse,
  toPlatformUserSummaryResponse,
} from '../dto/platform-user.contract';
import type {
  PlatformUserDetailResponse,
  PlatformUserSummaryResponse,
} from '../dto/platform-user.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

@Injectable()
export class PlatformUsersService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly platformUsersRepository: PlatformUsersRepository,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly userOrganizationsService: UserOrganizationsService,
  ) {}

  async listUsers(
    platformOwnerId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformUserSummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.platformUsersRepository.findMany({
      search: query.search,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // One batched `GROUP BY` for the whole page's `organizationCount`
    // column (master plan §27's N+1-avoidance), not one query per row.
    const countsByUserId = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.organizationMembershipsRepository.countManyForUsers(
          tx,
          items.map((user) => user.id),
        ),
    );

    return {
      items: items.map((user) =>
        toPlatformUserSummaryResponse(user, countsByUserId.get(user.id) ?? 0),
      ),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getUser(userId: string): Promise<PlatformUserDetailResponse> {
    const user = await this.platformUsersRepository.findById(userId);
    if (!user) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    const organizationMemberships =
      await this.userOrganizationsService.getMembershipsForUser(userId);

    return toPlatformUserDetailResponse(user, organizationMemberships);
  }
}
