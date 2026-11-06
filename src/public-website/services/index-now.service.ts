/**
 * IndexNowService — tells the IndexNow engines (Bing, Yandex, Seznam,
 * Naver, Yep; https://www.indexnow.org) which of an Academy's public URLs
 * just changed, so they recrawl them now rather than at their next visit
 * (SEO/AEO/GEO pass, Nov 2026). Bing's index also feeds Copilot and other
 * answer engines; Google does not take part (it reads the sitemap).
 *
 * WHEN. Whenever what an Academy's website shows changes — the same signal
 * that purges its edge-cached pages (`EdgeCachePurgeService.purgeAcademy`:
 * a publish, a course or curriculum edit, a branding or domain change).
 * Changes are coalesced per Academy for `DEBOUNCE_MS`, then ONE request
 * names every URL of its sitemap whose `<lastmod>` is newer than the last
 * submission (in both languages), so unchanged URLs are never re-sent.
 * After a restart the first submission covers the last `FIRST_WINDOW_MS`.
 *
 * WHAT. Only what the sitemap lists: a published, indexable site's
 * visible pages and published public courses on its canonical host. A site
 * that is unpublished, has search engines turned off or its sitemap off is
 * never submitted.
 *
 * KEY. Each Academy's key is an HMAC of `indexNow.keySecret` and its id —
 * stable, unguessable, stored nowhere — served by its own host at
 * `/indexnow-key.txt` (`keyLocation`), which IndexNow fetches to verify
 * ownership. The file is at the host's root, so the key covers every URL.
 *
 * Never throws and never delays the caller; `INDEXNOW=off` stops it.
 */
import { createHmac } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IndexNowConfig } from '../../config/configuration';
import { EdgeCachePurgeService } from '../../edge-cache/edge-cache-purge.service';
import { PUBLIC_WEBSITE_LOCALES } from '../../website/constants/locale.constants';
import { localizedSitePath } from '../utils/seo-files.util';
import { PublicWebsiteService } from './public-website.service';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
/** The key file's path on every Academy host (Caddy sends it to `host/indexnow-key.txt`). */
export const INDEXNOW_KEY_PATH = '/indexnow-key.txt';
/** Coalesce a burst of edits (a publish touches many rows) into one submission. */
const DEBOUNCE_MS = 60_000;
/** The first submission after a restart: URLs changed this recently. */
const FIRST_WINDOW_MS = 2 * 60 * 60 * 1000;
/** The protocol's limit per request. */
const MAX_URLS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** `lastmod` precision slack (a row written in the same second as the last submission). */
const SLACK_MS = 2_000;

@Injectable()
export class IndexNowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexNowService.name);
  private readonly config: IndexNowConfig;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastSubmittedAt = new Map<string, number>();

  constructor(
    configService: ConfigService,
    private readonly edgeCachePurgeService: EdgeCachePurgeService,
    private readonly publicWebsiteService: PublicWebsiteService,
  ) {
    this.config = configService.get<IndexNowConfig>('indexNow') ?? { enabled: false };
  }

  get enabled(): boolean {
    return this.config.enabled && !!this.config.keySecret;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('IndexNow is off (INDEXNOW=off or no key secret).');
      return;
    }
    this.edgeCachePurgeService.onAcademyChanged((academyId) => this.notify(academyId));
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** The Academy's IndexNow key: 32 lowercase hex characters (the protocol allows 8–128 of `[a-zA-Z0-9-]`). */
  keyFor(academyId: string): string | null {
    if (!this.enabled) return null;
    return createHmac('sha256', this.config.keySecret!)
      .update(`atlas-indexnow-key:v1:${academyId}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** The key file's body for the Academy behind `host`, or `null` (unknown host, unpublished, not indexable, IndexNow off). */
  async keyFileFor(host: string): Promise<string | null> {
    if (!this.enabled) return null;
    const resolved = await this.publicWebsiteService.resolveHostname(host);
    if (!resolved) return null;
    const files = await this.publicWebsiteService.getSeoFiles(host);
    if (!files.indexable) return null;
    return this.keyFor(resolved.academyId);
  }

  /** Something the Academy's website shows changed: submit its changed URLs soon. */
  notify(academyId: string): void {
    if (!this.enabled) return;
    const existing = this.timers.get(academyId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(academyId);
      void this.submit(academyId);
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(academyId, timer);
  }

  /** Submits the Academy's URLs changed since its last submission. Resolves to the URLs sent (empty when none). */
  async submit(academyId: string, now: number = Date.now()): Promise<readonly string[]> {
    if (!this.enabled) return [];
    try {
      const host = await this.publicWebsiteService.getCanonicalHost(academyId);
      if (!host) return [];
      const files = await this.publicWebsiteService.getSeoFiles(host);
      if (!files.indexable || !files.sitemapEnabled || !files.origin) return [];
      const since =
        (this.lastSubmittedAt.get(academyId) ?? now - FIRST_WINDOW_MS) - SLACK_MS;
      const urlList = files.urls
        .filter((url) => {
          const changed = Date.parse(url.lastModified);
          return Number.isFinite(changed) && changed > since;
        })
        .flatMap((url) =>
          PUBLIC_WEBSITE_LOCALES.map(
            (locale) =>
              `${files.origin}${localizedSitePath(url.path, locale, files.defaultLocale)}`,
          ),
        )
        .slice(0, MAX_URLS);
      if (urlList.length === 0) return [];
      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: new URL(files.origin).host,
          key: this.keyFor(academyId),
          keyLocation: `${files.origin}${INDEXNOW_KEY_PATH}`,
          urlList,
        }),
      });
      if (response.status === 200 || response.status === 202) {
        this.lastSubmittedAt.set(academyId, now);
        return urlList;
      }
      this.logger.warn(
        { academyId, status: response.status, urls: urlList.length },
        'IndexNow did not accept a submission; the sitemap still lists the URLs.',
      );
      return [];
    } catch (error) {
      this.logger.warn(
        { academyId, error: error instanceof Error ? error.message : String(error) },
        'IndexNow submission failed; the sitemap still lists the URLs.',
      );
      return [];
    }
  }
}
