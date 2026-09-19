/**
 * Publishes a revoked learning session to the Normal tier's delivery gate
 * (master plan AD-16; Decision Log DL-19, DL-22).
 *
 * WHY THIS EXISTS AT ALL. `BasicVideoProvider` reports
 * `revocableBeforeExpiry`, and the Worker consults a denylist on every
 * request — but a denylist nobody writes to revokes nothing. Without this
 * service the capability would have been an aspiration, which is exactly
 * what AD-16 forbids. The flag is therefore read from configuration: no
 * endpoint, no claim.
 *
 * WHAT THE SPIKE PROVED (DL-22). A gate token with ten minutes of life
 * left stopped serving the moment a denylist entry was written, while a
 * presigned URL for the same object kept serving. That control experiment
 * is the entire argument for the Worker over a presign, and this service
 * is the half of it that lives in Atlas.
 *
 * PROMPT, NOT INSTANT. Cloudflare KV is eventually consistent — the spike
 * recorded propagation of up to a minute, plus the gate's own short colo
 * cache. So revocation here means "within about a minute", not "on the
 * next byte", and nothing in Atlas should promise a sub-second SLA.
 *
 * BEST-EFFORT, ALWAYS. Every caller is an action that has already
 * happened and must not be undone by a delivery-layer failure: an
 * enrollment really was revoked, a device really was removed. If the gate
 * cannot be reached, the credential still expires on its own within ten
 * minutes, which is why this logs and returns rather than throwing.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BasicVideoConfig } from '../../config/configuration';

/** Why a session was revoked. Recorded on the denylist entry for forensics, never used as a decision input by the gate. */
export type GateRevocationReason =
  | 'enrollment_revoked'
  | 'academy_membership_blocked'
  | 'device_removed'
  | 'session_taken_over'
  | 'signed_out';

@Injectable()
export class VideoGateRevocationService {
  private readonly logger = new Logger(VideoGateRevocationService.name);
  private readonly config: BasicVideoConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<BasicVideoConfig>('basicVideo');
  }

  /** Whether Atlas can actually withdraw a Normal-tier credential early. Mirrors the adapter's capability exactly. */
  get isEnabled(): boolean {
    return Boolean(this.config.revocationEndpoint && this.config.revocationToken);
  }

  /**
   * Stops the gate honouring any token minted for this session.
   *
   * Keyed on the SESSION rather than the user: a learner signing out of
   * one browser must not stop their own playback on another, and the
   * takeover flow depends on being able to displace exactly one session.
   * The gate reads `rev:s:<sessionId>`; the key shape is the contract
   * between this service and `deploy/video-gate-worker`.
   */
  async revokeSession(sessionId: string, reason: GateRevocationReason): Promise<void> {
    if (!this.isEnabled) return;
    try {
      const response = await fetch(this.config.revocationEndpoint as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.revocationToken as string}`,
        },
        body: JSON.stringify({ sessionId, reason }),
        // Bounded: this runs inside a request that has already succeeded,
        // and a hanging delivery-layer call must not hold it open.
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        this.logger.warn(
          { sessionId, reason, status: response.status },
          'Video gate refused a revocation; the credential will still expire on its own.',
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          sessionId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not publish a revocation to the video gate; the credential will still expire on its own.',
      );
    }
  }

  /** Revokes several sessions at once — a blocked learner may hold more than one. */
  async revokeSessions(
    sessionIds: readonly string[],
    reason: GateRevocationReason,
  ): Promise<void> {
    if (!this.isEnabled || sessionIds.length === 0) return;
    await Promise.all(sessionIds.map((id) => this.revokeSession(id, reason)));
  }
}
