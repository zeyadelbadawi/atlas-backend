/**
 * PlatformEmailActivityController — W3: the Platform Owner's "Academy Email
 * Activity" page (sidebar: Email & Notifications).
 *
 * The same guard trio as every platform-owner surface — authenticated, on a
 * management session, and actually the Platform Owner — and the service
 * re-proves it through RLS under the caller's own context. There is no
 * tenant variant: an academy's staff do not get a cross-recipient email log
 * from this route. Read-only, so nothing here is audited (the audit
 * catalogue records platform ACTIONS, not reads).
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { AcademyEmailActivityService } from '../services/academy-email-activity.service';
import { AcademyEmailActivityQueryDto } from '../dto/academy-email-activity.dto';
import type {
  EmailActivityPage,
  EmailActivitySummary,
} from '../dto/academy-email-activity.contract';

@Controller('platform-communications/email-activity')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformEmailActivityController {
  constructor(private readonly activity: AcademyEmailActivityService) {}

  /** Newest-first, keyset-paginated rows for one academy (or all academies). */
  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: AcademyEmailActivityQueryDto,
  ): Promise<EmailActivityPage> {
    return this.activity.list(auth.userId, query);
  }

  /** Counts by honest status for the window, plus the busiest academies. */
  @Get('summary')
  async summary(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: AcademyEmailActivityQueryDto,
  ): Promise<EmailActivitySummary> {
    return this.activity.summary(auth.userId, query);
  }
}
