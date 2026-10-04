/**
 * W3-compose — the `communication-campaigns` BullMQ queue.
 *
 * Its OWN queue with its OWN single processor, never a second worker on
 * `communications` (see `communications.types.ts` and
 * `one-worker-per-queue.spec.ts`: a second processor on a queue silently
 * eats the other's jobs).
 *
 *   - `campaign-run`  — one hint per accepted campaign: expand the audience
 *     in keyset pages, release recipients into the outbox, reconcile.
 *     Deterministic, colon-free job id per campaign, so a duplicate hint
 *     while one is waiting is ignored.
 *   - `campaign-tick` — repeatable safety net (every 30 s): resumes any
 *     campaign still in flight (a lost hint, a crashed worker, a run that
 *     yielded after `CAMPAIGN_RELEASE_PER_RUN`) and settles completion once
 *     the outbox has drained.
 */
export const CAMPAIGNS_QUEUE = 'communication-campaigns';
export const CAMPAIGN_JOB_RUN = 'campaign-run';
export const CAMPAIGN_JOB_TICK = 'campaign-tick';
export const CAMPAIGN_TICK_REPEAT_JOB_ID = 'communication-campaigns-tick-repeat';
export const CAMPAIGN_TICK_INTERVAL_MS = 30 * 1000;
/** Campaigns one tick advances. */
export const CAMPAIGN_TICK_BATCH = 20;

export interface CampaignRunJobPayload {
  readonly campaignId: string;
}

export function campaignRunJobId(campaignId: string): string {
  return `campaign-run-${campaignId}`;
}
