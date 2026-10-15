import type { Prisma, WebsiteConfiguration } from '@prisma/client';
import {
  buildPublishedSnapshot,
  hasUnpublishedConfigurationChanges,
  withPublishedSnapshot,
} from './website-configuration.repository';
import { toWebsiteConfigurationResponse } from '../dto/website-configuration.contract';

const row = (over: Partial<WebsiteConfiguration> = {}): WebsiteConfiguration =>
  ({
    academyId: 'a1',
    themeKey: 'modern-education',
    themeVersion: 1,
    configVersion: 3,
    templateKey: null,
    templateVersion: null,
    defaultLocale: 'en',
    brand: {},
    seo: {},
    navigation: [],
    header: {},
    footer: {},
    status: 'published',
    publishedAt: new Date('2026-10-01T00:00:00Z'),
    lastPublishError: null,
    publishedSnapshot: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  }) as WebsiteConfiguration;

describe('website default locale through draft/publish (B0-WEB-02)', () => {
  it('is published with the snapshot and read back from it', () => {
    const draft = row({ defaultLocale: 'ar' });
    const snapshot = buildPublishedSnapshot(draft) as Prisma.JsonObject;
    expect(snapshot).toMatchObject({ defaultLocale: 'ar' });
    expect(
      withPublishedSnapshot(row({ publishedSnapshot: snapshot, defaultLocale: 'ar' }))
        .defaultLocale,
    ).toBe('ar');
  });

  it('a snapshot from before the setting means English, whatever the draft says', () => {
    const legacy = { themeKey: 'modern-education', themeVersion: 1, brand: {}, seo: {} };
    const published = withPublishedSnapshot(
      row({ publishedSnapshot: legacy, defaultLocale: 'ar' }),
    );
    expect(published.defaultLocale).toBe('en');
  });

  it('a changed default language is an unpublished change; an untouched site has none', () => {
    const snapshot = buildPublishedSnapshot(row()) as Prisma.JsonObject;
    expect(hasUnpublishedConfigurationChanges(row({ publishedSnapshot: snapshot }))).toBe(
      false,
    );
    expect(
      hasUnpublishedConfigurationChanges(
        row({ publishedSnapshot: snapshot, defaultLocale: 'ar' }),
      ),
    ).toBe(true);
    // A snapshot taken before the column existed, on an untouched site.
    const legacy: Prisma.JsonObject = { ...snapshot };
    delete legacy.defaultLocale;
    expect(hasUnpublishedConfigurationChanges(row({ publishedSnapshot: legacy }))).toBe(
      false,
    );
  });

  it('the response carries `defaultLocale` only when it is Arabic', () => {
    expect(toWebsiteConfigurationResponse(row())).not.toHaveProperty('defaultLocale');
    expect(
      toWebsiteConfigurationResponse(row({ defaultLocale: 'ar' })).defaultLocale,
    ).toBe('ar');
  });
});
