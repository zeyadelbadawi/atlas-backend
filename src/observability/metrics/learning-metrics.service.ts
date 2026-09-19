/**
 * P64 Phase 2 observability (master plan Phase 2 §U).
 *
 * WHY A REGISTRY AND NOT JUST LOGS. Phase 2's alerting requirements are
 * all RATES and DISTRIBUTIONS — "p99 grant rate above 40 per 10 minutes",
 * "provider errors above 2%", "video pending for more than 30 minutes",
 * "any webhook signature failure". None of those is answerable from a log
 * line; each needs a counter or a histogram something can scrape. This is
 * the first metrics registry in the codebase, so it is deliberately small:
 * exactly the series §U names, and nothing speculative.
 *
 * WHAT IS DELIBERATELY NOT A LABEL. No user id, no academy id, no lesson
 * id. Prometheus labels are a cartesian product — a per-academy label on a
 * multi-tenant platform is an unbounded series count and a slow, expensive
 * outage waiting to happen. Per-tenant questions are answered from
 * `content_access_log`, which is designed for them and has a retention
 * policy; metrics answer platform-shaped questions. The one exception is
 * `tier`, which has exactly two values and is the whole point of Phase 2's
 * comparison.
 *
 * NOTHING HERE MAY THROW. A metrics failure must never fail the request it
 * is describing.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** One registry for the process. Module-scoped so a second `INestApplication` (every e2e spec boots one) does not re-register and throw. */
const registry = new Registry();
let defaultsCollected = false;

function counter(name: string, help: string, labelNames: readonly string[]): Counter {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Counter;
  return new Counter({ name, help, labelNames: [...labelNames], registers: [registry] });
}

function histogram(
  name: string,
  help: string,
  labelNames: readonly string[],
  buckets: readonly number[],
): Histogram {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Histogram;
  return new Histogram({
    name,
    help,
    labelNames: [...labelNames],
    buckets: [...buckets],
    registers: [registry],
  });
}

@Injectable()
export class LearningMetricsService {
  private readonly logger = new Logger(LearningMetricsService.name);

  /** §U — `content_grants_total{kind,result,tier}`. The `tier` label is what makes the two tiers comparable rather than averaged together. */
  private readonly contentGrants = counter(
    'atlas_content_grants_total',
    'Content-access decisions, by payload kind, outcome and security tier.',
    ['kind', 'result', 'tier'],
  );

  /** §U — `video_token_mint_duration_ms`, plus the provider-error rate the 2% alert reads. */
  private readonly tokenMintDuration = histogram(
    'atlas_video_token_mint_duration_ms',
    'Time to mint a playback credential, by tier and outcome.',
    ['tier', 'result'],
    [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  );

  /** §U — the synchronous upload path has no webhook to alert on, so its completions are counted here. */
  private readonly uploadCompletions = counter(
    'atlas_video_upload_completions_total',
    'Video uploads finalised, by tier and outcome.',
    ['tier', 'result'],
  );

  /**
   * §D.5 — how video durations are being established.
   *
   * A rise in `declared` is the signal that the quota is drifting toward
   * self-reported, which is the one thing D5 says must never happen
   * silently. It is a metric precisely because it is a trend, not an event.
   */
  private readonly durationProvenance = counter(
    'atlas_video_duration_provenance_total',
    'How a video duration was established: measured, parsed or declared.',
    ['source'],
  );

  /** §U — webhook signature failures. Any is worth an alert. */
  private readonly webhookSignatureFailures = counter(
    'atlas_video_webhook_signature_failures_total',
    'Inbound video webhooks that failed signature verification.',
    [],
  );

  /** §U — `lease_conflicts_total`, `device_limit_hits_total`, and takeovers. */
  private readonly leaseConflicts = counter(
    'atlas_learning_lease_conflicts_total',
    'Content requests refused because another device held the learning lease.',
    [],
  );

  private readonly deviceLimitHits = counter(
    'atlas_learning_device_limit_hits_total',
    'Content requests refused because the learner was at their device cap.',
    [],
  );

  private readonly takeovers = counter(
    'atlas_learning_session_takeovers_total',
    'Learner-confirmed session takeovers.',
    [],
  );

  /** §U — the Normal tier's expected refresh load, and the signal that reveals a TTL misconfiguration. */
  private readonly grantRefreshes = counter(
    'atlas_content_grant_refreshes_total',
    'Playback grants re-issued for a lesson already in play.',
    ['tier'],
  );

  constructor() {
    if (!defaultsCollected) {
      collectDefaultMetrics({ register: registry });
      defaultsCollected = true;
    }
  }

  recordGrant(kind: string, tier: string | null): void {
    this.safely(() =>
      this.contentGrants.inc({ kind, result: 'granted', tier: tier ?? 'none' }),
    );
  }

  recordRefusal(reason: string, tier: string | null): void {
    this.safely(() => {
      this.contentGrants.inc({ kind: reason, result: 'refused', tier: tier ?? 'none' });
      if (reason === 'sessionConflict') this.leaseConflicts.inc();
      if (reason === 'deviceLimit') this.deviceLimitHits.inc();
    });
  }

  recordGrantRefresh(tier: string | null): void {
    this.safely(() => this.grantRefreshes.inc({ tier: tier ?? 'none' }));
  }

  recordTokenMint(tier: string, durationMs: number, ok: boolean): void {
    this.safely(() =>
      this.tokenMintDuration.observe(
        { tier, result: ok ? 'ok' : 'error' },
        durationMs,
      ),
    );
  }

  recordUploadCompletion(tier: string, ok: boolean): void {
    this.safely(() =>
      this.uploadCompletions.inc({ tier, result: ok ? 'ok' : 'error' }),
    );
  }

  recordDurationProvenance(source: 'measured' | 'parsed' | 'declared'): void {
    this.safely(() => this.durationProvenance.inc({ source }));
  }

  recordWebhookSignatureFailure(): void {
    this.safely(() => this.webhookSignatureFailures.inc());
  }

  recordTakeover(): void {
    this.safely(() => this.takeovers.inc());
  }

  /** The scrape payload. */
  async render(): Promise<{ readonly contentType: string; readonly body: string }> {
    return { contentType: registry.contentType, body: await registry.metrics() };
  }

  private safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      // A metrics failure must never fail the request it describes.
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not record a learning metric.',
      );
    }
  }
}
