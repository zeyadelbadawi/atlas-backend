/**
 * PlatformCommunicationsController — C7, the Platform Owner's operational
 * view of the email pipeline and the suppression list.
 *
 * Three guards, the same trio every platform-owner surface uses:
 * authenticated, on the management surface, and actually the Platform
 * Owner. The service then runs its reads under the CALLER's own user
 * context, so RLS proves the same thing a second time and independently —
 * the two-gate rule. There is no tenant-scoped variant of this route: an
 * academy owner has no business reading another tenant's bounce list.
 */
import { Controller, Delete, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformCommunicationsHealthService } from '../services/platform-communications-health.service';
import { SuppressionService } from '../services/suppression.service';
import { PlatformCommunicationsQueryDto } from '../dto/platform-communications-query.dto';
import type { PlatformCommunicationsHealthResponse } from '../dto/platform-communications-health.contract';

/** What a suppression row looks like on the wire: hashed address, never the address. */
export interface SuppressionRowResponse {
  readonly id: string;
  readonly emailHash: string;
  readonly reason: string;
  readonly source: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

@Controller('platform-communications')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformCommunicationsController {
  constructor(
    private readonly health: PlatformCommunicationsHealthService,
    private readonly suppressions: SuppressionService,
  ) {}

  /**
   * Pipeline health for the trailing window. `outbox.oldestPendingSeconds`
   * is the one to watch: a climbing number means the dispatcher has
   * stopped draining, which otherwise looks identical to a quiet week.
   */
  @Get('health')
  async getHealth(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformCommunicationsQueryDto,
  ): Promise<PlatformCommunicationsHealthResponse> {
    return this.health.getHealth(auth.userId, query.days ?? 30);
  }

  /**
   * The suppression list, paginated. Addresses are stored and returned
   * HASHED — an operator needs to know how many people bounced and why,
   * and to lift a block, neither of which requires handing back a list of
   * real email addresses from this endpoint.
   */
  @Get('suppressions')
  async listSuppressions(
    @Query() query: PlatformCommunicationsQueryDto,
  ): Promise<{ items: SuppressionRowResponse[]; nextCursor: string | null }> {
    const limit = query.limit ?? 50;
    const rows = await this.suppressions.list({ limit, cursor: query.cursor });
    return {
      items: rows.map((row) => ({
        id: row.id,
        emailHash: row.emailHash,
        reason: row.reason,
        source: row.source ?? null,
        note: row.note ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Lift a suppression. The address is supplied by the operator (they are
   * acting on a specific person's support request), normalised and hashed
   * by the service to find the row — the same canonicalisation the
   * webhook used to create it, so "User@x.com " matches "user@x.com".
   *
   * Reported as `{ lifted: false }` rather than 404 when nothing matched:
   * the operator's intent — "this address must not be blocked" — is
   * satisfied either way, and a 404 here would leak whether a given
   * address is on the list to anyone who can call it.
   */
  @Delete('suppressions/:email')
  async unsuppress(@Param('email') email: string): Promise<{ lifted: boolean }> {
    return { lifted: await this.suppressions.unsuppress(email) };
  }
}
