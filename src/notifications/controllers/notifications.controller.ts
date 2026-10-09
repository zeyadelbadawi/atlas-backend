/**
 * NotificationsController — `notifications` (master plan §21 Phase P17),
 * matching `NotificationService` (atlas frontend)'s resource exactly.
 * Every route requires a valid session (`JwtAuthGuard`) — no role/
 * permission gate beyond authentication, since every route is
 * self-scoped by construction (master plan §10: "Notifications |
 * `/notifications*` | session | —").
 *
 * Notification context isolation — and context-scoped: the feed, the
 * unread count, mark-read and mark-all-read only ever see the context the
 * SESSION belongs to (`NotificationScopeService`); no parameter selects
 * another one.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { NotificationsService } from '../services/notifications.service';
import { NotificationScopeService } from '../services/notification-scope.service';
import { ListNotificationsQueryDto } from '../dto/list-notifications-query.dto';
import { NotificationPreferencesDto } from '../../identity/dto/update-preferences.dto';
import type {
  NotificationResponse,
  NotificationSummaryResponse,
} from '../dto/notification.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { MarkAllReadDto } from '../dto/mark-all-read.dto';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationScopeService: NotificationScopeService,
  ) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Req() request: Request,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedResult<NotificationResponse>> {
    const scope = await this.notificationScopeService.resolve(request);
    return this.notificationsService.listNotifications(auth.userId, scope, query);
  }

  @Get('summary')
  async getSummary(
    @CurrentAuthContext() auth: AuthContext,
    @Req() request: Request,
  ): Promise<NotificationSummaryResponse> {
    const scope = await this.notificationScopeService.resolve(request);
    return this.notificationsService.getSummary(auth.userId, scope);
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
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<NotificationResponse> {
    const scope = await this.notificationScopeService.resolve(request);
    return this.notificationsService.markAsRead(auth.userId, scope, id);
  }

  @Post('read-all')
  async markAllAsRead(
    @CurrentAuthContext() auth: AuthContext,
    @Req() request: Request,
    @Body() body: MarkAllReadDto,
  ): Promise<void> {
    const scope = await this.notificationScopeService.resolve(request);
    await this.notificationsService.markAllAsRead(
      auth.userId,
      scope,
      body?.before ? new Date(body.before) : undefined,
    );
  }
}
