/** P64 Communications — the `communications` BullMQ queue (delivery webhooks now; outbox drain/digests in later phases). */
export const COMMUNICATIONS_QUEUE = 'communications';

export const COMMUNICATIONS_WEBHOOK_JOB = 'webhook';

import type { EmailWebhookEventKind } from '../../identity/services/email-provider.interface';

export interface CommunicationsWebhookJobPayload {
  readonly provider: string;
  readonly providerMessageId: string;
  /** Kept for the suppression insert; never logged. */
  readonly recipientEmail: string;
  readonly event: EmailWebhookEventKind;
  readonly occurredAt: string;
  readonly reason?: string;
}
