import { Module } from '@nestjs/common';
import { MobileConfigController } from './mobile-config.controller';

/** The Atlas mobile app's own endpoints (docs/mobile/MOBILE_APP_BACKEND.md). */
@Module({ controllers: [MobileConfigController] })
export class MobileModule {}
