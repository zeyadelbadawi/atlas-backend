/** `WebsiteConfiguration` response contract — matches `website.types.ts` field-for-field. */
import type { WebsiteConfiguration as PrismaWebsiteConfiguration } from '@prisma/client';
import {
  DEFAULT_PUBLIC_WEBSITE_LOCALE,
  resolveDefaultLocale,
  type PublicWebsiteLocale,
} from '../constants/locale.constants';

export interface WebsiteConfigurationResponse {
  readonly id: string;
  readonly academyId: string;
  readonly themeKey: string;
  readonly themeVersion: number;
  readonly configVersion: number;
  readonly brand: Record<string, unknown>;
  readonly seo: Record<string, unknown>;
  readonly navigation: readonly unknown[];
  readonly header: Record<string, unknown>;
  readonly footer: Record<string, unknown>;
  readonly status: PrismaWebsiteConfiguration['status'];
  readonly publishedAt?: string;
  readonly lastPublishError?: Record<string, unknown>;
  readonly updatedAt: string;
  /**
   * B0-WEB-02 — the site's main language, present only when it is not the
   * platform default `en` (absent = `en`), so every response for an
   * English-default site — and the server-rendered pages that embed the
   * public one — stays byte-for-byte what it was. Management responses carry
   * the working copy's value; public ones the published value.
   */
  readonly defaultLocale?: PublicWebsiteLocale;
  /**
   * CMS phase 4, management responses only: the header, footer and
   * navigation are locked against edits (see `UpdateWebsiteConfigurationDto`).
   */
  readonly chromeLocked?: boolean;
  /**
   * Management responses only: what is saved but not yet visible to
   * visitors — the site-wide settings, and how many pages.
   */
  readonly unpublishedChanges?: {
    readonly configuration: boolean;
    readonly pages: number;
  };
}

/**
 * The frontend's `WebsiteConfiguration.id` is a plain `id` field on a
 * conceptually-singleton-per-Academy resource; this backend stores the
 * row keyed directly by `academy_id` (the real 1:1, PK-is-the-FK design
 * §5.10 specifies), so `academyId` doubles as `id` in the response — the
 * same value, never a second synthetic uuid the frontend has no use for.
 */
export function toWebsiteConfigurationResponse(
  configuration: PrismaWebsiteConfiguration,
): WebsiteConfigurationResponse {
  const defaultLocale = resolveDefaultLocale(configuration.defaultLocale);
  return {
    id: configuration.academyId,
    academyId: configuration.academyId,
    themeKey: configuration.themeKey,
    themeVersion: configuration.themeVersion,
    configVersion: configuration.configVersion,
    brand: configuration.brand as Record<string, unknown>,
    seo: configuration.seo as Record<string, unknown>,
    navigation: configuration.navigation as unknown[],
    header: configuration.header as Record<string, unknown>,
    footer: configuration.footer as Record<string, unknown>,
    status: configuration.status,
    publishedAt: configuration.publishedAt?.toISOString(),
    lastPublishError:
      (configuration.lastPublishError as Record<string, unknown> | null) ?? undefined,
    updatedAt: configuration.updatedAt.toISOString(),
    ...(defaultLocale !== DEFAULT_PUBLIC_WEBSITE_LOCALE ? { defaultLocale } : {}),
  };
}
