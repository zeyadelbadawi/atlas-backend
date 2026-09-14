/**
 * Publishing a session — the transition that creates a real meeting.
 *
 * The interesting cases are all about the gap between "Atlas committed"
 * and "the provider did something", because that gap is where a scheduled
 * job or a retried request can strand a meeting nobody can reach, or spend
 * an allowance nobody used.
 */
import { Test } from '@nestjs/testing';
import { LiveSessionProvisioningService } from './live-session-provisioning.service';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { LiveProviderConnectionService } from './live-provider-connection.service';
import { LiveSessionNotificationsService } from './live-session-notifications.service';
import { RecordingQuotaService } from './recording-quota.service';
import { ZoomProvider } from '../providers/zoom.provider';

const ACADEMY_ID = 'academy-1';
const ORG_ID = 'org-1';
const SESSION_ID = 'session-1';

describe('LiveSessionProvisioningService.publish', () => {
  let service: LiveSessionProvisioningService;
  let createMeeting: jest.Mock;
  let cancelMeeting: jest.Mock;
  let updateMeeting: jest.Mock;
  let findFirst: jest.Mock;
  let updateMany: jest.Mock;
  let notifyEnrolledStudents: jest.Mock;
  let describeUsage: jest.Mock;
  let findUniqueConnection: jest.Mock;
  let sessionUpdate: jest.Mock;

  const sessionRow = (over: Record<string, unknown> = {}) => ({
    id: SESSION_ID,
    title: 'Algebra II',
    description: null,
    status: 'draft',
    courseId: 'course-1',
    providerMeetingId: null,
    scheduledStartAt: new Date('2026-10-01T10:00:00Z'),
    scheduledEndAt: new Date('2026-10-01T11:00:00Z'),
    recordingEnabled: false,
    ...over,
  });

  beforeEach(async () => {
    createMeeting = jest.fn().mockResolvedValue({ providerMeetingId: '99887766' });
    cancelMeeting = jest.fn().mockResolvedValue(undefined);
    updateMeeting = jest.fn().mockResolvedValue(undefined);
    findFirst = jest.fn().mockResolvedValue(sessionRow());
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    sessionUpdate = jest.fn().mockResolvedValue(undefined);
    notifyEnrolledStudents = jest.fn().mockResolvedValue(undefined);
    describeUsage = jest.fn().mockResolvedValue({ used: 0, limit: 10, remaining: 10 });
    findUniqueConnection = jest.fn().mockResolvedValue({
      academyId: ACADEMY_ID,
      status: 'connected',
      encryptedCredentials: 'cipher',
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSessionProvisioningService,
        {
          provide: PrismaService,
          useValue: {
            academyLiveProviderConnection: { findUnique: findUniqueConnection },
          },
        },
        {
          provide: TenancyContextService,
          useValue: {
            runInTenantContext: (_o: string, fn: (tx: unknown) => unknown) =>
              fn({
                liveSession: {
                  findFirst,
                  updateMany,
                  update: sessionUpdate,
                },
              }),
          },
        },
        {
          provide: LiveProviderConnectionService,
          useValue: {
            decryptCredentials: jest.fn().mockResolvedValue({
              accountId: 'a',
              clientId: 'b',
              clientSecret: 'c',
            }),
          },
        },
        {
          provide: LiveSessionNotificationsService,
          useValue: { notifyEnrolledStudents },
        },
        { provide: RecordingQuotaService, useValue: { describeUsage } },
        {
          provide: ZoomProvider,
          useValue: { createMeeting, cancelMeeting, updateMeeting },
        },
      ],
    }).compile();

    service = moduleRef.get(LiveSessionProvisioningService);
  });

  const publish = () =>
    service.publish({
      academyId: ACADEMY_ID,
      organizationId: ORG_ID,
      liveSessionId: SESSION_ID,
    });

  it('creates the meeting and stores its id', async () => {
    const result = await publish();
    expect(createMeeting).toHaveBeenCalledTimes(1);
    expect(result.providerMeetingId).toBe('99887766');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerMeetingId: '99887766',
          status: 'scheduled',
        }),
      }),
    );
  });

  /*
   * RECORDING IS OFF AT THE PROVIDER UNLESS ATLAS SAYS OTHERWISE. This is
   * the rule that stops a Zoom account configured to "record everything"
   * from manufacturing recordings Atlas never asked for.
   */
  it('tells the provider NOT to auto-record by default', async () => {
    await publish();
    expect(createMeeting).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoRecord: false }),
    );
  });

  it('asks for provider recording only when the session enables it', async () => {
    findFirst.mockResolvedValue(sessionRow({ recordingEnabled: true }));
    await publish();
    expect(createMeeting).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoRecord: true }),
    );
  });

  it('sends the scheduled duration in minutes', async () => {
    await publish();
    expect(createMeeting).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ durationMinutes: 60 }),
    );
  });

  it('announces the session to enrolled students, in the same transaction', async () => {
    await publish();
    expect(notifyEnrolledStudents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'scheduled', liveSessionId: SESSION_ID }),
    );
  });

  /*
   * IDEMPOTENCE. A retried publish must not create a second meeting — the
   * academy would find two rooms in their Zoom account for one class.
   */
  it('does NOT create a second meeting for an already-published session', async () => {
    findFirst.mockResolvedValue(
      sessionRow({ providerMeetingId: '111', status: 'scheduled' }),
    );
    const result = await publish();
    expect(createMeeting).not.toHaveBeenCalled();
    expect(result.alreadyPublished).toBe(true);
  });

  /*
   * THE RACE. Two simultaneous publishes each create a meeting; only one
   * can be stored. The loser must clean up after itself rather than
   * leaving an orphan meeting in the customer's account.
   */
  it('cancels the meeting it created when another publish won the race', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findFirst
      .mockResolvedValueOnce(sessionRow())
      .mockResolvedValue(sessionRow({ providerMeetingId: 'winner' }));

    const result = await publish();

    expect(cancelMeeting).toHaveBeenCalledWith(expect.anything(), '99887766');
    expect(result.providerMeetingId).toBe('winner');
    expect(notifyEnrolledStudents).not.toHaveBeenCalled();
  });

  /* The same compensation when the commit itself fails. */
  it('cancels the meeting it created when the commit throws', async () => {
    updateMany.mockRejectedValue(new Error('db down'));
    await expect(publish()).rejects.toThrow('db down');
    expect(cancelMeeting).toHaveBeenCalledWith(expect.anything(), '99887766');
  });

  /* A failed compensation must not replace the real error. */
  it('surfaces the original failure even if the compensating cancel also fails', async () => {
    updateMany.mockRejectedValue(new Error('db down'));
    cancelMeeting.mockRejectedValue(new Error('zoom down'));
    await expect(publish()).rejects.toThrow('db down');
  });

  it('refuses when the academy has no healthy provider connection', async () => {
    findUniqueConnection.mockResolvedValue(null);
    await expect(publish()).rejects.toMatchObject({
      response: { messageKey: 'errors.liveSessions.providerNotConnected' },
    });
    expect(createMeeting).not.toHaveBeenCalled();
  });

  it('refuses when the connection exists but is not connected', async () => {
    findUniqueConnection.mockResolvedValue({ status: 'error' });
    await expect(publish()).rejects.toMatchObject({
      response: { messageKey: 'errors.liveSessions.providerNotConnected' },
    });
  });

  /*
   * A RECORDED SESSION IS REFUSED UP FRONT WHEN THERE IS NO ALLOWANCE —
   * better than creating a meeting that will silently fail to record.
   */
  it('refuses to publish a recorded session with no allowance left', async () => {
    findFirst.mockResolvedValue(sessionRow({ recordingEnabled: true }));
    describeUsage.mockResolvedValue({ used: 10, limit: 10, remaining: 0 });
    await expect(publish()).rejects.toMatchObject({
      response: { messageKey: 'errors.liveSessions.recordingQuotaExceeded' },
    });
    expect(createMeeting).not.toHaveBeenCalled();
  });

  it('allows a recorded session on an unlimited plan', async () => {
    findFirst.mockResolvedValue(sessionRow({ recordingEnabled: true }));
    describeUsage.mockResolvedValue({ used: 999, limit: 'unlimited', remaining: null });
    await expect(publish()).resolves.toBeDefined();
  });

  /* An unrecorded session is never blocked by a recording allowance. */
  it('publishes an unrecorded session even with no allowance left', async () => {
    describeUsage.mockResolvedValue({ used: 10, limit: 10, remaining: 0 });
    await expect(publish()).resolves.toBeDefined();
  });

  it('refuses to publish a cancelled session', async () => {
    findFirst.mockResolvedValue(sessionRow({ status: 'cancelled' }));
    await expect(publish()).rejects.toMatchObject({
      response: { messageKey: 'errors.liveSessions.notPublishable' },
    });
  });

  it('refuses to publish a session that already ended', async () => {
    findFirst.mockResolvedValue(sessionRow({ status: 'ended' }));
    await expect(publish()).rejects.toThrow();
    expect(createMeeting).not.toHaveBeenCalled();
  });
});

