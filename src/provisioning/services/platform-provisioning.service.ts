/**
 * PlatformProvisioningService — the flat, cross-tenant
 * `/provisioning-requests` console surface matching `PlatformProvisioningService`
 * (atlas frontend) exactly: list/get/retry/cancel, no more. The Provisioning
 * analog of `PlatformCourseOrderPaymentsService` (P13) — a Platform Owner
 * reviews/operates provisioning ACROSS every Organization.
 *
 * Every read here runs under `runInUserContext(reviewerId, ...)`, relying
 * on `provisioning_requests_platform_select`/`provisioning_steps_platform_select`
 * (RLS, gated by `is_platform_owner()`) — never a second, ungated query
 * path. `retryRequest`/`cancelRequest` resolve the request's real
 * `organizationId` first, then delegate into the SAME tenant-scoped write
 * logic `ProvisioningRequestsService` already implements — exactly
 * `PlatformCourseOrderPaymentsService.approvePayment`'s own precedent
 * (`runInTenantAndUserContext`), so no new platform-owner-scoped WRITE RLS
 * policy is needed on `provisioning_requests`: the write still happens
 * under the request's own Organization's tenant context, with the
 * reviewer's user id also active for audit purposes.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../../domain/repositories/domain-connections.repository';
import { ProvisioningRequestsRepository } from '../repositories/provisioning-requests.repository';
import { ProvisioningStepsRepository } from '../repositories/provisioning-steps.repository';
import { ProvisioningRequestsService } from './provisioning-requests.service';
import {
  toProvisioningRequestResponse,
  type ProvisioningRequestResponse,
} from '../dto/provisioning-request.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { ProvisioningRequest } from '@prisma/client';

@Injectable()
export class PlatformProvisioningService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly provisioningRequestsRepository: ProvisioningRequestsRepository,
    private readonly provisioningStepsRepository: ProvisioningStepsRepository,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly provisioningRequestsService: ProvisioningRequestsService,
  ) {}

  async listRequests(
    reviewerId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<ProvisioningRequestResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      reviewerId,
      (tx) =>
        this.provisioningRequestsRepository.findManyAnyOrganization(tx, {
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    const responses = await Promise.all(
      items.map((item) => this.toResponse(reviewerId, item)),
    );

    return {
      items: responses,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getRequest(
    reviewerId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    const request = await this.loadAnyOrThrow(reviewerId, requestId);
    return this.toResponse(reviewerId, request);
  }

  async retryRequest(
    reviewerId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    const request = await this.loadAnyOrThrow(reviewerId, requestId);
    return this.provisioningRequestsService.retryRequest(
      request.organizationId,
      requestId,
    );
  }

  async cancelRequest(
    reviewerId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    const request = await this.loadAnyOrThrow(reviewerId, requestId);
    return this.provisioningRequestsService.cancelRequest(
      request.organizationId,
      requestId,
    );
  }

  private async loadAnyOrThrow(
    reviewerId: string,
    requestId: string,
  ): Promise<ProvisioningRequest> {
    const request = await this.tenancyContextService.runInUserContext(reviewerId, (tx) =>
      this.provisioningRequestsRepository.findByIdAnyOrganization(tx, requestId),
    );
    if (!request) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return request;
  }

  /**
   * `runInTenantAndUserContext(request.organizationId, reviewerId, ...)` —
   * not merely `runInUserContext` — because `subdomain_allocations`/
   * `domain_connections` carry only tenant-scoped SELECT policies (no
   * platform-select variant exists for those P11 tables; see the P14
   * migration's own doc comment for why none was added). Setting the
   * request's own, already platform-authorized `organizationId` as the
   * active tenant context here is legitimate — it is not derived from the
   * reviewer's own membership — mirroring
   * `PlatformCourseOrderPaymentsService.approvePayment`'s identical
   * `runInTenantAndUserContext` precedent.
   */
  private async toResponse(
    reviewerId: string,
    request: ProvisioningRequest,
  ): Promise<ProvisioningRequestResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      request.organizationId,
      reviewerId,
      async (tx) => {
        const steps = await this.provisioningStepsRepository.findAllForRequest(
          tx,
          request.id,
        );
        const subdomain = request.academyId
          ? await this.subdomainAllocationsRepository.findByAcademyId(
              tx,
              request.academyId,
            )
          : null;
        const domainConnection = request.academyId
          ? await this.domainConnectionsRepository.findByAcademyId(tx, request.academyId)
          : null;
        return toProvisioningRequestResponse(request, steps, subdomain, domainConnection);
      },
    );
  }
}
