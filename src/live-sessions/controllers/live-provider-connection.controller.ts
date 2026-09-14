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
  Body,
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
import { ConnectZoomDto } from '../dto/connect-zoom.dto';

/** Academy configuration, not course management. */
const CONFIGURE_PERMISSION = 'academy.configure';

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

  @Post(':id/live-sessions/connection')
  @HttpCode(HttpStatus.OK)
  async connect(@Req() request: Request, @Body() body: ConnectZoomDto) {
    const { academyId, organizationId } = request.academyContext!;
    this.assertCanConfigure(request);

    const connection = await this.connectionService.connect(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );

    return { status: connection.status, connectedAt: connection.connectedAt };
  }

  /** Re-checks stored credentials against Zoom and records the result. */
  @Post(':id/live-sessions/connection/check')
  @HttpCode(HttpStatus.OK)
  async check(@Req() request: Request) {
    const { academyId, organizationId } = request.academyContext!;
    this.assertCanConfigure(request);
    return this.connectionService.checkHealth(academyId, organizationId);
  }

  @Delete(':id/live-sessions/connection')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Req() request: Request) {
    const { academyId, organizationId } = request.academyContext!;
    this.assertCanConfigure(request);

    await this.connectionService.disconnect(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
    return { status: 'not_connected' as const };
  }

  private assertCanConfigure(request: Request): void {
    const permissions = request.academyContext?.organizationPermissions ?? [];
    if (!permissions.includes(CONFIGURE_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }
  }
}
