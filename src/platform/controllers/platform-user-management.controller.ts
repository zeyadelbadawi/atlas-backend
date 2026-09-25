/**
 * PlatformUserManagementController — `platform-user-management`, the
 * Platform Owner's administrative actions ON a user.
 *
 * WHY THIS IS NOT ON `PlatformUsersController`. That controller is the
 * read-only directory, and its service and frontend types carry explicit
 * comments warning against inventing user-management mutations. Rather
 * than quietly contradict that note by adding a DELETE beside its GETs,
 * the mutating capability lives on its own resource with its own guards,
 * so the read surface stays exactly as narrow as it was documented to be
 * and the destructive surface is impossible to reach by accident. (The
 * owner reversed that read-only constraint deliberately on 25 Sep 2026;
 * the reversal is recorded in the decision log rather than implied by
 * the code.)
 *
 * Flat hyphenated resource, never a slashed one: `BaseService
 * .resourcePath()` runs `encodeURIComponent` over every segment, so
 * `platform/user-management` would be requested as `platform%2Fuser-
 * management` and 404. That was a real production bug once (fixed in
 * `94a65fe`) and the convention exists to stop it recurring.
 *
 * AUTHORIZATION. `PlatformOwnerGuard` re-reads `users.is_platform_owner`
 * from the database on every request — it is never a token claim, and no
 * organization role can imply it. `AccountDeletionService` then re-checks
 * the same fact itself before acting, because this is the most
 * destructive call in the product and a controller decorator is one edit
 * away from being deleted.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { AccountDeletionService } from '../../identity/services/account-deletion.service';
import type { AccountDeletionReason } from '../../identity/services/account-deletion.service';
import { DeletionPlanService } from '../../identity/services/deletion-plan.service';
import type { DeletionPlan } from '../../identity/services/deletion-plan.service';
import { DeleteAccountDto } from '../../identity/dto/delete-account.dto';

@Controller('platform-user-management')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformUserManagementController {
  constructor(
    private readonly accountDeletionService: AccountDeletionService,
    private readonly deletionPlanService: DeletionPlanService,
  ) {}

  /**
   * What deleting this user would destroy, keep and revoke.
   *
   * The same plan the account holder would see for themselves, built by
   * the same service — an operator must not be shown a different summary
   * of the same act. Read-only, and not a gate: the deletion re-derives
   * its own scope, so a plan fetched minutes ago cannot authorise
   * anything.
   */
  @Get(':userId/deletion-plan')
  async getDeletionPlan(@Param('userId') userId: string): Promise<DeletionPlan> {
    return this.deletionPlanService.buildForUser(userId);
  }

  /**
   * Deletes the user, with the identical semantics as if they had deleted
   * themselves.
   *
   * `POST`, not `DELETE`, for the reason Phase 10.6 already settled for
   * self-deletion: the request carries a body (reason and feedback), and
   * DELETE-with-a-body is inconsistently supported by proxies and HTTP
   * clients. Both doors reach one service method, so the two paths cannot
   * drift into producing different data states.
   */
  @Post(':userId/delete')
  @HttpCode(HttpStatus.OK)
  async deleteUser(
    @CurrentAuthContext() auth: AuthContext,
    @Param('userId') userId: string,
    @Body() dto: DeleteAccountDto,
  ): Promise<{ deleted: boolean; academiesArchived: number }> {
    return this.accountDeletionService.deleteUserAsPlatformOwner(auth.userId, userId, {
      reason: dto.reason as AccountDeletionReason | undefined,
      feedback: dto.feedback,
    });
  }
}
