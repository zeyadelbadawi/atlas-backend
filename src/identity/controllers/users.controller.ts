/**
 * UsersController — `/users/me*` (master plan §10: "Users (self) |
 * `/users/me*` | session | `PATCH /users/me` accepts only
 * `{name?, avatar?}`"). Every route requires a valid access token.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from '../services/users.service';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { UpdatePreferencesDto } from '../dto/update-preferences.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { DeleteAccountDto } from '../dto/delete-account.dto';
import { AccountDeletionService } from '../services/account-deletion.service';
import { DeletionPlanService } from '../services/deletion-plan.service';
import type { DeletionPlan } from '../services/deletion-plan.service';
import type { AccountDeletionReason } from '../services/account-deletion.service';
import type { CurrentUserResponse } from '../dto/contracts';
import { scopeCurrentUserToSession } from '../dto/contracts';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ManagementSessionGuard } from '../guards/management-session.guard';
import { CurrentAuthContext } from '../decorators/auth-context.decorator';
import type { AuthContext } from '../guards/jwt-auth.guard';
import { CredentialCheckRateLimitGuard } from '../guards/credential-check-rate-limit.guard';
import { AccountDeletionChallengeService } from '../services/account-deletion-challenge.service';
import type { AccountDeletionChallengeContract } from '../services/account-deletion-challenge.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accountDeletionService: AccountDeletionService,
    private readonly deletionPlanService: DeletionPlanService,
    private readonly accountDeletionChallengeService: AccountDeletionChallengeService,
  ) {}

  @Get('me')
  async getCurrent(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<CurrentUserResponse> {
    // Launch Stabilization A5 — an academy-website session sees only its academy.
    return scopeCurrentUserToSession(
      await this.usersService.getCurrent(auth.userId),
      auth,
    );
  }

  @Patch('me')
  async updateProfile(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: UpdateProfileDto,
  ): Promise<CurrentUserResponse> {
    return scopeCurrentUserToSession(
      await this.usersService.updateProfile(auth.userId, dto),
      auth,
    );
  }

  @Patch('me/preferences')
  async updatePreferences(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<CurrentUserResponse> {
    return scopeCurrentUserToSession(
      await this.usersService.updatePreferences(auth.userId, dto.preferences),
      auth,
    );
  }

  @Post('me/password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CredentialCheckRateLimitGuard)
  async changePassword(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.usersService.changePassword(
      auth.userId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  /**
   * What deleting this account would actually do, for the CALLER'S OWN
   * account.
   *
   * Same no-`:id` shape as the deletion itself: the subject is the
   * account proved by the access token, so this cannot be turned into a
   * way to enumerate what somebody else owns. Read-only, and deliberately
   * not a gate — `AccountDeletionService` re-derives its own scope when
   * the button is actually pressed, because anything decided here is
   * already stale by then.
   */
  @Get('me/deletion-plan')
  // Launch Stabilization A1 (D1) — never from an academy-website session:
  // deleting the global account also archives every academy it owns.
  @UseGuards(ManagementSessionGuard)
  async getOwnDeletionPlan(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<DeletionPlan> {
    return this.deletionPlanService.buildForUser(auth.userId);
  }

  /**
   * Phase 10.6 — deletes the CALLER'S OWN account.
   *
   * `POST`, not `DELETE`: the request carries a body (confirmation,
   * optional reason and feedback), and DELETE-with-a-body is
   * inconsistently supported by proxies and HTTP clients. The same
   * reasoning as `POST /auth/2fa/disable`.
   *
   * There is no `:id` parameter anywhere on this route. The account
   * deleted is the one proved by the access token, so deleting somebody
   * else's account is not possible by manipulating a value — it is
   * structurally absent. A platform owner is refused by the service.
   */
  /**
   * Authentication audit (Decision 1) — step one of deleting the caller's
   * own account: a code is emailed to the account's verified address.
   * Nothing is deleted. Bound to this account AND this session.
   */
  @Post('me/delete/request')
  @UseGuards(ManagementSessionGuard, CredentialCheckRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async requestAccountDeletion(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<AccountDeletionChallengeContract> {
    return this.accountDeletionChallengeService.issue(auth.userId, auth.sessionId);
  }

  @Post('me/delete')
  // Launch Stabilization A1 (D1) — never from an academy-website session:
  // deleting the global account also archives every academy it owns.
  @UseGuards(ManagementSessionGuard, CredentialCheckRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async deleteOwnAccount(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: DeleteAccountDto,
  ): Promise<{ deleted: boolean; academiesArchived: number }> {
    // Decision 1 — only the emailed code, issued to THIS session, authorises
    // the deletion; it is consumed exactly once before anything is removed.
    await this.accountDeletionChallengeService.consume(
      auth.userId,
      auth.sessionId,
      dto.challengeId,
      dto.code,
    );
    return this.accountDeletionService.deleteOwnAccount(auth.userId, {
      reason: dto.reason as AccountDeletionReason | undefined,
      feedback: dto.feedback,
    });
  }
}
