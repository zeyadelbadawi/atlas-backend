/**
 * The provider-event worker's refusals.
 *
 * Every test here is about the worker declining to do something, because
 * that is where the product rules actually live:
 *
 *   * a recording event for a session Atlas did not ask to record
 *   * a late event trying to resurrect a finished session
 *   * an attendance event with no Atlas identity attached
 *   * an event naming a meeting no tenant owns
 */
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { LiveProviderEventProcessor } from './live-provider-event.processor';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { LiveProviderConnectionService } from '../services/live-provider-connection.service';
import { AttendanceService } from '../services/attendance.service';
import { RecordingQuotaService } from '../services/recording-quota.service';
import { RecordingImportService } from '../services/recording-import.service';
import { LiveSessionNotificationsService } from '../services/live-session-notifications.service';
import { LiveProviderEventsRepository } from '../repositories/live-provider-events.repository';
import type { ProcessLiveProviderEventJobPayload } from './live-provider-event.types';

const MEETING_ID = 'zoom-meeting-1';
const SESSION_ID = 'session-1';
const ACADEMY_ID = 'academy-1';
const ORG_ID = 'org-1';

describe('LiveProviderEventProcessor', () => {
  let processor: LiveProviderEventProcessor;
  let findSessionForMeeting: jest.Mock;
  let updateMany: jest.Mock;
  let consumeForSession: jest.Mock;
  let importForSession: jest.Mock;
  let recordWebhookInterval: jest.Mock;
  let markResolved: jest.Mock;
  let notifyRecordingAvailable: jest.Mock;

  const session = (over: Record<string, unknown> = {}) => ({
    id: SESSION_ID,
    academyId: ACADEMY_ID,
    organizationId: ORG_ID,
    status: 'live',
    recordingEnabled: false,
    ...over,
  });

  beforeEach(async () => {
    findSessionForMeeting = jest.fn().mockResolvedValue(session());
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    consumeForSession = jest.fn().mockResolvedValue(true);
    importForSession = jest.fn().mockResolvedValue({ imported: 1, failed: 0 });
    recordWebhookInterval = jest.fn().mockResolvedValue(true);
    markResolved = jest.fn().mockResolvedValue(undefined);
    notifyRecordingAvailable = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveProviderEventProcessor,
        {
          // The attribution lookup needs a PLATFORM-OWNER context because
          // `live_sessions` is RLS-protected; the worker delegates it
          // rather than reaching for a raw client of its own.
          provide: LiveProviderConnectionService,
          useValue: { findSessionForMeeting },
        },
        {
          provide: TenancyContextService,
          useValue: {
            runInTenantContext: (_o: string, fn: (tx: unknown) => unknown) =>
              fn({ liveSession: { updateMany } }),
          },
        },
        { provide: AttendanceService, useValue: { recordWebhookInterval } },
        { provide: RecordingQuotaService, useValue: { consumeForSession } },
        { provide: RecordingImportService, useValue: { importForSession } },
        {
          provide: LiveSessionNotificationsService,
          useValue: { notifyRecordingAvailable },
        },
        { provide: LiveProviderEventsRepository, useValue: { markResolved } },
      ],
    }).compile();

    processor = moduleRef.get(LiveProviderEventProcessor);
  });

  const run = (over: Partial<ProcessLiveProviderEventJobPayload> = {}) =>
    processor.process({
      data: {
        providerEventId: 'evt-1',
        eventType: 'meeting.started',
        providerMeetingId: MEETING_ID,
        occurredAt: new Date().toISOString(),
        ...over,
      },
    } as Job<ProcessLiveProviderEventJobPayload>);

  /*
   * THE MOST IMPORTANT TEST IN THIS FILE.
   *
   * A Zoom account can be configured to record every meeting. If Atlas
   * imported those, a customer would be charged recorded sessions they
   * never asked for, and students would get recordings of classes the
   * instructor chose not to record.
   */
  it('IGNORES a recording event when Atlas recording policy is OFF', async () => {
    findSessionForMeeting.mockResolvedValue(session({ recordingEnabled: false }));

    await run({ eventType: 'recording.completed' });

    expect(consumeForSession).not.toHaveBeenCalled();
    expect(importForSession).not.toHaveBeenCalled();
    expect(notifyRecordingAvailable).not.toHaveBeenCalled();
  });

  it('imports a recording when Atlas DID request it', async () => {
    findSessionForMeeting.mockResolvedValue(session({ recordingEnabled: true }));

    await run({ eventType: 'recording.completed' });

    expect(consumeForSession).toHaveBeenCalledTimes(1);
    expect(importForSession).toHaveBeenCalledTimes(1);
    expect(notifyRecordingAvailable).toHaveBeenCalledTimes(1);
  });

  it('charges quota BEFORE importing, so a failed import cannot bypass the limit', async () => {
    findSessionForMeeting.mockResolvedValue(session({ recordingEnabled: true }));
    const order: string[] = [];
    consumeForSession.mockImplementation(async () => {
      order.push('quota');
      return true;
    });
    importForSession.mockImplementation(async () => {
      order.push('import');
      return { imported: 1, failed: 0 };
    });

    await run({ eventType: 'recording.completed' });

    expect(order).toEqual(['quota', 'import']);
  });

  /* OUT-OF-ORDER DELIVERY. Zoom does not guarantee ordering. */
  it('does NOT resurrect an ended session when a late meeting.started arrives', async () => {
    findSessionForMeeting.mockResolvedValue(session({ status: 'ended' }));

    await run({ eventType: 'meeting.started' });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does NOT re-end a cancelled session', async () => {
    findSessionForMeeting.mockResolvedValue(session({ status: 'cancelled' }));

    await run({ eventType: 'meeting.ended' });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('guards the transition in the UPDATE predicate as well as the pre-check', async () => {
    findSessionForMeeting.mockResolvedValue(session({ status: 'scheduled' }));

    await run({ eventType: 'meeting.started' });

    // Belt and braces: even if the pre-check were bypassed, the status
    // predicate means a finished session matches zero rows.
    const where = updateMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['scheduled', 'draft'] });
  });

  /* IDENTITY. No name/email fallback anywhere. */
  it('IGNORES an attendance event with no Atlas participant key', async () => {
    await run({
      eventType: 'meeting.participant_joined',
      joinedAt: new Date().toISOString(),
      participantKey: undefined,
    });

    expect(recordWebhookInterval).not.toHaveBeenCalled();
  });

  it('records attendance when the Atlas identity is present', async () => {
    await run({
      eventType: 'meeting.participant_joined',
      participantKey: 'atlas_abc',
      joinedAt: new Date().toISOString(),
    });

    expect(recordWebhookInterval).toHaveBeenCalledTimes(1);
  });

  /* UNKNOWN MEETING. Surfaced, never silently dropped. */
  it('marks an event for an unknown meeting as unmatched', async () => {
    findSessionForMeeting.mockResolvedValue(null);

    await run({ eventType: 'meeting.started' });

    expect(markResolved).toHaveBeenCalledWith('evt-1', 'unmatched');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('marks an event with no meeting id as unmatched', async () => {
    await run({ providerMeetingId: undefined });
    expect(markResolved).toHaveBeenCalledWith('evt-1', 'unmatched');
  });

  it('records a processing failure and rethrows so BullMQ retries', async () => {
    findSessionForMeeting.mockResolvedValue(session({ recordingEnabled: true }));
    consumeForSession.mockRejectedValue(new Error('boom'));

    await expect(run({ eventType: 'recording.completed' })).rejects.toThrow();

    expect(markResolved).toHaveBeenCalledWith(
      'evt-1',
      'failed',
      expect.objectContaining({ failureReason: 'processing_failed' }),
    );
  });

  it('accepts an unknown event type without failing the job', async () => {
    await expect(
      run({ eventType: 'meeting.some_future_event' }),
    ).resolves.toBeUndefined();
    expect(markResolved).toHaveBeenCalledWith('evt-1', 'processed', expect.anything());
  });
});
