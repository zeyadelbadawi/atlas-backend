/**
 * WebsiteConfigurationRepository — every method takes a
 * `Prisma.TransactionClient` obtained from
 * `TenancyContextService.runInTenantContext`, matching every other
 * repository in this codebase's established rule. `academyId` doubles as
 * the primary key (§5.10's 1:1 design), so lookups never need a separate
 * `id` parameter.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, WebsiteConfiguration } from '@prisma/client';
import { resolveDefaultLocale } from '../constants/locale.constants';

@Injectable()
export class WebsiteConfigurationRepository {
  findByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsiteConfiguration | null> {
    return tx.websiteConfiguration.findUnique({ where: { academyId } });
  }

  /**
   * The public runtime's ONE eligibility query (master plan §21 P11: "the
   * publication condition part of the database lookup itself," never
   * fetch-then-check) — `status: 'published'` is part of the `WHERE`
   * clause, not a filter applied to the result afterward. Returns `null`
   * for a draft/failed/publishing configuration exactly the same way it
   * returns `null` for a nonexistent one — the public caller can never
   * distinguish "exists but not published" from "does not exist" through
   * this method's return shape alone.
   */
  /**
   * Serializes publishes of one Academy's website (whole site or one page):
   * held to the end of the transaction, so a page publish's slug check and
   * its write cannot interleave with another publish.
   */
  async lockForPublish(tx: Prisma.TransactionClient, academyId: string): Promise<void> {
    await tx.$queryRaw`
      SELECT 1 FROM "website_configurations" WHERE "academy_id" = ${academyId} FOR UPDATE`;
  }

  async findPublishedByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsiteConfiguration | null> {
    const row = await tx.websiteConfiguration.findFirst({
      where: { academyId, status: 'published' },
    });
    return row ? withPublishedSnapshot(row) : null;
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.WebsiteConfigurationCreateInput,
  ): Promise<WebsiteConfiguration> {
    return tx.websiteConfiguration.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    academyId: string,
    data: Prisma.WebsiteConfigurationUpdateInput,
  ): Promise<WebsiteConfiguration> {
    return tx.websiteConfiguration.update({ where: { academyId }, data });
  }
}

type PublishedSnapshot = Pick<
  WebsiteConfiguration,
  | 'themeKey'
  | 'themeVersion'
  | 'brand'
  | 'seo'
  | 'navigation'
  | 'header'
  | 'footer'
  | 'defaultLocale'
>;

/**
 * The row as the public sees it: the published snapshot's fields in place
 * of the working copy's. A published row without a snapshot can only be one
 * that predates the snapshot migration (which backfilled every published
 * site), so it keeps serving its working copy rather than going dark.
 */
export function withPublishedSnapshot(row: WebsiteConfiguration): WebsiteConfiguration {
  const snapshot = row.publishedSnapshot as Partial<PublishedSnapshot> | null;
  if (!snapshot || typeof snapshot !== 'object') return row;
  return {
    ...row,
    themeKey: snapshot.themeKey ?? row.themeKey,
    themeVersion: snapshot.themeVersion ?? row.themeVersion,
    brand: snapshot.brand ?? row.brand,
    seo: snapshot.seo ?? row.seo,
    navigation: snapshot.navigation ?? row.navigation,
    header: snapshot.header ?? row.header,
    footer: snapshot.footer ?? row.footer,
    // B0-WEB-02 — never the working copy's: a snapshot taken before the
    // setting existed was published with English at the root.
    defaultLocale: resolveDefaultLocale(snapshot.defaultLocale),
  };
}

/** Does the working copy differ from what is published? */
export function hasUnpublishedConfigurationChanges(row: WebsiteConfiguration): boolean {
  if (!row.publishedSnapshot) return true;
  const published = withPublishedSnapshot(row);
  return (
    JSON.stringify([
      row.themeKey,
      row.themeVersion,
      row.brand,
      row.seo,
      row.navigation,
      row.header,
      row.footer,
      row.defaultLocale,
    ]) !==
    JSON.stringify([
      published.themeKey,
      published.themeVersion,
      published.brand,
      published.seo,
      published.navigation,
      published.header,
      published.footer,
      published.defaultLocale,
    ])
  );
}

/**
 * Publish: the working copy becomes what visitors see. The snapshot holds
 * exactly the fields the public runtime renders.
 */
export function buildPublishedSnapshot(
  configuration: WebsiteConfiguration,
): Prisma.InputJsonValue {
  return {
    themeKey: configuration.themeKey,
    themeVersion: configuration.themeVersion,
    brand: configuration.brand,
    seo: configuration.seo,
    navigation: configuration.navigation,
    header: configuration.header,
    footer: configuration.footer,
    defaultLocale: configuration.defaultLocale,
  } as Prisma.InputJsonValue;
}
