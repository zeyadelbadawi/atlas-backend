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

/**
 * P64 Phase 4 (§D.5) — the checkout lifecycle states worth counting.
 * `created` is the order coming into existence (it is born `draft`); every
 * other value is the transition INTO that status.
 */
export type CheckoutOrderMetricState =
  'created' | 'pending_payment' | 'paid' | 'expired' | 'cancelled' | 'refunded';

/** P64 Phase 4 (§D.5) — the tables the retention sweep prunes. */
export type RetentionSweepTable = 'content_access_log' | 'quiz_attempt_events';

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

  // --- P64 Phase 3 (§U) ---------------------------------------------------
  private readonly quizAttemptsStarted = counter(
    'atlas_quiz_attempts_started_total',
    'Quiz attempts started, by whether a deadline was set.',
    ['kind'],
  );
  private readonly quizAttemptsSubmitted = counter(
    'atlas_quiz_attempts_submitted_total',
    'Quiz attempts finalised, by reason (submit, timeout, integrity, review).',
    ['reason'],
  );
  private readonly quizAutosaveLag = histogram(
    'atlas_quiz_autosave_duration_ms',
    'Server time to apply an autosave (the §U autosave-lag signal).',
    [],
    [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  );
  private readonly quizSweepFinalized = counter(
    'atlas_quiz_deadline_sweep_finalized_total',
    'Overdue attempts finalised by the sweep rather than the delayed job (rises when jobs are lost).',
    [],
  );
  private readonly integrityEvents = counter(
    'atlas_quiz_integrity_events_total',
    'Integrity events recorded, by type.',
    ['type'],
  );
  private readonly certificatesIssued = counter(
    'atlas_certificates_issued_total',
    'Certificates issued, by trigger (automatic, manual, regenerated).',
    ['trigger'],
  );
  private readonly certificateRenders = counter(
    'atlas_certificate_renders_total',
    'Certificate PDF render outcomes.',
    ['result'],
  );
  private readonly certificateVerifications = counter(
    'atlas_certificate_verifications_total',
    'Public verification lookups, by outcome (issued, revoked, unknown).',
    ['result'],
  );

  recordQuizAttemptStarted(kind: 'timed' | 'untimed'): void {
    this.safely(() => this.quizAttemptsStarted.inc({ kind }));
  }
  recordQuizAttemptSubmitted(reason: string): void {
    this.safely(() => this.quizAttemptsSubmitted.inc({ reason }));
  }
  recordQuizAutosave(durationMs: number): void {
    this.safely(() => this.quizAutosaveLag.observe(durationMs));
  }
  recordQuizDeadlineSweepFinalized(): void {
    this.safely(() => this.quizSweepFinalized.inc());
  }
  recordIntegrityEvent(type: string): void {
    this.safely(() => this.integrityEvents.inc({ type }));
  }
  recordCertificateIssued(trigger: 'automatic' | 'manual' | 'regenerated'): void {
    this.safely(() => this.certificatesIssued.inc({ trigger }));
  }
  recordCertificateRender(ok: boolean): void {
    this.safely(() => this.certificateRenders.inc({ result: ok ? 'ok' : 'error' }));
  }
  recordCertificateVerification(result: 'issued' | 'revoked' | 'unknown'): void {
    this.safely(() => this.certificateVerifications.inc({ result }));
  }

  // --- P64 Phase 4 (§D.5 / §U) -----------------------------------------------
  /** Checkout orders by lifecycle state — `created`, then one increment per transition. The funnel (created → pending_payment → paid) and its leaks (expired, cancelled, refunded) are both read from this one series. */
  private readonly checkoutOrders = counter(
    'atlas_checkout_orders_total',
    'Course-checkout orders, by lifecycle state (created, then each transition).',
    ['state'],
  );
  /** Seconds between a buyer submitting a payment proof and a platform reviewer approving it — the manual-review queue's latency, which is the buyer's wait. Buckets run from a minute to a week because that is the honest range of a human review. */
  private readonly checkoutApprovalLatency = histogram(
    'atlas_checkout_approval_latency_seconds',
    'Seconds from a payment proof being submitted to its platform approval.',
    [],
    [
      60,
      300,
      900,
      1800,
      3600,
      4 * 3600,
      12 * 3600,
      24 * 3600,
      3 * 24 * 3600,
      7 * 24 * 3600,
    ],
  );
  /** Database time of the public course-catalog list — the highest-traffic anonymous read, and the one a slow tenant query surfaces on first. */
  private readonly publicCatalogQueryDuration = histogram(
    'atlas_public_catalog_query_duration_ms',
    'Database time of the public course-catalog list query.',
    [],
    [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  );
  /** Rows the retention sweep actually deleted, by table. A flat line here while data ages is the "retention rule nobody runs" bug made visible. */
  private readonly retentionPrunedRows = counter(
    'atlas_retention_sweep_pruned_rows_total',
    'Rows deleted by the retention sweep, by table.',
    ['table'],
  );
  /** Sweep executions by table and outcome — `error` is what to alert on, since the sweep itself never throws. */
  private readonly retentionSweepRuns = counter(
    'atlas_retention_sweep_runs_total',
    'Retention sweep executions, by table and outcome.',
    ['table', 'result'],
  );

  recordCheckoutOrderState(state: CheckoutOrderMetricState): void {
    this.safely(() => this.checkoutOrders.inc({ state }));
  }
  recordCheckoutApprovalLatency(seconds: number): void {
    this.safely(() => this.checkoutApprovalLatency.observe(seconds));
  }
  recordPublicCatalogQuery(durationMs: number): void {
    this.safely(() => this.publicCatalogQueryDuration.observe(durationMs));
  }
  recordRetentionPruned(table: RetentionSweepTable, rows: number): void {
    this.safely(() => this.retentionPrunedRows.inc({ table }, rows));
  }
  recordRetentionSweepRun(table: RetentionSweepTable, ok: boolean): void {
    this.safely(() =>
      this.retentionSweepRuns.inc({ table, result: ok ? 'ok' : 'error' }),
    );
  }

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
      this.tokenMintDuration.observe({ tier, result: ok ? 'ok' : 'error' }, durationMs),
    );
  }

  recordUploadCompletion(tier: string, ok: boolean): void {
    this.safely(() => this.uploadCompletions.inc({ tier, result: ok ? 'ok' : 'error' }));
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
