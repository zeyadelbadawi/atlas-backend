/**
 * Loads the branding context an email renders under — the academy's name,
 * logo and canonical host when the catalogue says `branding: 'academy'`
 * and an academy is attached; the platform otherwise. Runs in the
 * caller's (platform-owner) transaction for the RLS-scoped reads.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { CommunicationsConfig } from '../../config/configuration';
import type { BrandingContext } from '../templates/layout';
import { LinkBuilderService } from './link-builder.service';

export interface ResolvedBranding {
  readonly branding: BrandingContext;
  /** The host links are built on; `null` means the platform URL. */
  readonly host: string | null;
  readonly academyLanguage: string | null;
  readonly academyTimezone: string | null;
}

@Injectable()
export class CommunicationBrandingService {
  private readonly platformName: string;

  constructor(
    configService: ConfigService,
    private readonly links: LinkBuilderService,
  ) {
    this.platformName =
      configService.getOrThrow<CommunicationsConfig>('communications').platformName;
  }

  platform(): ResolvedBranding {
    return {
      branding: {
        platformName: this.platformName,
        platformUrl: this.links.platform('/'),
      },
      host: null,
      academyLanguage: null,
      academyTimezone: null,
    };
  }

  /**
   * An uploaded logo is a MediaAsset, stored as the app-RELATIVE
   * `/api/v1/public/media/…` path (see `toMediaAssetUrl`). A relative
   * `<img src>` means nothing inside an email, so it is resolved against
   * the academy's own host (which serves that path), else the platform.
   * Absolute URLs and legacy values pass through unchanged.
   */
  private absoluteLogoUrl(
    logoUrl: string | null,
    host: string | null,
  ): string | undefined {
    if (!logoUrl) return undefined;
    if (!logoUrl.startsWith('/') || logoUrl.startsWith('//')) return logoUrl;
    return host ? `https://${host}${logoUrl}` : this.links.platform(logoUrl);
  }

  async resolve(
    tx: Prisma.TransactionClient,
    mode: 'academy' | 'platform',
    academyId: string | null,
  ): Promise<ResolvedBranding> {
    if (!academyId) return this.platform();
    const academy = await tx.academy.findUnique({
      where: { id: academyId },
      select: { name: true, logoUrl: true, language: true, timezone: true },
    });
    if (!academy) return this.platform();
    const host = await this.links.academyHost(tx, academyId);
    if (mode === 'platform') {
      return {
        ...this.platform(),
        academyLanguage: academy.language,
        academyTimezone: academy.timezone,
      };
    }
    return {
      branding: {
        academyName: academy.name,
        academyLogoUrl: this.absoluteLogoUrl(academy.logoUrl, host),
        academyHost: host ?? undefined,
        platformName: this.platformName,
        platformUrl: this.links.platform('/'),
      },
      host,
      academyLanguage: academy.language,
      academyTimezone: academy.timezone,
    };
  }
}
