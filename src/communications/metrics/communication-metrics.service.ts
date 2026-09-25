/**
 * Communication metrics — P64 Communications C1, in `LearningMetricsService`'s
 * shape: the process-wide registry, idempotent series construction so a
 * second `INestApplication` in the same process (every e2e spec) does not
 * re-register, no per-tenant labels, and nothing here may throw.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { METRICS_REGISTRY } from '../../observability/metrics/learning-metrics.service';

function counter(name: string, help: string, labelNames: readonly string[]): Counter {
  const existing = METRICS_REGISTRY.getSingleMetric(name);
  if (existing) return existing as Counter;
  return new Counter({
    name,
    help,
    labelNames: [...labelNames],
    registers: [METRICS_REGISTRY],
  });
}

function histogram(
  name: string,
  help: string,
  labelNames: readonly string[],
  buckets: readonly number[],
): Histogram {
  const existing = METRICS_REGISTRY.getSingleMetric(name);
  if (existing) return existing as Histogram;
  return new Histogram({
    name,
    help,
    labelNames: [...labelNames],
    buckets: [...buckets],
    registers: [METRICS_REGISTRY],
  });
}

@Injectable()
export class CommunicationMetricsService {
  private readonly logger = new Logger(CommunicationMetricsService.name);

  private readonly outbox = counter(
    'atlas_comm_outbox_total',
    'Outbox rows by category and the state they entered.',
    ['category', 'state'],
  );

  private readonly dispatchLatency = histogram(
    'atlas_comm_dispatch_latency_seconds',
    'Seconds from outbox creation to a sent delivery, by category.',
    ['category'],
    [1, 5, 15, 60, 300, 900, 3600, 14400, 86400],
  );

  private readonly retries = counter(
    'atlas_comm_retry_attempts_total',
    'Delivery attempts that failed transiently and were handed back to BullMQ for retry.',
    ['category'],
  );

  private readonly deadLetters = counter(
    'atlas_comm_dead_letter_total',
    'Outbox rows that exhausted their retries and were marked failed.',
    ['category'],
  );

  private readonly digestItems = counter(
    'atlas_comm_digest_items_total',
    'Outbox rows deferred into a digest window, by digest kind.',
    ['kind'],
  );

  private readonly otp = counter(
    'atlas_auth_otp_total',
    'Email one-time-code challenges by outcome.',
    ['result'],
  );

  private readonly trustedDevices = counter(
    'atlas_auth_trusted_device_total',
    'Trusted-device lifecycle events.',
    ['event'],
  );

  recordOutbox(category: string, state: string): void {
    this.safely(() => this.outbox.inc({ category, state }));
  }

  recordDispatchLatency(category: string, seconds: number): void {
    this.safely(() => this.dispatchLatency.observe({ category }, Math.max(0, seconds)));
  }

  recordRetry(category: string): void {
    this.safely(() => this.retries.inc({ category }));
  }

  recordDeadLetter(category: string): void {
    this.safely(() => this.deadLetters.inc({ category }));
  }

  recordDigestItem(kind: string): void {
    this.safely(() => this.digestItems.inc({ kind }));
  }

  /**
   * P64 Communications C4 — the email-OTP funnel.
   *
   * `result` is one of `requested` | `resent` | `verified` | `failed` |
   * `expired` | `suppressed` | `rate_limited`. Deliberately a single
   * low-cardinality label and no user/tenant dimension, matching every
   * other series here: an alert wants "OTP failures are surging", never
   * "which account".
   */
  recordOtp(result: string): void {
    this.safely(() => this.otp.inc({ result }));
  }

  /** `event` is `trusted` | `revoked` | `revoked_all`. */
  recordTrustedDevice(event: string): void {
    this.safely(() => this.trustedDevices.inc({ event }));
  }

  private safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Communication metric update failed (ignored).',
      );
    }
  }
}
