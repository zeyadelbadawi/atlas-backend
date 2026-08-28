/**
 * NotificationsController — `notifications` (master plan §21 Phase P17),
 * matching `NotificationService` (atlas frontend)'s resource exactly.
 * Every route requires a valid session (`JwtAuthGuard`) — no role/
 * permission gate beyond authentication, since every route is
 * self-scoped by construction (master plan §10: "Notifications |
 * `/notifications*` | session | —").
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
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { NotificationsService } from '../services/notifications.service';
import { ListNotificationsQueryDto } from '../dto/list-notifications-query.dto';
import { NotificationPreferencesDto } from '../../identity/dto/update-preferences.dto';
import type {
  NotificationResponse,
  NotificationSummaryResponse,
} from '../dto/notification.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedResult<NotificationResponse>> {
    return this.notificationsService.listNotifications(auth.userId, query);
  }

  @Get('summary')
  async getSummary(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<NotificationSummaryResponse> {
    return this.notificationsService.getSummary(auth.userId);
  }

  @Get('preferences')
  async getPreferences(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<NotificationPreferencesDto> {
    return this.notificationsService.getPreferences(auth.userId);
  }

  @Patch('preferences')
  async updatePreferences(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: NotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    return this.notificationsService.updatePreferences(auth.userId, dto);
  }

  @Patch(':id/read')
  async markAsRead(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<NotificationResponse> {
    return this.notificationsService.markAsRead(auth.userId, id);
  }

  @Post('read-all')
  async markAllAsRead(@CurrentAuthContext() auth: AuthContext): Promise<void> {
    await this.notificationsService.markAllAsRead(auth.userId);
  }
}
