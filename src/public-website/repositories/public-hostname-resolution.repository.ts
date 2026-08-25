/**
 * PublicHostnameResolutionRepository — the SOLE call site of
 * `resolve_public_hostname`, the one `SECURITY DEFINER` function this
 * phase introduces (see the P11 migration's own doc comment for the full
 * justification). Uses `PrismaService` directly — NOT
 * `TenancyContextService.runInTenantContext` — because there is, by
 * definition, no tenant context yet at this exact step: this IS the step
 * that establishes which tenant a public request belongs to. The
 * connection itself remains the ordinary restricted `atlas_app` role
 * (`PrismaService`'s only mode, master plan §7) — the `SECURITY DEFINER`
 * function is what carries elevated privilege internally, never this
 * connection.
 *
 * Parameterized via Prisma's tagged-template `$queryRaw` (never string
 * concatenation) — both inputs are already-normalized, validated strings
 * from `hostname-normalization.util.ts`, but this call site treats them
 * as untrusted regardless, as real SQL-injection hygiene demands.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface ResolvedPublicHostname {
  readonly academyId: string;
  readonly organizationId: string;
  readonly academyName: string;
  readonly academySlug: string;
  readonly academyLogoUrl: string | null;
}

interface ResolvePublicHostnameRow {
  readonly academy_id: string;
  readonly organization_id: string;
  readonly academy_name: string;
  readonly academy_slug: string;
  readonly academy_logo_url: string | null;
}

@Injectable()
export class PublicHostnameResolutionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    hostname: string,
    subdomainLabel: string | null,
  ): Promise<ResolvedPublicHostname | null> {
    const rows = await this.prisma.$queryRaw<ResolvePublicHostnameRow[]>(
      Prisma.sql`SELECT * FROM resolve_public_hostname(${hostname}, ${subdomainLabel})`,
    );
    const row = rows[0];
    if (!row) return null;

    return {
      academyId: row.academy_id,
      organizationId: row.organization_id,
      academyName: row.academy_name,
      academySlug: row.academy_slug,
      academyLogoUrl: row.academy_logo_url,
    };
  }

  /** The narrow academyId → organizationId lookup `getPublishedWebsite`/`getPublishedPages`/`getPublishedPage` need to open a legitimate `runInTenantContext` — see `resolve_academy_organization`'s own doc comment in the P11 migration for why a client-addressable `academyId` is safe here (it only ever unlocks already-`published` data, gated separately on every subsequent query). */
  async resolveAcademyOrganization(academyId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ organization_id: string }[]>(
      Prisma.sql`SELECT * FROM resolve_academy_organization(${academyId})`,
    );
    return rows[0]?.organization_id ?? null;
  }
}
