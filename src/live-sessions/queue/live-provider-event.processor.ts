/**
 * Processes a verified Zoom event.
 *
 * By the time a job reaches here the signature has been checked and the
 * event recorded, so this worker's job is interpretation — and its main
 * responsibility is refusing to do the wrong thing:
 *
 *   * OUT-OF-ORDER EVENTS MUST NOT REGRESS TERMINAL STATE. Zoom does not
 *     guarantee ordering, so a delayed `meeting.started` can arrive after
 *     `meeting.ended`. Every transition below is guarded so a later event
 *     cannot move a session backwards out of `ended`.
 *   * A RECORDING EVENT FOR A SESSION ATLAS DID NOT ASK TO RECORD IS
 *     IGNORED. This is the concrete mechanism by which a Zoom account
 *     whose own default is "record everything" cannot manufacture an
 *     Atlas recording — checked here, not only at meeting-creation time.
 *   * IDENTITY IS EXACT. Attendance is matched on the opaque
 *     `participantKey` Atlas itself minted. An event naming a participant
 *     Atlas never authorized is recorded as unmatched, never guessed onto
 *     a nearby student.
 *
 * An event that resolves to no known session is marked `unmatched` rather
 * than dropped: silent discard is indistinguishable from a bug when
 * somebody later asks why attendance is missing.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { LiveProviderConnectionService } from '../services/live-provider-connection.service';
import { AttendanceService } from '../services/attendance.service';
import { RecordingQuotaService } from '../services/recording-quota.service';
import { RecordingImportService } from '../services/recording-import.service';
import { LiveSessionNotificationsService } from '../services/live-session-notifications.service';
import { LiveProviderEventsRepository } from '../repositories/live-provider-events.repository';
import {
  LIVE_PROVIDER_EVENT_QUEUE,
  ProcessLiveProviderEventJobPayload,
} from './live-provider-event.types';

/** Statuses a session can never be moved OUT of by a late-arriving event. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['ended', 'cancelled']);

@Processor(LIVE_PROVIDER_EVENT_QUEUE)
export class LiveProviderEventProcessor extends WorkerHost {
  private readonly logger = new Logger(LiveProviderEventProcessor.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly connectionService: LiveProviderConnectionService,
    private readonly attendanceService: AttendanceService,
    private readonly recordingQuotaService: RecordingQuotaService,
    private readonly recordingImportService: RecordingImportService,
    private readonly notifications: LiveSessionNotificationsService,
    private readonly eventsRepository: LiveProviderEventsRepository,
  ) {
    super();
  }

  async process(job: Job<ProcessLiveProviderEventJobPayload>): Promise<void> {
    const payload = job.data;

    if (!payload.providerMeetingId) {
      await this.eventsRepository.markResolved(payload.providerEventId, 'unmatched');
      return;
    }

    /*
      Resolved from a provider identifier Atlas itself stored — never from
      anything the request body claimed about tenancy.

      Delegated to the connection service because the lookup needs a
      PLATFORM-OWNER context: `live_sessions` is RLS-protected with FORCE
      and a queue worker has no tenant context of its own. Doing it here
      with the plain client silently found nothing and marked every event
      `unmatched` — caught by an integration test.
    */
    const session = await this.connectionService.findSessionForMeeting(
      payload.providerMeetingId,
    );

    if (!session) {
      await this.eventsRepository.markResolved(payload.providerEventId, 'unmatched');
      this.logger.warn(
        { eventType: payload.eventType },
        'Provider event referenced a meeting Atlas does not know.',
      );
      return;
    }

    const organizationId = session.organizationId;

    try {
      switch (payload.eventType) {
        case 'meeting.started':
          await this.handleStarted(session.id, session.status, organizationId);
          break;

        case 'meeting.ended':
          await this.handleEnded(session.id, session.status, organizationId);
          break;

        case 'meeting.participant_joined':
        case 'meeting.participant_left':
          await this.handleAttendance(session.id, organizationId, payload);
          break;

        case 'recording.completed':
          await this.handleRecordingCompleted(
            session.id,
            session.academyId,
            organizationId,
            session.recordingEnabled,
            payload.providerMeetingId,
          );
          break;

        default:
          // An event type Atlas has no opinion about. Recorded as
          // processed so it is visibly accounted for rather than looking
          // like something that failed.
          break;
      }

      await this.eventsRepository.markResolved(payload.providerEventId, 'processed', {
        academyId: session.academyId,
        liveSessionId: session.id,
      });
    } catch (error) {
      await this.eventsRepository.markResolved(payload.providerEventId, 'failed', {
        academyId: session.academyId,
        liveSessionId: session.id,
        failureReason: 'processing_failed',
      });
      // Rethrow so BullMQ retries with backoff — the row above records
      // the attempt either way.
      throw error;
    }
  }

  /** `scheduled` → `live`. Never moves a session out of a terminal state. */
  private async handleStarted(
    liveSessionId: string,
    currentStatus: string,
    organizationId: string,
  ): Promise<void> {
    if (TERMINAL_STATUSES.has(currentStatus)) return;

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.liveSession.updateMany({
        // The status predicate is the ordering guard: a delayed
        // `meeting.started` that arrives after `meeting.ended` matches
        // nothing, so it cannot resurrect a finished class.
        where: { id: liveSessionId, status: { in: ['scheduled', 'draft'] } },
        data: { status: 'live', startedAt: new Date() },
      }),
    );
  }

  /**
   * `live` → `ended`, then attendance reconciliation is scheduled.
   *
   * Reconciliation is NOT done inline: Zoom's participant report is not
   * immediately complete when a meeting ends, and blocking this worker on
   * it would hold a queue slot for a report that is not ready.
   */
  private async handleEnded(
    liveSessionId: string,
    currentStatus: string,
    organizationId: string,
  ): Promise<void> {
    if (TERMINAL_STATUSES.has(currentStatus)) return;

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.liveSession.updateMany({
        where: { id: liveSessionId, status: { in: ['live', 'scheduled'] } },
        data: { status: 'ended', endedAt: new Date() },
      }),
    );
  }

  /**
   * One join or leave interval.
   *
   * Delegated to `AttendanceService`, which owns the exact-identity rule
   * and the event-key deduplication — this worker never matches
   * participants itself.
   */
  private async handleAttendance(
    liveSessionId: string,
    organizationId: string,
    payload: ProcessLiveProviderEventJobPayload,
  ): Promise<void> {
    if (!payload.participantKey) {
      // No Atlas identity on the event. Deliberately NOT guessed from a
      // display name or email.
      this.logger.warn(
        { liveSessionId },
        'Attendance event carried no Atlas participant key — ignored.',
      );
      return;
    }

    const joinedAt = payload.joinedAt ? new Date(payload.joinedAt) : undefined;
    const leftAt = payload.leftAt ? new Date(payload.leftAt) : undefined;

    // A leave event with no join time still describes an interval; its
    // start is the join time Zoom echoes back on the same participant.
    if (!joinedAt) return;

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      this.attendanceService.recordWebhookInterval(tx, {
        liveSessionId,
        participantKey: payload.participantKey!,
        joinedAt,
        leftAt,
        providerParticipantId: payload.providerParticipantId,
        providerEventId: payload.providerEventId,
      }),
    );
  }

  /**
   * A provider recording finished.
   *
   * THE ATLAS POLICY CHECK IS THE WHOLE POINT. If this session was not
   * recorded at Atlas's request, the event is ignored entirely — no quota
   * is charged, no files are fetched, nothing is imported. That is what
   * stops a Zoom account-level "record everything" setting from becoming
   * an Atlas recording.
   */
  private async handleRecordingCompleted(
    liveSessionId: string,
    academyId: string,
    organizationId: string,
    recordingEnabled: boolean,
    providerMeetingId: string,
  ): Promise<void> {
    if (!recordingEnabled) {
      this.logger.log(
        { liveSessionId },
        'Provider recording ignored — Atlas recording policy is off for this session.',
      );
      return;
    }

    // Charging happens inside one transaction that also takes the
    // serialization lock; a duplicate event finds `quota_consumed_at`
    // already set and is a no-op rather than a second charge.
    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      this.recordingQuotaService.consumeForSession(tx, {
        organizationId,
        liveSessionId,
        academyId,
      }),
    );

    await this.recordingImportService.importForSession({
      liveSessionId,
      academyId,
      organizationId,
      providerMeetingId,
    });

    await this.notifications.notifyRecordingAvailable(liveSessionId, organizationId);
  }
}
