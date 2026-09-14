/** Phase 12 — inbound Zoom events are processed off the request thread, mirroring `payment-webhook`. */
export const LIVE_PROVIDER_EVENT_QUEUE = 'live-provider-event';

export const PROCESS_LIVE_PROVIDER_EVENT_JOB = 'process-live-provider-event';

export interface ProcessLiveProviderEventJobPayload {
  readonly providerEventId: string;
  readonly eventType: string;
  /** The provider's meeting identifier — how the Atlas session is resolved. */
  readonly providerMeetingId?: string;
  /**
   * The non-sensitive fields the handler needs, extracted at the edge.
   *
   * Deliberately NOT the raw payload: a provider body can carry
   * participant emails and join URLs, and a queue payload is persisted in
   * Redis and logged on failure. Only what is needed travels.
   */
  readonly participantKey?: string;
  readonly providerParticipantId?: string;
  readonly joinedAt?: string;
  readonly leftAt?: string;
  readonly occurredAt: string;
}
