/**
 * Atlas mobile app (B1) — the caller's own push devices. No user id in any
 * path: always the token's own account; `:id` is scoped to it.
 */
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import type { AuthContext } from '../identity/guards/jwt-auth.guard';
import { CurrentAuthContext } from '../identity/decorators/auth-context.decorator';
import { RegisterPushDeviceDto } from './dto/register-push-device.dto';
import { PushDevicesService } from './push-devices.service';
import type { PushDeviceResponse } from './push-devices.service';

@Controller('users/me/push-devices')
@UseGuards(JwtAuthGuard)
export class PushDevicesController {
  constructor(private readonly devices: PushDevicesService) {}

  @Put()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  register(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: RegisterPushDeviceDto,
  ): Promise<PushDeviceResponse> {
    return this.devices.register(auth, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.devices.remove(auth.userId, id);
  }
}
