/**
 * `GET/PATCH /users/me/communication-preferences` — self-scoped by
 * construction (the user id comes from the verified JWT, never the
 * client), matching `NotificationsController`'s posture.
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { CommunicationPreferencesService } from '../services/communication-preferences.service';
import { UpdateCommunicationPreferencesDto } from '../dto/update-communication-preferences.dto';
import type { CommunicationPreferences } from '../services/communication-preferences.util';

@Controller('users/me/communication-preferences')
@UseGuards(JwtAuthGuard)
export class CommunicationPreferencesController {
  constructor(private readonly preferences: CommunicationPreferencesService) {}

  @Get()
  get(@CurrentAuthContext() auth: AuthContext): Promise<CommunicationPreferences> {
    return this.preferences.get(auth.userId);
  }

  @Patch()
  update(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: UpdateCommunicationPreferencesDto,
  ): Promise<CommunicationPreferences> {
    return this.preferences.update(auth.userId, dto);
  }
}
