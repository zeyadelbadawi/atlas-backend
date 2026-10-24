/**
 * `GET /public/mobile/config` — what the Atlas mobile app needs to know
 * before anything else: is this app version still supported, where the
 * store pages are, and whether the service is in maintenance.
 *
 * Public and anonymous on purpose: the app asks before anyone signs in, on
 * any host (platform or academy). It returns only values the operator set
 * in the environment — nothing per user, per academy or internal. Every
 * value is optional; unset means "all versions supported, no links, no
 * maintenance". The web never calls it.
 */
import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

export interface MobilePlatformConfig {
  /** Older versions must update before they can be used. `0.0.0` = none. */
  readonly minimumVersion: string;
  /** The newest published version, for an optional "update available". */
  readonly latestVersion: string | null;
  readonly storeUrl: string | null;
}

export interface MobileConfigResponse {
  readonly ios: MobilePlatformConfig;
  readonly android: MobilePlatformConfig;
  readonly maintenance: boolean;
}

@ApiTags('mobile')
@Controller('public/mobile')
export class MobileConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get('config')
  // Short shared cache: a version bump reaches every app within a minute.
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Mobile app: supported versions, store links, maintenance.' })
  getConfig(): MobileConfigResponse {
    return {
      ios: this.platform('IOS'),
      android: this.platform('ANDROID'),
      maintenance: this.config.get<string>('MOBILE_MAINTENANCE_MODE') === 'true',
    };
  }

  private platform(key: 'IOS' | 'ANDROID'): MobilePlatformConfig {
    return {
      minimumVersion: this.config.get<string>(`MOBILE_MIN_VERSION_${key}`) ?? '0.0.0',
      latestVersion: this.config.get<string>(`MOBILE_LATEST_VERSION_${key}`) ?? null,
      storeUrl: this.config.get<string>(`MOBILE_STORE_URL_${key}`) ?? null,
    };
  }
}
