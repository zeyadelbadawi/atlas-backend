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
import type { AccountDeletionReason } from '../services/account-deletion.service';
import type { CurrentUserResponse } from '../dto/contracts';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentAuthContext } from '../decorators/auth-context.decorator';
import type { AuthContext } from '../guards/jwt-auth.guard';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Get('me')
  async getCurrent(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<CurrentUserResponse> {
    return this.usersService.getCurrent(auth.userId);
  }

  @Patch('me')
  async updateProfile(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: UpdateProfileDto,
  ): Promise<CurrentUserResponse> {
    return this.usersService.updateProfile(auth.userId, dto);
  }

  @Patch('me/preferences')
  async updatePreferences(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<CurrentUserResponse> {
    return this.usersService.updatePreferences(auth.userId, dto.preferences);
  }

  @Post('me/password')
  @HttpCode(HttpStatus.OK)
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
  @Post('me/delete')
  @HttpCode(HttpStatus.OK)
  async deleteOwnAccount(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: DeleteAccountDto,
  ): Promise<{ deleted: boolean; academiesArchived: number }> {
    return this.accountDeletionService.deleteOwnAccount(auth.userId, {
      reason: dto.reason as AccountDeletionReason | undefined,
      feedback: dto.feedback,
    });
  }
}
