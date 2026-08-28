/**
 * PlatformUsersController — `platform-users`/`platform-users/:id` (master
 * plan §21 Phase P15), matching `PlatformUserService` (atlas frontend)'s
 * own deliberately distinct resource name.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformUsersService } from '../services/platform-users.service';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type {
  PlatformUserDetailResponse,
  PlatformUserSummaryResponse,
} from '../dto/platform-user.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('platform-users')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformUsersController {
  constructor(private readonly platformUsersService: PlatformUsersService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformUserSummaryResponse>> {
    return this.platformUsersService.listUsers(auth.userId, query);
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<PlatformUserDetailResponse> {
    return this.platformUsersService.getUser(id);
  }
}
