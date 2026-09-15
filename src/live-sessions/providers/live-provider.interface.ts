/**
 * The seam between Atlas and a live-meeting provider.
 *
 * Mirrors `PaymentProviderAdapter`'s established shape deliberately: one
 * interface, one registry, adapters that receive already-decrypted
 * credentials and never reach for configuration themselves. A second
 * provider becomes a new adapter plus a catalog entry, with nothing in the
 * services above changing.
 *
 * EVERY METHOD IS SERVER-SIDE ONLY. Nothing returned here is forwarded
 * verbatim to a browser: the join signature is minted per request and
 * short-lived, and credentials never leave this layer at all.
 */

/**
 * Meeting SDK credentials.
 *
 * ATLAS-OWNED, not per-academy. Atlas owns the Meeting SDK application;
 * these come from server configuration, never from a customer. Kept as
 * their own type rather than folded into an access token because the SDK
 * signature is a locally-computed JWT, not an API call — it needs a
 * signing secret, not an authorization.
 */
export interface MeetingSdkCredentials {
  readonly sdkKey?: string;
  readonly sdkSecret?: string;
}

export interface CreateMeetingInput {
  readonly topic: string;
  readonly agenda?: string;
  readonly startAt: Date;
  readonly durationMinutes: number;
  readonly timezone?: string;
  /**
   * Whether the PROVIDER should be told to record automatically.
   *
   * Atlas passes `false` unless its own policy says otherwise, and the
   * webhook handler independently re-checks Atlas policy before importing
   * anything — so a provider account whose own default is "record
   * everything" still cannot manufacture an Atlas recording.
   */
  readonly autoRecord: boolean;
}

export interface CreatedMeeting {
  readonly providerMeetingId: string;
  /**
   * The provider's own join URL. Stored server-side for host/diagnostic
   * use; NEVER the student's access mechanism — students join through an
   * Atlas-minted grant and the embedded SDK.
   */
  readonly joinUrl?: string;
}

/** What the embedded SDK needs, minted per join and valid briefly. */
export interface MeetingJoinSignature {
  readonly signature: string;
  readonly sdkKey: string;
  readonly providerMeetingId: string;
  readonly expiresAt: Date;
}

export interface ProviderHealth {
  readonly healthy: boolean;
  /** Provider-agnostic summary only — never a raw provider payload. */
  readonly reason?: string;
}

/** One participant interval as the provider reports it, post-session. */
export interface ProviderParticipantInterval {
  /** The identity Atlas handed the provider — how this maps back to a real user. */
  readonly participantKey?: string;
  readonly providerParticipantId?: string;
  readonly joinedAt: Date;
  readonly leftAt?: Date;
}

export interface ProviderRecordingFile {
  readonly providerFileId: string;
  readonly fileType?: string;
  readonly sizeBytes?: number;
  /** Short-lived download location. Never returned to a browser. */
  readonly downloadUrl?: string;
}

export interface LiveProviderAdapter {
  readonly key: 'zoom';

  /** Proves the credentials work, without mutating anything. */
  checkHealth(accessToken: string): Promise<ProviderHealth>;

  createMeeting(accessToken: string, input: CreateMeetingInput): Promise<CreatedMeeting>;

  updateMeeting(
    accessToken: string,
    providerMeetingId: string,
    input: CreateMeetingInput,
  ): Promise<void>;

  cancelMeeting(accessToken: string, providerMeetingId: string): Promise<void>;

  /** Mints the short-lived signature the embedded SDK needs for ONE join. */
  createJoinSignature(
    credentials: MeetingSdkCredentials,
    args: {
      readonly providerMeetingId: string;
      readonly role: 'host' | 'attendee';
      readonly participantKey: string;
    },
  ): Promise<MeetingJoinSignature>;

  /**
   * A token that lets the HOST start a meeting.
   *
   * Required because Atlas creates meetings that cannot be joined before
   * the host arrives; without it the host is queued like everybody else
   * and the session never opens. Minted per join, given only to a verified
   * host, never persisted.
   */
  fetchHostZak(accessToken: string): Promise<string>;

  /**
   * Post-session participant report — the AUTHORITATIVE attendance source.
   *
   * Live webhooks are the fast path and can be lost or reordered; this is
   * the reconciliation that corrects them once the provider has finished
   * tallying.
   */
  fetchParticipantIntervals(
    accessToken: string,
    providerMeetingId: string,
  ): Promise<readonly ProviderParticipantInterval[]>;

  fetchRecordingFiles(
    accessToken: string,
    providerMeetingId: string,
  ): Promise<readonly ProviderRecordingFile[]>;

  /**
   * Verifies an inbound webhook is genuinely from the provider.
   *
   * Returns a boolean rather than throwing so the caller decides the HTTP
   * shape. Implementations MUST use a timing-safe comparison.
   */
  verifyWebhookSignature(
    /** Atlas's ONE app-level secret token — never a per-academy secret. */
    secretToken: string | undefined,
    args: {
      readonly rawBody: string;
      readonly signature: string;
      readonly timestamp: string;
    },
  ): boolean;
}
