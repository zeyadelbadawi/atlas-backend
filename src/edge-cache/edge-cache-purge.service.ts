/**
 * EdgeCachePurgeService — tells Cloudflare to drop the copies of an
 * Academy's public website pages it keeps at the edge.
 *
 * WHY. The website renderer (frontend `server/ssr`) lets Cloudflare keep a
 * rendered Academy page for a few minutes, for visitors with no session and
 * no cookie decision (the only pages that are the same for every visitor):
 * the origin is ~0.4 s from the edge for every uncached request. Each such
 * page carries two cache tags:
 *
 *   atlas-academy-<academyId>   every page of that Academy, on every host
 *   atlas-host-<hostname>       every page served on that host
 *
 * This service purges those tags when what a page shows changes, so a
 * publish, a branding change, a domain change, a payment that brings a site
 * back, or a course edit shows on the next visit instead of after the
 * edge copy expires. Whatever is not purged still expires on its own within
 * the renderer's `s-maxage`; a purge only makes it sooner.
 *
 * HOW. Requests are queued, coalesced and sent after the caller's write has
 * committed (callers call this after their transaction), in at most one
 * Cloudflare request per `MIN_INTERVAL_MS` carrying every pending tag — the
 * Free plan allows a handful of purge requests a minute. Each change is
 * purged twice: right away, and once more `SECOND_PASS_MS` later, so a page
 * a visitor's request was rendering from the old data at the moment of the
 * write cannot stay at the edge for the full TTL.
 *
 * Never throws and never delays the caller: Cloudflare being slow, down or
 * not configured (no `CLOUDFLARE_CACHE_PURGE_TOKEN`) only means pages
 * expire on their own. The token is a purge-only token for this zone; it is
 * never logged.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CloudflareConfig } from '../config/configuration';
import { TenancyContextService } from '../tenancy/services/tenancy-context.service';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
/** Coalesce a burst of writes into one purge. */
const DEBOUNCE_MS = 1_500;
/** The re-purge that catches a page rendered from the old data mid-write. */
const SECOND_PASS_MS = 15_000;
/** One purge request at most this often (Free plan: a few a minute). */
const MIN_INTERVAL_MS = 12_000;
/** Tags per purge request (Cloudflare's per-request limit is higher). */
const MAX_TAGS_PER_REQUEST = 30;
const REQUEST_TIMEOUT_MS = 10_000;

export const academyEdgeTag = (academyId: string): string => `atlas-academy-${academyId}`;
export const hostEdgeTag = (hostname: string): string =>
  `atlas-host-${hostname.trim().toLowerCase().replace(/\.$/, '')}`;

@Injectable()
export class EdgeCachePurgeService implements OnModuleDestroy {
  private readonly logger = new Logger(EdgeCachePurgeService.name);
  private readonly token?: string;
  private readonly zoneId?: string;
  private readonly pending = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private flushTimer: NodeJS.Timeout | null = null;
  private lastRequestAt = 0;
  private flushing: Promise<void> | null = null;

  constructor(
    configService: ConfigService,
    private readonly tenancyContextService: TenancyContextService,
  ) {
    const config = configService.get<CloudflareConfig>('cloudflare') ?? {};
    this.token = config.cachePurgeToken;
    this.zoneId = config.zoneId;
    if (!this.enabled) {
      this.logger.log(
        'Edge cache purge is off (CLOUDFLARE_CACHE_PURGE_TOKEN or CLOUDFLARE_ZONE_ID not set); edge copies expire on their own.',
      );
    }
  }

  get enabled(): boolean {
    return !!(this.token && this.zoneId);
  }

  /** Every edge copy of this Academy's pages, on every host. */
  purgeAcademy(academyId: string | null | undefined): void {
    if (academyId) this.enqueue([academyEdgeTag(academyId)]);
  }

  /** Every edge copy of the pages served on these hosts. */
  purgeHosts(hostnames: readonly (string | null | undefined)[]): void {
    this.enqueue(
      hostnames
        .filter((host): host is string => !!host && !!host.trim())
        .map(hostEdgeTag),
    );
  }

  /**
   * Every Academy of an Organization — for a change to whether the tenant
   * may be served at all (a payment approved, a subscription lapsing).
   */
  async purgeOrganization(organizationId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const academies = await this.tenancyContextService.runInTenantContext(
        organizationId,
        (tx) => tx.academy.findMany({ where: { organizationId }, select: { id: true } }),
      );
      this.enqueue(academies.map((academy) => academyEdgeTag(academy.id)));
    } catch (error) {
      this.logger.warn(
        { organizationId, error: error instanceof Error ? error.message : String(error) },
        'Could not list an organization’s academies for an edge purge; their pages expire on their own.',
      );
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private enqueue(tags: readonly string[]): void {
    if (!this.enabled || tags.length === 0) return;
    this.add(tags, DEBOUNCE_MS);
    this.later(() => this.add(tags, 0), SECOND_PASS_MS);
  }

  private add(tags: readonly string[], delayMs: number): void {
    for (const tag of tags) this.pending.add(tag);
    this.schedule(delayMs);
  }

  private later(work: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      work();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private schedule(delayMs: number): void {
    if (this.flushTimer || this.flushing) return;
    const wait = Math.max(delayMs, this.lastRequestAt + MIN_INTERVAL_MS - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushing = this.flush().finally(() => {
        this.flushing = null;
        if (this.pending.size > 0) this.schedule(0);
      });
    }, wait);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    const tags = [...this.pending].slice(0, MAX_TAGS_PER_REQUEST);
    if (tags.length === 0) return;
    for (const tag of tags) this.pending.delete(tag);
    this.lastRequestAt = Date.now();
    try {
      const response = await fetch(
        `${CLOUDFLARE_API_BASE}/zones/${encodeURIComponent(this.zoneId ?? '')}/purge_cache`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ tags }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        success?: boolean;
        errors?: readonly { code?: number; message?: string }[];
      } | null;
      if (response.ok && body?.success === true) return;
      if (response.status === 429) {
        // Rate limited: put them back for the next slot.
        for (const tag of tags) this.pending.add(tag);
      }
      this.logger.warn(
        {
          status: response.status,
          errors: (body?.errors ?? []).map((e) => ({ code: e.code, message: e.message })),
          tags: tags.length,
        },
        'Cloudflare edge purge was refused; those pages expire on their own.',
      );
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.name : String(error), tags: tags.length },
        'Cloudflare edge purge failed; those pages expire on their own.',
      );
    }
  }
}
