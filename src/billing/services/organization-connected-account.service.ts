/**
 * OrganizationConnectedAccountService — read-only, schema/service
 * foundation only (master plan §4.1/§5.8). No onboarding-trigger method
 * exists here — see the repository's own doc comment for why.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationConnectedAccountsRepository } from '../repositories/organization-connected-accounts.repository';
import {
  toOrganizationConnectedAccountResponse,
  type OrganizationConnectedAccountResponse,
} from '../dto/organization-connected-account.contract';

@Injectable()
export class OrganizationConnectedAccountService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationConnectedAccountsRepository: OrganizationConnectedAccountsRepository,
  ) {}

  async getConnectedAccount(
    organizationId: string,
  ): Promise<OrganizationConnectedAccountResponse> {
    const account = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.organizationConnectedAccountsRepository.findByOrganizationId(
          tx,
          organizationId,
        ),
    );
    return toOrganizationConnectedAccountResponse(organizationId, account);
  }
}
