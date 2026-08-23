/**
 * OrganizationsService — the P2 self-service surface (master plan §21
 * Phase P2). See the P2 final report for why this is deliberately narrow:
 * no frontend `OrganizationService` exists to derive a fuller contract
 * from (`TenantService` is billing/usage, Phase P4/P12 scope;
 * `PlatformOrganizationService` is the cross-tenant Platform Owner view,
 * Phase P15 scope — neither is this phase's).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from './tenancy-context.service';
import { OrganizationsRepository } from '../repositories/organizations.repository';
import { toOrganizationResponse } from '../dto/organization.contract';
import type { OrganizationResponse } from '../dto/organization.contract';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationsRepository: OrganizationsRepository,
  ) {}

  /**
   * Independently re-establishes the RLS tenant context and re-reads the
   * row, rather than trusting the row `OrganizationMembershipGuard` already
   * fetched for its own membership check — this is deliberate: it's what
   * makes RLS a genuinely independent third layer (master plan §7 point 2)
   * instead of a guard-layer decision the database merely rubber-stamps.
   */
  async getById(organizationId: string): Promise<OrganizationResponse> {
    const organization = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.organizationsRepository.findById(tx, organizationId),
    );

    if (!organization) {
      // Structurally unreachable if `OrganizationMembershipGuard` ran first
      // (it already proved a membership row exists in this exact tenant
      // context) — kept as a real check, not an assertion, because a
      // service method must never assume its own guard always precedes it.
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    return toOrganizationResponse(organization);
  }
}
