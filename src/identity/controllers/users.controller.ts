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
import type { CurrentUserResponse } from '../dto/contracts';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentAuthContext } from '../decorators/auth-context.decorator';
import type { AuthContext } from '../guards/jwt-auth.guard';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
}