describe('LiveSessionProvisioningService.applyCancellation', () => {
  let service: LiveSessionProvisioningService;
  let cancelMeeting: jest.Mock;
  let notifyEnrolledStudents: jest.Mock;
  let findFirst: jest.Mock;

  beforeEach(async () => {
    cancelMeeting = jest.fn().mockResolvedValue(undefined);
    notifyEnrolledStudents = jest.fn().mockResolvedValue(undefined);
    findFirst = jest.fn().mockResolvedValue({
      id: SESSION_ID,
      title: 'Algebra II',
      courseId: 'course-1',
      providerMeetingId: '99887766',
      scheduledStartAt: new Date('2026-10-01T10:00:00Z'),
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSessionProvisioningService,
        {
          provide: PrismaService,
          useValue: {
            academyLiveProviderConnection: {
              findUnique: jest
                .fn()
                .mockResolvedValue({ status: 'connected', encryptedCredentials: 'c' }),
            },
          },
        },
        {
          provide: TenancyContextService,
          useValue: {
            runInTenantContext: (_o: string, fn: (tx: unknown) => unknown) =>
              fn({ liveSession: { findFirst } }),
          },
        },
        {
          provide: LiveProviderConnectionService,
          useValue: { decryptCredentials: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: LiveSessionNotificationsService,
          useValue: { notifyEnrolledStudents },
        },
        { provide: RecordingQuotaService, useValue: { describeUsage: jest.fn() } },
        { provide: ZoomProvider, useValue: { cancelMeeting } },
      ],
    }).compile();

    service = moduleRef.get(LiveSessionProvisioningService);
  });

  const cancel = () =>
    service.applyCancellation({
      academyId: ACADEMY_ID,
      organizationId: ORG_ID,
      liveSessionId: SESSION_ID,
    });

  it('cancels at the provider and tells the students', async () => {
    await cancel();
    expect(cancelMeeting).toHaveBeenCalledWith(expect.anything(), '99887766');
    expect(notifyEnrolledStudents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'cancelled' }),
    );
  });

  /*
   * ATLAS IS AUTHORITATIVE. A Zoom outage must not stop an instructor
   * cancelling a class, and the students must still be told — the room
   * becomes one nobody is authorized to enter.
   */
  it('still notifies students when the provider cancellation fails', async () => {
    cancelMeeting.mockRejectedValue(new Error('zoom down'));
    await expect(cancel()).resolves.toBeUndefined();
    expect(notifyEnrolledStudents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'cancelled' }),
    );
  });

  it('notifies students for a session that was never published', async () => {
    findFirst.mockResolvedValue({
      id: SESSION_ID,
      title: 'Algebra II',
      courseId: 'course-1',
      providerMeetingId: null,
      scheduledStartAt: new Date('2026-10-01T10:00:00Z'),
    });
    await cancel();
    expect(cancelMeeting).not.toHaveBeenCalled();
    expect(notifyEnrolledStudents).toHaveBeenCalled();
  });
});
