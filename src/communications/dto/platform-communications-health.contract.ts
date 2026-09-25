/**
 * The Platform Owner's operational view of the communications pipeline
 * (P64 Communications C7).
 *
 * WHY THIS EXISTS. Everything else about this subsystem is observable
 * only from inside the host: `/health` and `/metrics` sit outside the
 * `api` prefix and Caddy proxies only `/api/*`, so nobody — not an
 * operator, not an on-call engineer — can answer "is mail actually going
 * out?" without SSH. The failure this guards against is the quiet one: a
 * dispatcher that has stopped claiming rows looks exactly like a quiet
 * week, because "no emails sent" and "no emails to send" produce the same
 * silence. `oldestPendingSeconds` is what tells those two apart, and it
 * is the single most important number on this response.
 *
 * Counts and aggregates only: no recipient addresses, no message bodies,
 * no provider credentials. A suppression is reported as a count per
 * reason, never as a list of who bounced — the management surface for
 * individual rows is a separate, explicitly-paginated endpoint.
 */

export interface CommunicationsOutboxHealth {
  /** Rows per `CommunicationOutboxState`, including states with zero rows. */
  readonly byState: Readonly<Record<string, number>>;
  /**
   * Age of the oldest row still waiting that is already DUE
   * (`availableAt` in the past). Null when nothing is waiting — which is
   * healthy. A number that keeps climbing means the worker is not
   * draining the queue, and is the alert condition.
   */
  readonly oldestPendingSeconds: number | null;
  /** Due rows whose wait already exceeds the healthy threshold. */
  readonly overdue: number;
  /** Rows that exhausted their retries — each one is an email nobody got. */
  readonly failed: number;
}

export interface CommunicationsDeliveryHealth {
  readonly byStatus: Readonly<Record<string, number>>;
  /** Which provider actually accepted each message — proves the fallback chain in the field. */
  readonly byProvider: Readonly<Record<string, number>>;
  /** bounced + complained + failed, over everything with a terminal status. */
  readonly failureRatio: number;
}

export interface CommunicationsProviderQuota {
  readonly provider: string;
  /** Position in the fallback chain; 0 is the primary. */
  readonly position: number;
  readonly dailyUsed: number;
  readonly dailyLimit: number | null;
  readonly monthlyUsed: number;
  readonly monthlyLimit: number | null;
}

export interface PlatformCommunicationsHealthResponse {
  readonly windowDays: number;
  readonly outbox: CommunicationsOutboxHealth;
  readonly deliveries: CommunicationsDeliveryHealth;
  readonly suppressions: {
    readonly total: number;
    readonly byReason: Readonly<Record<string, number>>;
  };
  readonly digests: Readonly<Record<string, number>>;
  /**
   * The live provider chain in fallback order. `stub` appearing here in
   * production means nothing is really being sent, which is exactly the
   * misconfiguration this endpoint exists to make visible.
   */
  readonly providers: readonly CommunicationsProviderQuota[];
  readonly generatedAt: string;
}
