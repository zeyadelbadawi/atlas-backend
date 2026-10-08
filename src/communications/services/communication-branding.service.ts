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
import { EmailLogoService } from './email-logo.service';

export interface ResolvedBranding {
  readonly branding: BrandingContext;
  /** The host links are built on; `null` means the platform URL. */
  readonly host: string | null;
  /**
   * ATO review F4 — the host credential-carrying links are built on: the
   * academy's Atlas subdomain, never a tenant-controlled custom domain.
   * Absent for platform branding (links then use the platform URL).
   */
  readonly credentialHost?: string | null;
  readonly academyLanguage: string | null;
  readonly academyTimezone: string | null;
}

@Injectable()
export class CommunicationBrandingService {
  private readonly platformName: string;

  constructor(
    configService: ConfigService,
    private readonly links: LinkBuilderService,
    private readonly emailLogo: EmailLogoService,
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
   * W3 — decouples the academy's VISUAL IDENTITY (name + logo) from the
   * catalogue's `branding` mode, which really picks the link HOST
   * ("branding picks the host, not merely the logo"). Before this, every
   * `branding: 'platform'` key showed no academy logo at all — including
   * emails a person reads as coming from their academy (an invitation, a
   * roster approval request) — because the host rule and the identity rule
   * were one field.
   *
   * `identity` defaults to the mode, so nothing changes unless a catalogue
   * entry opts in (`identity: 'academy'`). With identity `academy` and an
   * academy attached, the email shows that academy's name and email-safe
   * logo; `host` still follows `mode`, so links keep landing where the
   * catalogue says they must.
   *
   * The logo is never the stored value: it is the platform-host URL of the
   * public logo route (`EmailLogoService.forEmail`) with explicit display
   * size, or absent (the layout then prints the academy name).
   */
  async resolve(
    tx: Prisma.TransactionClient,
    mode: 'academy' | 'platform',
    academyId: string | null,
    identity: 'academy' | 'platform' = mode,
  ): Promise<ResolvedBranding> {
    if (!academyId) return this.platform();
    const academy = await tx.academy.findUnique({
      where: { id: academyId },
      select: { name: true, logoUrl: true, language: true, timezone: true },
    });
    if (!academy) return this.platform();
    const host = mode === 'academy' ? await this.links.academyHost(tx, academyId) : null;
    const credentialHost =
      mode === 'academy' ? await this.links.academyAtlasHost(tx, academyId) : null;
    if (identity === 'platform') {
      return {
        ...this.platform(),
        academyLanguage: academy.language,
        academyTimezone: academy.timezone,
      };
    }
    const logo = await this.emailLogo
      .forEmail(academyId, academy.logoUrl)
      .catch(() => undefined);
    return {
      branding: {
        academyName: academy.name,
        academyLogoUrl: logo?.url,
        academyLogoWidth: logo?.width,
        academyLogoHeight: logo?.height,
        academyHost: host ?? undefined,
        platformName: this.platformName,
        platformUrl: this.links.platform('/'),
      },
      host,
      credentialHost,
      academyLanguage: academy.language,
      academyTimezone: academy.timezone,
    };
  }
}
