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

/** Decrypted provider credentials. Exists only inside an adapter call, never in a DTO, a log, or a response. */
export interface LiveProviderCredentials {
  readonly accountId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Meeting SDK credentials — separate from the server-to-server OAuth pair above. */
  readonly sdkKey?: string;
  readonly sdkSecret?: string;
  /** Verifies inbound webhook signatures. */
  readonly webhookSecretToken?: string;
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
  checkHealth(credentials: LiveProviderCredentials): Promise<ProviderHealth>;

  createMeeting(
    credentials: LiveProviderCredentials,
    input: CreateMeetingInput,
  ): Promise<CreatedMeeting>;

  updateMeeting(
    credentials: LiveProviderCredentials,
    providerMeetingId: string,
    input: CreateMeetingInput,
  ): Promise<void>;

  cancelMeeting(
    credentials: LiveProviderCredentials,
    providerMeetingId: string,
  ): Promise<void>;

  /** Mints the short-lived signature the embedded SDK needs for ONE join. */
  createJoinSignature(
    credentials: LiveProviderCredentials,
    args: {
      readonly providerMeetingId: string;
      readonly role: 'host' | 'attendee';
      readonly participantKey: string;
    },
  ): Promise<MeetingJoinSignature>;

  /**
   * Post-session participant report — the AUTHORITATIVE attendance source.
   *
   * Live webhooks are the fast path and can be lost or reordered; this is
   * the reconciliation that corrects them once the provider has finished
   * tallying.
   */
  fetchParticipantIntervals(
    credentials: LiveProviderCredentials,
    providerMeetingId: string,
  ): Promise<readonly ProviderParticipantInterval[]>;

  fetchRecordingFiles(
    credentials: LiveProviderCredentials,
    providerMeetingId: string,
  ): Promise<readonly ProviderRecordingFile[]>;

  /**
   * Verifies an inbound webhook is genuinely from the provider.
   *
   * Returns a boolean rather than throwing so the caller decides the HTTP
   * shape. Implementations MUST use a timing-safe comparison.
   */
  verifyWebhookSignature(
    credentials: LiveProviderCredentials,
    args: {
      readonly rawBody: string;
      readonly signature: string;
      readonly timestamp: string;
    },
  ): boolean;
}
