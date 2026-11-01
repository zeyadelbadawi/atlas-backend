/**
 * `POST` / `DELETE /users/me/avatar` — the account's profile photo, set
 * from the mobile app. Its own controller (and module) so the identity
 * module does not take on the media storage dependency.
 */
import {
  Controller,
  Delete,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import type { AuthContext } from '../identity/guards/jwt-auth.guard';
import { CurrentAuthContext } from '../identity/decorators/auth-context.decorator';
import type { CurrentUserResponse } from '../identity/dto/contracts';
import { scopeCurrentUserToSession } from '../identity/dto/contracts';
import { UserAvatarService } from './user-avatar.service';
import type { UploadedAvatarFile } from './user-avatar.service';
import {
  AvatarFileInterceptor,
  AvatarUploadErrorsInterceptor,
} from './avatar-upload.interceptor';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserAvatarController {
  constructor(private readonly userAvatarService: UserAvatarService) {}

  /**
   * Multipart `file`: PNG, JPEG or WebP, at most 5 MB. Kept as a 512 x 512
   * WebP; answers the updated current user. Twenty uploads an hour is
   * plenty for a person choosing a photo.
   */
  @Post('me/avatar')
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @UseInterceptors(AvatarUploadErrorsInterceptor, AvatarFileInterceptor)
  async upload(
    @CurrentAuthContext() auth: AuthContext,
    @UploadedFile() file: UploadedAvatarFile | undefined,
  ): Promise<CurrentUserResponse> {
    return scopeCurrentUserToSession(
      await this.userAvatarService.upload(auth.userId, file),
      auth,
    );
  }

  /** Removes the profile photo; the initials show again. */
  @Delete('me/avatar')
  async remove(@CurrentAuthContext() auth: AuthContext): Promise<CurrentUserResponse> {
    return scopeCurrentUserToSession(
      await this.userAvatarService.remove(auth.userId),
      auth,
    );
  }
}
