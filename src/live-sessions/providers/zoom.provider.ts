/**
 * ZoomProvider — the only place this codebase speaks Zoom's HTTP API.
 *
 * WHICH ZOOM PRODUCTS THIS USES, AND WHY.
 *
 *   * The REST API (meetings, reports, recordings), called with an ACCESS
 *     TOKEN this adapter is handed. Atlas owns the Zoom application and
 *     each academy grants it an authorization; `ZoomOAuthService` holds
 *     the token set and handles refresh and rotation. This file no longer
 *     mints anything — an adapter that mints its own credentials is one
 *     that can silently keep acting with a revoked authorization.
 *   * Meeting SDK for the embedded, Atlas-controlled join. Students never
 *     receive a Zoom URL; the browser gets a signature scoped to one
 *     meeting, one role, and a short validity.
 *
 * THE SDK SIGNATURE IS A JWT SIGNED WITH THE SDK SECRET, built here with
 * `node:crypto` only — the same "one seam, no new dependency" rule
 * `webhook-signature.util.ts` already follows. The secret never leaves the
 * server; only the signed, expiring artefact does.
 *
 * EXTERNAL PREREQUISITES (none of which this file can satisfy): Atlas's
 * own General OAuth application, a Meeting SDK application, and the
 * app-level webhook secret token. Without them every method here fails
 * honestly at the network boundary rather than pretending to succeed.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateMeetingInput,
  MeetingSdkCredentials,
  CreatedMeeting,
  LiveProviderAdapter,
  MeetingJoinSignature,
  ProviderHealth,
  ProviderParticipantInterval,
  ProviderRecordingFile,
} from './live-provider.interface';

const ZOOM_API_BASE = 'https://api.zoom.us/v2';

/** How long an SDK join signature stays valid. Short: it is used immediately. */
const SDK_SIGNATURE_TTL_SECONDS = 60 * 10;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

@Injectable()
export class ZoomProvider implements LiveProviderAdapter {
  readonly key = 'zoom' as const;
  private readonly logger = new Logger(ZoomProvider.name);

  /**
   * One authenticated Zoom REST call.
   *
   * TAKES A TOKEN, NOT CREDENTIALS. Minting is no longer this adapter's
   * job: Atlas owns the OAuth application, and `ZoomOAuthService` holds
   * the token set, decides when a refresh is due, and handles rotation.
   * This layer stays a plain HTTP client, which is what it should always
   * have been — an adapter that mints its own credentials is an adapter
   * that can silently act with a revoked one.
   */
  private async call<T>(
    accessToken: string,
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' },
  ): Promise<T> {
    const token = accessToken;
    const response = await fetch(`${ZOOM_API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `Zoom API ${init.method} ${path} failed with status ${response.status}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async checkHealth(accessToken: string): Promise<ProviderHealth> {
    try {
      await this.call(accessToken, '/users/me');
      return { healthy: true };
    } catch (error) {
      // A provider-agnostic summary is all that is stored or shown — the
      // academy needs to know to reconnect, not to read Zoom's internals.
      this.logger.warn(
        { reason: error instanceof Error ? error.message : 'unknown' },
        'Zoom connection health check failed.',
      );
      return { healthy: false, reason: 'connection_failed' };
    }
  }

  async createMeeting(
    accessToken: string,
    input: CreateMeetingInput,
  ): Promise<CreatedMeeting> {
    const created = await this.call<{ id: number | string; join_url?: string }>(
      accessToken,
      '/users/me/meetings',
      {
        method: 'POST',
        body: {
          topic: input.topic,
          agenda: input.agenda,
          type: 2, // scheduled
          start_time: input.startAt.toISOString(),
          duration: input.durationMinutes,
          timezone: input.timezone ?? 'UTC',
          settings: {
            // ATLAS POLICY, SENT EXPLICITLY EVERY TIME. Passing `false`
            // rather than omitting it is the point: omission would let the
            // Zoom account's own "record all meetings automatically"
            // default decide, which is precisely what must never happen.
            auto_recording: input.autoRecord ? 'cloud' : 'none',
            // Participants wait until the host arrives, so a scheduled
            // room cannot be used unsupervised before its session.
            join_before_host: false,
            waiting_room: false,
            approval_type: 2,
          },
        },
      },
    );

    return { providerMeetingId: String(created.id), joinUrl: created.join_url };
  }

  async updateMeeting(
    accessToken: string,
    providerMeetingId: string,
    input: CreateMeetingInput,
  ): Promise<void> {
    await this.call(accessToken, `/meetings/${providerMeetingId}`, {
      method: 'PATCH',
      body: {
        topic: input.topic,
        agenda: input.agenda,
        start_time: input.startAt.toISOString(),
        duration: input.durationMinutes,
        timezone: input.timezone ?? 'UTC',
        settings: { auto_recording: input.autoRecord ? 'cloud' : 'none' },
      },
    });
  }

  async cancelMeeting(accessToken: string, providerMeetingId: string): Promise<void> {
    await this.call(accessToken, `/meetings/${providerMeetingId}`, { method: 'DELETE' });
  }

  /**
   * Builds the Meeting SDK JWT.
   *
   * `role` 1 = host, 0 = attendee — the provider enforces host powers, so
   * a student cannot obtain host controls by editing a client payload:
   * the role is baked into a signature they cannot forge.
   */
  async createJoinSignature(
    credentials: MeetingSdkCredentials,
    args: {
      readonly providerMeetingId: string;
      readonly role: 'host' | 'attendee';
      readonly participantKey: string;
    },
  ): Promise<MeetingJoinSignature> {
    const sdkKey = credentials.sdkKey;
    const sdkSecret = credentials.sdkSecret;
    if (!sdkKey || !sdkSecret) {
      throw new Error('Zoom Meeting SDK credentials are not configured');
    }

    const issuedAt = Math.floor(Date.now() / 1000) - 30; // small clock skew allowance
    const expiresAtSeconds = issuedAt + SDK_SIGNATURE_TTL_SECONDS;
    const roleValue = args.role === 'host' ? 1 : 0;

    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        appKey: sdkKey,
        sdkKey,
        mn: args.providerMeetingId,
        role: roleValue,
        iat: issuedAt,
        exp: expiresAtSeconds,
        tokenExp: expiresAtSeconds,
        // Atlas's own deterministic identity, echoed back on webhooks.
        // This is what makes attendance exact rather than name-matched.
        customer_key: args.participantKey,
      }),
    );

