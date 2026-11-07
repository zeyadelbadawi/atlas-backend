/**
 * PlatformPlansController — `platform-plans/*` (P57).
 *
 * ONE HYPHENATED SEGMENT, matching every sibling Platform-Owner surface
 * (`platform-add-ons`, `platform-users`, `platform-academies`,
 * `platform-zoom`, `platform-subscriptions`). The frontend's
 * `resourcePath()` encodes each segment it is handed, so a slashed
 * resource is unreachable — that is the bug this phase fixed on
 * `platform-subscriptions`, and it is not reintroduced here.
 *
 * `JwtAuthGuard + PlatformOwnerGuard` on the class, the same pairing every
 * platform-owned write surface uses. `PlatformOwnerGuard` re-reads the
 * acting user's real `is_platform_owner` column per request rather than
 * trusting a token claim, so hiding the nav entry is never what protects
 * this. `plans` carries no RLS by deliberate, pre-existing design (like
 * `add_ons`/`trial_policy`/`platform_settings`) — the guard is the boundary.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformPlansService } from '../services/platform-plans.service';
import type { PlanLimitImpactResponse } from '../services/platform-plans.service';
import { PlanHistoryService } from '../services/plan-history.service';
import type { PlanHistoryEntryResponse } from '../services/plan-history.service';
import {
  ArchivePlanDto,
  CreatePlanDto,
  RestorePlanDto,
  UpdatePlanDto,
} from '../dto/update-plan.dto';
import { PlatformPlanQueryDto } from '../dto/platform-plan-query.dto';
import type { PlatformPlanRow } from '../dto/platform-plan.contract';
import { PreviewPlanNoticeDto } from '../dto/preview-plan-notice.dto';
import type { PlanChangeNoticePreview } from '../services/plan-change-notice.service';
import { PreviewPlanLimitsDto } from '../dto/preview-plan-limits.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { PlanResponse } from '../../plans/dto/plan.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('platform-plans')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformPlansController {
  constructor(
    private readonly platformPlansService: PlatformPlansService,
    private readonly planHistoryService: PlanHistoryService,
  ) {}

  /**
   * Item 9 (plan management) — every plan (listed, hidden, archived) with
   * its subscriber counts. Declared before the `:key` routes.
   */
  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformPlanQueryDto,
  ): Promise<PaginatedResult<PlatformPlanRow>> {
    return this.platformPlansService.list(auth.userId, query);
  }

  @Post()
  async create(
    @CurrentAuthContext() auth: AuthContext,
    @Body() body: CreatePlanDto,
  ): Promise<PlanResponse> {
    return this.platformPlansService.create(auth.userId, body);
  }

  @Patch(':key')
  async update(
    @CurrentAuthContext() auth: AuthContext,
    @Param('key') key: string,
    @Body() body: UpdatePlanDto,
  ): Promise<PlanResponse> {
    return this.platformPlansService.update(auth.userId, key, body);
  }

  /** Item 9 (plan management) — bring an archived plan back. */
  @Post(':key/restore')
  @HttpCode(HttpStatus.OK)
  async restore(
    @CurrentAuthContext() auth: AuthContext,
    @Param('key') key: string,
    @Body() body: RestorePlanDto,
  ): Promise<PlanResponse> {
    return this.platformPlansService.restore(auth.userId, key, body);
  }

  @Post(':key/archive')
  async archive(
    @CurrentAuthContext() auth: AuthContext,
    @Param('key') key: string,
    @Body() body: ArchivePlanDto,
  ): Promise<PlanResponse> {
    return this.platformPlansService.archive(auth.userId, key, body);
  }

  /**
   * Dry-run impact of a proposed limit set. A POST because it carries a
   * body, but it writes nothing — the Platform Owner is shown who would be
   * over the new limits BEFORE they commit, and may still proceed.
   */
  @Post(':key/limits/preview')
  // 200, not Nest's default 201: this creates nothing. A POST only because
  // the proposed limit set travels in a body.
  @HttpCode(HttpStatus.OK)
  async previewLimits(
    @CurrentAuthContext() auth: AuthContext,
    @Param('key') key: string,
    @Body() body: PreviewPlanLimitsDto,
  ): Promise<PlanLimitImpactResponse> {
    return this.platformPlansService.previewLimitImpact(auth.userId, key, body.limits);
  }

  /**
   * B8 (UX audit) V08 — how many organizations a proposed price or limit
   * change will email, shown in the editor's confirmation before saving.
   * A dry run (200, writes nothing); a POST only because the proposal
   * travels in a body.
   */
  @Post(':key/notice-preview')
  @HttpCode(HttpStatus.OK)
  async previewNotice(
    @CurrentAuthContext() auth: AuthContext,
    @Param('key') key: string,
    @Body() body: PreviewPlanNoticeDto,
  ): Promise<PlanChangeNoticePreview> {
    return this.platformPlansService.previewNotice(auth.userId, key, body);
  }

  /**
   * Administrative change history for one plan, read from the audit log.
   *
   * Paginated from the start: a long-lived plan accumulates an unbounded
   * number of entries, and the audit table is already indexed by
   * `[targetType, targetId]` for exactly this lookup.
   */
  @Get(':key/history')
  async history(
    @CurrentAuthContext() auth: AuthContext,
    @Param('key') key: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlanHistoryEntryResponse>> {
    return this.planHistoryService.listForPlan(auth.userId, key, query);
  }
}
