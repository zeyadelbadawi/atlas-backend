/**
 * PlatformAcademiesController — `platform-academies`/`platform-academies/:id`
 * (master plan §21 Phase P15), matching `PlatformAcademyService` (atlas
 * frontend)'s own deliberately distinct resource name exactly — never the
 * tenant-scoped `academies` path `AcademiesController` (P3) already owns.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformAcademiesService } from '../services/platform-academies.service';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type {
  PlatformAcademyDetailResponse,
  PlatformAcademySummaryResponse,
} from '../dto/platform-academy.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('platform-academies')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformAcademiesController {
  constructor(private readonly platformAcademiesService: PlatformAcademiesService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformAcademySummaryResponse>> {
    return this.platformAcademiesService.listAcademies(auth.userId, query);
  }

  @Get(':id')
  async getById(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<PlatformAcademyDetailResponse> {
    return this.platformAcademiesService.getAcademy(auth.userId, id);
  }
}
