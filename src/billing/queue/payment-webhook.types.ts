/** Master plan §12/§21 Phase P12: "Payment webhook processing | payment-webhook-worker." */
export const PAYMENT_WEBHOOK_QUEUE = 'payment-webhook';

export const PROCESS_WEBHOOK_EVENT_JOB = 'process-webhook-event';

export interface ProcessWebhookEventJobPayload {
  readonly provider: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly paymentId: string;
  readonly occurredAt: string;
}