    const signature = createHmac('sha256', sdkSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    return {
      signature: `${header}.${payload}.${signature}`,
      sdkKey,
      providerMeetingId: args.providerMeetingId,
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  /**
   * The host's ZAK — what actually lets a host START a meeting.
   *
   * WHY THIS IS NOT OPTIONAL. Atlas creates meetings with
   * `join_before_host: false`, so the room stays shut until the host
   * opens it. A Meeting SDK client joining with role 1 but no ZAK is not
   * treated as the host: it lands in "waiting for the host to start this
   * meeting" — and because nobody may join before the host, the entire
   * session is unreachable for everyone. The ZAK is the difference between
   * a class that happens and a class that does not.
   *
   * Meetings are created under `/users/me/meetings`, so `me` IS the host
   * this token must belong to — the same Zoom identity in both calls.
   *
   * THIS IS A CREDENTIAL. It authorizes starting meetings as that user,
   * so it is minted per join, returned only to a verified host, and never
   * stored, logged, or included in any student-facing response.
   */
  async fetchHostZak(accessToken: string): Promise<string> {
    const result = await this.call<{ token?: string }>(
      accessToken,
      '/users/me/token?type=zak',
    );
    if (!result?.token) {
      throw new Error('Zoom did not return a host start token');
    }
    return result.token;
  }

  async fetchParticipantIntervals(
    accessToken: string,
    providerMeetingId: string,
  ): Promise<readonly ProviderParticipantInterval[]> {
    // Zoom paginates this report; every page is followed so a long session
    // does not silently lose the participants past the first page.
    const intervals: ProviderParticipantInterval[] = [];
    let nextPageToken: string | undefined;

    do {
      const query = new URLSearchParams({ page_size: '300' });
      if (nextPageToken) query.set('next_page_token', nextPageToken);

      const page = await this.call<{
        participants?: {
          id?: string;
          user_id?: string;
          customer_key?: string;
          join_time?: string;
          leave_time?: string;
        }[];
        next_page_token?: string;
      }>(accessToken, `/report/meetings/${providerMeetingId}/participants?${query}`);

      for (const participant of page.participants ?? []) {
        if (!participant.join_time) continue;
        intervals.push({
          // `customer_key` is the Atlas identity we supplied at join.
          participantKey: participant.customer_key,
          providerParticipantId: participant.id ?? participant.user_id,
          joinedAt: new Date(participant.join_time),
          leftAt: participant.leave_time ? new Date(participant.leave_time) : undefined,
        });
      }

      nextPageToken = page.next_page_token || undefined;
    } while (nextPageToken);

    return intervals;
  }

  async fetchRecordingFiles(
    accessToken: string,
    providerMeetingId: string,
  ): Promise<readonly ProviderRecordingFile[]> {
    const result = await this.call<{
      recording_files?: {
        id?: string;
        file_type?: string;
        file_size?: number;
        download_url?: string;
      }[];
    }>(accessToken, `/meetings/${providerMeetingId}/recordings`);

    return (result.recording_files ?? [])
      .filter((file) => Boolean(file.id))
      .map((file) => ({
        providerFileId: file.id!,
        fileType: file.file_type,
        sizeBytes: file.file_size,
        downloadUrl: file.download_url,
      }));
  }

  /**
   * Zoom signs webhooks as `v0=HMAC_SHA256(secret, "v0:" + ts + ":" + body)`.
   *
   * Compared with `timingSafeEqual`, never `===`: a byte-by-byte early
   * return leaks how much of a forged signature was correct, which is
   * enough to reconstruct one given enough attempts.
   */
  verifyWebhookSignature(
    secretToken: string | undefined,
    args: {
      readonly rawBody: string;
      readonly signature: string;
      readonly timestamp: string;
    },
  ): boolean {
    const secret = secretToken;
    if (!secret) return false;

    const expected =
      'v0=' +
      createHmac('sha256', secret)
        .update(`v0:${args.timestamp}:${args.rawBody}`)
        .digest('hex');

    const provided = Buffer.from(args.signature);
    const computed = Buffer.from(expected);
    // Length must match before `timingSafeEqual`, which throws otherwise.
    if (provided.length !== computed.length) return false;
    return timingSafeEqual(provided, computed);
  }
}
