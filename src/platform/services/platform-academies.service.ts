/**
 * PlatformAcademiesService — `GET /platform-academies`/`GET
 * /platform-academies/:id` (master plan §21 Phase P15), the Platform
 * Owner's cross-tenant academy console. Every read runs under
 * `TenancyContextService.runInUserContext(platformOwnerId)`, relying on
 * the additive `_platform_select` RLS policies the P15 migration adds to
 * `academies`/`academy_members`/`courses`/`domain_connections`/
 * `website_configurations` — never a second, ungated query path.
 * `provisioningStatus` reuses `ProvisioningRequestsRepository` (P14)
 * verbatim (already `_platform_select`-protected).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { ProvisioningRequestsRepository } from '../../provisioning/repositories/provisioning-requests.repository';
import { WebsiteConfigurationRepository } from '../../website/repositories/website-configuration.repository';
import { DomainConnectionsRepository } from '../../domain/repositories/domain-connections.repository';
import { PLATFORM_DETAIL_MEMBER_CAP } from '../../tenancy/repositories/organization-memberships.repository';
import {
  toPlatformAcademyDetailResponse,
  toPlatformAcademySummaryResponse,
} from '../dto/platform-academy.contract';
import type {
  PlatformAcademyDetailResponse,
  PlatformAcademySummaryResponse,
} from '../dto/platform-academy.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

@Injectable()
export class PlatformAcademiesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly provisioningRequestsRepository: ProvisioningRequestsRepository,
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
  ) {}

  async listAcademies(
    platformOwnerId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformAcademySummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.academiesRepository.findManyAnyOrganization(tx, {
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    // `ownerName` is deliberately left undefined here — the list page's
    // own columns (name/organization/status/courseCount/memberCount/
    // createdAt, confirmed by reading `PlatformAcademyListPage.tsx`
    // directly) never render it, and resolving it per row would be
    // exactly the N+1 master plan §27 warns against. The detail view
    // below DOES resolve it — one bounded query, not per-row.
    const responses = items.map((academy) => toPlatformAcademySummaryResponse(academy));

    return {
      items: responses,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getAcademy(
    platformOwnerId: string,
    academyId: string,
  ): Promise<PlatformAcademyDetailResponse> {
    const academy = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.academiesRepository.findByIdAnyOrganization(tx, academyId),
    );
    if (!academy) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    const [
      { items: members },
      courses,
      provisioningRequest,
      websiteConfiguration,
      domainConnection,
    ] = await Promise.all([
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.academyMembersRepository.findManyForAcademy(tx, academyId, {
          skip: 0,
          take: PLATFORM_DETAIL_MEMBER_CAP,
        }),
      ),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.coursesRepository.findRefsForAcademy(
          tx,
          academyId,
          PLATFORM_DETAIL_MEMBER_CAP,
        ),
      ),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.provisioningRequestsRepository.findByAcademyIdAnyOrganization(tx, academyId),
      ),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.websiteConfigurationRepository.findByAcademyId(tx, academyId),
      ),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.domainConnectionsRepository.findByAcademyId(tx, academyId),
      ),
    ]);

    return toPlatformAcademyDetailResponse(
      academy,
      members,
      courses,
      provisioningRequest?.status,
      websiteConfiguration?.status,
      domainConnection?.status,
    );
  }
}
