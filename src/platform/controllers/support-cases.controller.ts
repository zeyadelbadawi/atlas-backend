/**
 * SupportCasesController — `support-cases/*` (master plan §21 Phase P15),
 * matching `SupportService` (atlas frontend) exactly. All four routes are
 * `PlatformOwnerGuard`-gated — the frontend's own `platform.support.manage`
 * inline permission-string check (`PlatformSupportDetailPage.tsx`) is a
 * confirmed, pre-existing, out-of-P15-scope gap (see
 * `Reports/ARCHITECTURE.md`'s own P15 entry for the full account: `CurrentUser.
 * permissions` is hard-coded `[]` everywhere in this codebase today, so
 * that check is always `false` for every caller including a genuine
 * Platform Owner — identical to `platform.payment.approve`/`.reject`'s own
 * P13 precedent, not something this phase invented or is positioned to
 * fix without inventing a permission-string catalog master plan §9
 * explicitly forbids). Server-side authorization here is real and
 * complete regardless: `PlatformOwnerGuard` re-reads `is_platform_owner`
 * from the database on every request.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { SupportCasesService } from '../services/support-cases.service';
import { ListSupportCasesQueryDto } from '../dto/list-support-cases-query.dto';
import { UpdateSupportCaseStatusDto } from '../dto/update-support-case-status.dto';
import { PostSupportCaseReplyDto } from '../dto/post-support-case-reply.dto';
import type {
  SupportCaseDetailResponse,
  SupportCaseSummaryResponse,
} from '../dto/support-case.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('support-cases')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class SupportCasesController {
  constructor(private readonly supportCasesService: SupportCasesService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListSupportCasesQueryDto,
  ): Promise<PaginatedResult<SupportCaseSummaryResponse>> {
    return this.supportCasesService.listCases(auth.userId, query);
  }

  @Get(':id')
  async getById(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<SupportCaseDetailResponse> {
    return this.supportCasesService.getCase(auth.userId, id);
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
    @Body() payload: UpdateSupportCaseStatusDto,
  ): Promise<SupportCaseDetailResponse> {
    return this.supportCasesService.updateStatus(auth.userId, id, payload);
  }

  @Post(':id/messages')
  async postReply(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
    @Body() payload: PostSupportCaseReplyDto,
  ): Promise<SupportCaseDetailResponse> {
    return this.supportCasesService.postReply(auth.userId, id, payload);
  }
}
