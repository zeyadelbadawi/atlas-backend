/**
 * The inbound delivery-webhook job's payload.
 *
 * The queue name and job name live in `communications.types.ts` with the
 * rest of the queue's vocabulary — there is ONE `communications` queue
 * and one processor for it (see that file's header for why a second
 * processor silently eats jobs). Re-exported here so the provider-side
 * modules that only care about webhooks keep one import.
 */
import type { EmailWebhookEventKind } from '../../identity/services/email-provider.interface';

export {
  COMMUNICATIONS_QUEUE,
  COMMUNICATION_JOB_WEBHOOK,
  COMMUNICATION_JOB_WEBHOOK as COMMUNICATIONS_WEBHOOK_JOB,
} from './communications.types';

export interface CommunicationsWebhookJobPayload {
  readonly provider: string;
  readonly providerMessageId: string;
  /** Kept for the suppression insert; never logged. */
  readonly recipientEmail: string;
  readonly event: EmailWebhookEventKind;
  readonly occurredAt: string;
  readonly reason?: string;
}
