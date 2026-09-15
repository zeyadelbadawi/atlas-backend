/**
 * Zoom connection management — academy-scoped.
 *
 * AUTHORIZATION. `AcademyScopeGuard` establishes the tenant, then
 * `academy.configure` is required: connecting a provider is academy
 * configuration, not course work, so an instructor who may run sessions
 * still cannot rebind the academy's Zoom account.
 *
 * NO CREDENTIAL IS EVER RETURNED. `GET` reports health only. There is
 * deliberately no "show me the current credentials" endpoint — a secret
 * that can be read back out of the UI is a secret that ends up in a
 * screenshot.
 */
import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { LiveProviderConnectionService } from '../services/live-provider-connection.service';

/**
 * Connection management is OWNER-ONLY.
 *
 * It used to be `academy.configure`, which a Manager holds — so a Manager
 * could rebind the academy's Zoom account. Connecting, re-checking,
 * disconnecting and changing the connected account all activate or
 * deactivate Live Sessions for the whole academy and bind a CUSTOMER's
 * Zoom account, which puts them in the owner-exclusive tier beside
 * billing and add-on lifecycle rather than with day-to-day academy
 * settings.
 *
 * `tenant.addon.view` is reused rather than a new string invented: it is
 * already owner-exclusive (no `tenant.*` string appears in
 * `ORGANIZATION_MANAGER_PERMISSIONS`) and it is already present on every
 * existing owner membership. A new string would be absent from every
 * stored `organization_memberships.permissions` row and would lock every
 * current owner out until a backfill ran.
 */
const OWNER_CONNECT_PERMISSION = 'tenant.addon.view';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class LiveProviderConnectionController {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly connectionService: LiveProviderConnectionService,
  ) {}

  /** Health only — never credentials. */
  @Get(':id/live-sessions/connection')
  async get(@Req() request: Request) {
    const { academyId, organizationId } = request.academyContext!;

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const connection = await tx.academyLiveProviderConnection.findUnique({
        where: { academyId },
        select: {
          status: true,
          providerKey: true,
          externalAccountId: true,
          lastCheckedAt: true,
          connectedAt: true,
        },
      });

      return {
        status: connection?.status ?? 'not_connected',
        providerKey: connection?.providerKey ?? 'zoom',
        // The Zoom ACCOUNT ID is not a secret and is genuinely useful for
        // confirming which account is attached. The client id, client
        // secret, SDK secret and webhook token never appear.
        externalAccountId: connection?.externalAccountId ?? null,
        lastCheckedAt: connection?.lastCheckedAt ?? null,
        connectedAt: connection?.connectedAt ?? null,
      };
    });
  }

  /** Re-checks stored credentials against Zoom and records the result. */
  @Post(':id/live-sessions/connection/check')
  @HttpCode(HttpStatus.OK)
  async check(@Req() request: Request) {
    const { academyId, organizationId } = request.academyContext!;
    this.assertOwner(request);
    return this.connectionService.checkHealth(academyId, organizationId);
  }

  @Delete(':id/live-sessions/connection')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Req() request: Request) {
    const { academyId, organizationId } = request.academyContext!;
    this.assertOwner(request);

    await this.connectionService.disconnect(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
    return { status: 'not_connected' as const };
  }

  private assertOwner(request: Request): void {
    const permissions = request.academyContext?.organizationPermissions ?? [];
    if (!permissions.includes(OWNER_CONNECT_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }
  }
}
