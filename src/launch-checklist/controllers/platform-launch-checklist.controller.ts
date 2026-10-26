/**
 * PlatformLaunchChecklistController — B3: `platform-launch-checklist`.
 * Guards exactly like `PlatformFoundingAcademiesController`; RLS is the
 * second line (Platform Owner only, reads included).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { LaunchChecklistService } from '../services/launch-checklist.service';
import {
  CreateChecklistItemDto,
  ReorderChecklistDto,
  UpdateChecklistItemDto,
} from '../dto/launch-checklist.dto';
import type {
  LaunchChecklistItemResponse,
  LaunchChecklistResponse,
} from '../dto/launch-checklist.contract';

function actor(request: Request): string {
  return request.authContext!.userId;
}

@Controller('platform-launch-checklist')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformLaunchChecklistController {
  constructor(private readonly service: LaunchChecklistService) {}

  @Get()
  list(@Req() request: Request): Promise<LaunchChecklistResponse> {
    return this.service.list(actor(request));
  }

  @Post()
  create(
    @Req() request: Request,
    @Body() body: CreateChecklistItemDto,
  ): Promise<LaunchChecklistItemResponse> {
    return this.service.create(actor(request), body);
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  reorder(
    @Req() request: Request,
    @Body() body: ReorderChecklistDto,
  ): Promise<LaunchChecklistResponse> {
    return this.service.reorder(actor(request), body);
  }

  @Patch(':id')
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateChecklistItemDto,
  ): Promise<LaunchChecklistItemResponse> {
    return this.service.update(actor(request), id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(actor(request), id);
  }
}
