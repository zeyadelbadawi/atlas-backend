/**
 * The two files phones fetch to let academy links open the Atlas app:
 * Android App Links (`assetlinks.json`) and iOS Universal Links
 * (`apple-app-site-association`). Caddy serves them at
 * `/.well-known/<file>` on every platform and academy host by proxying
 * here (the same pattern as an academy's robots.txt).
 *
 * Public, anonymous, operator-set values only. While a value is unset the
 * file answers 404, so phones simply keep opening links in the browser:
 *   - MOBILE_ANDROID_CERT_SHA256: the signing certificate fingerprint(s)
 *   - MOBILE_IOS_APP_IDS: `<TEAM_ID>.<bundle id>`
 *
 * The paths listed match what the app shows itself (lib/app/deep_links.dart
 * in atlas-mobile). Paying pages stay on the web: the app sells nothing.
 */
import { Controller, Get, Header, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

const DEFAULT_ANDROID_PACKAGE = 'com.atlas.atlas_mobile';
const LOCALE_PREFIXES = ['', '/ar', '/en'] as const;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

@ApiTags('mobile')
@Controller('public/mobile')
export class AppLinksController {
  constructor(private readonly config: ConfigService) {}

  @Get('assetlinks.json')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'Android App Links statement for the Atlas app.' })
  getAssetLinks(): unknown[] {
    const fingerprints = list(this.config.get<string>('MOBILE_ANDROID_CERT_SHA256'));
    if (fingerprints.length === 0) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name:
            this.config.get<string>('MOBILE_ANDROID_PACKAGE') ?? DEFAULT_ANDROID_PACKAGE,
          sha256_cert_fingerprints: fingerprints.map((f) => f.toUpperCase()),
        },
      },
    ];
  }

  @Get('apple-app-site-association')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'iOS Universal Links association for the Atlas app.' })
  getAppleAssociation(): unknown {
    const appIds = list(this.config.get<string>('MOBILE_IOS_APP_IDS'));
    if (appIds.length === 0) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const components = LOCALE_PREFIXES.flatMap((p) => [
      // Checked in order: the paying pages first, excluded.
      { '/': `${p}/my/purchases*`, exclude: true },
      { '/': `${p}/my/payments*`, exclude: true },
      { '/': `${p}/my/courses/*/checkout*`, exclude: true },
      { '/': `${p}/courses` },
      { '/': `${p}/courses/*` },
      { '/': `${p}/my/*` },
      { '/': `${p}/verify-email` },
      { '/': `${p}/reset-password` },
    ]);
    return { applinks: { details: [{ appIDs: appIds, components }] } };
  }
}
