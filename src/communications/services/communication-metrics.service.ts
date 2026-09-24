/**
 * CommunicationMetricsService — P64 Communications observability.
 *
 * Registered with `MetricsModule` (global) and lands on the same
 * process-wide registry `LearningMetricsService` owns, so `/metrics`
 * renders these alongside every other `atlas_*` series and
 * `ops/alerts/atlas-prometheus-rules.yml` can alert on them
 * (`alert-rules.spec.ts` scans this file too).
 *
 * Labels are provider names, categories and event/result enums only —
 * never an address, message id or tenant. NOTHING HERE MAY THROW.
 */
import { Injectable, Logger } from '@nestjs/common';
import { counter, gauge } from '../../observability/metrics/learning-metrics.service';

export type EmailSendMetricResult =
  'sent' | 'transient_error' | 'permanent_error' | 'quota_skipped';

@Injectable()
export class CommunicationMetricsService {
  private readonly logger = new Logger(CommunicationMetricsService.name);

  private readonly sends = counter(
    'atlas_comm_email_sends_total',
    'Email send attempts through the provider registry, by provider, category and result.',
    ['provider', 'category', 'result'],
  );

  private readonly deliveryEvents = counter(
    'atlas_comm_email_delivery_events_total',
    'Inbound provider delivery events applied, by provider and event.',
    ['provider', 'event'],
  );

  private readonly quotaUsedRatio = gauge(
    'atlas_comm_quota_used_ratio',
    "Share of a provider's send quota consumed in the current window (0..1).",
    ['provider', 'window'],
  );

  private readonly webhookSignatureFailures = counter(
    'atlas_comm_webhook_signature_failures_total',
    'Inbound email webhooks that failed verification, by provider.',
    ['provider'],
  );

  recordSend(provider: string, category: string, result: EmailSendMetricResult): void {
    this.safely(() => this.sends.inc({ provider, category, result }));
  }

  recordDeliveryEvent(provider: string, event: string): void {
    this.safely(() => this.deliveryEvents.inc({ provider, event }));
  }

  setQuotaUsedRatio(provider: string, window: 'daily' | 'monthly', ratio: number): void {
    this.safely(() => this.quotaUsedRatio.set({ provider, window }, ratio));
  }

  recordWebhookSignatureFailure(provider: string): void {
    this.safely(() => this.webhookSignatureFailures.inc({ provider }));
  }

  private safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Communication metric could not be recorded.',
      );
    }
  }
}
