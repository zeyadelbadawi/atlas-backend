/** BullMQ queue for push deliveries (one processor: `PushProcessor`). */
export const PUSH_QUEUE = 'push';
export const PUSH_JOB_DELIVER = 'deliver';

export interface PushDeliverJobPayload {
  /** The communication outbox row whose in-app notification is pushed. */
  readonly outboxId: string;
}

/**
 * One push per outbox row: the dispatch job can run several times (email
 * retries), and a finished push job keeps its id this long so a retry is
 * dropped as a duplicate rather than sent again.
 */
export const PUSH_JOB_KEEP_COMPLETED_SECONDS = 24 * 60 * 60;
export const PUSH_DELIVER_ATTEMPTS = 3;

export const pushJobId = (outboxId: string): string => `push-${outboxId}`;
