/**
 * The Live Sessions sweep.
 *
 * Almost every test here is about the sweep DECLINING to act, because a
 * recurring job's failure mode is not doing too little — it is doing
 * something wrong to every tenant, every few minutes, forever:
 *
 *   * reminding students about a class that was cancelled
 *   * reminding them twice because two instances swept at once
 *   * announcing a time that a reschedule already superseded
 *   * treating a report that is not ready yet as "nobody attended", and
 *     deleting the real attendance to record that
 *   * retrying a report that will never exist, on every tick, for ever
 */
import { Test } from '@nestjs/testing';
import { LiveSessionSweepService } from './live-session-sweep.service';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { LiveSessionNotificationsService } from './live-session-notifications.service';
import { ZoomOAuthService } from './zoom-oauth.service';
import { AttendanceService } from './attendance.service';
import { ZoomProvider } from '../providers/zoom.provider';
import { MAX_RECONCILIATION_ATTEMPTS } from '../queue/live-session-sweep.types';

const NOW = new Date('2026-10-01T09:50:00Z');

describe('LiveSessionSweepService', () => {
  let service: LiveSessionSweepService;
  let findMany: jest.Mock;
  let updateMany: jest.Mock;
  let update: jest.Mock;
  let notifyEnrolledStudents: jest.Mock;
  let fetchParticipantIntervals: jest.Mock;
  let reconcileFromProviderReport: jest.Mock;
  let findUniqueConnection: jest.Mock;
  let findFirstPlatformOwnerId: jest.Mock;
  let getAccessTokenForAcademy: jest.Mock;

  const dueSession = (over: Record<string, unknown> = {}) => ({
    id: 'session-1',
    courseId: 'course-1',
    academyId: 'academy-1',
    title: 'Algebra II',
    scheduledStartAt: new Date('2026-10-01T10:00:00Z'),
    academy: { organizationId: 'org-1' },
    ...over,
  });

  const endedSession = (over: Record<string, unknown> = {}) => ({
    id: 'session-2',
    academyId: 'academy-1',
    providerMeetingId: '99887766',
    academy: { organizationId: 'org-1' },
    ...over,
  });

  beforeEach(async () => {
    findMany = jest.fn().mockResolvedValue([]);
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    update = jest.fn().mockResolvedValue(undefined);
    notifyEnrolledStudents = jest.fn().mockResolvedValue(undefined);
    fetchParticipantIntervals = jest.fn().mockResolvedValue([]);
    reconcileFromProviderReport = jest
      .fn()
      .mockResolvedValue({ recorded: 3, unmatched: 0 });
    findUniqueConnection = jest
      .fn()
      .mockResolvedValue({ status: 'connected', encryptedCredentials: 'c' });
    findFirstPlatformOwnerId = jest.fn().mockResolvedValue({ id: 'owner-1' });
    getAccessTokenForAcademy = jest.fn().mockResolvedValue('access-token');

    const tx = {
      liveSession: { findMany, updateMany, update },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSessionSweepService,
        {
          provide: PrismaService,
          useValue: {
            academyLiveProviderConnection: { findUnique: findUniqueConnection },
          },
        },
        {
          provide: TenancyContextService,
          useValue: {
            runInUserContext: (_u: string, fn: (t: unknown) => unknown) => fn(tx),
            runInTenantContext: (_o: string, fn: (t: unknown) => unknown) => fn(tx),
          },
        },
        { provide: UsersRepository, useValue: { findFirstPlatformOwnerId } },
        {
          provide: LiveSessionNotificationsService,
          useValue: { notifyEnrolledStudents },
        },
        {
          // Refresh and rotation belong to the OAuth service; the sweep
          // only ever asks for a usable token.
          provide: ZoomOAuthService,
          useValue: { getAccessTokenForAcademy: getAccessTokenForAcademy },
        },
        { provide: AttendanceService, useValue: { reconcileFromProviderReport } },
        { provide: ZoomProvider, useValue: { fetchParticipantIntervals } },
      ],
    }).compile();

    service = moduleRef.get(LiveSessionSweepService);
  });

  /** Reminders pass sees `sessions`, reconciliation pass sees none. */
  const withReminderCandidates = (sessions: unknown[]) => {
    findMany.mockResolvedValueOnce(sessions).mockResolvedValueOnce([]);
  };
  const withEndedCandidates = (sessions: unknown[]) => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(sessions);
  };

  describe('starting-soon reminders', () => {
    it('reminds students about a class starting soon', async () => {
      withReminderCandidates([dueSession()]);
      const result = await service.run(NOW);

      expect(result.remindersSent).toBe(1);
      expect(notifyEnrolledStudents).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ event: 'starting_soon', liveSessionId: 'session-1' }),
      );
    });

    /*
     * THE CANCELLED CLASS. Enforced by the query's status filter, so it
     * cannot be forgotten by a later caller.
     */
    it('only ever selects SCHEDULED sessions', async () => {
      withReminderCandidates([]);
      await service.run(NOW);

      expect(findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'scheduled',
            startingSoonNotifiedAt: null,
          }),
        }),
      );
    });

    /*
     * TWO INSTANCES, ONE REMINDER. Both selected the row; the conditional
     * claim decides. Without it a class of 200 gets 400 notifications.
     */
    it('does NOT fan out when another instance claimed the session first', async () => {
      withReminderCandidates([dueSession()]);
      updateMany.mockResolvedValue({ count: 0 });

      const result = await service.run(NOW);

      expect(result.remindersSent).toBe(0);
      expect(notifyEnrolledStudents).not.toHaveBeenCalled();
    });

    /* The claim is re-checked against `scheduled` INSIDE the transaction. */
    it('re-checks the status when claiming, not only when selecting', async () => {
      withReminderCandidates([dueSession()]);
      await service.run(NOW);

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'scheduled',
            startingSoonNotifiedAt: null,
          }),
        }),
      );
    });

    it('stamps the session so the next tick skips it', async () => {
      withReminderCandidates([dueSession()]);
      await service.run(NOW);

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { startingSoonNotifiedAt: NOW } }),
      );
    });

    /* One tenant's failure must not cost every other tenant its reminders. */
    it('continues to the next session when one tenant fails', async () => {
      withReminderCandidates([dueSession(), dueSession({ id: 'session-9' })]);
      notifyEnrolledStudents
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined);

      const result = await service.run(NOW);

      expect(result.remindersSent).toBe(1);
    });

    /* No platform owner means no cross-tenant read — it must fail closed, not crash. */
    it('does nothing when no platform owner exists', async () => {
      findFirstPlatformOwnerId.mockResolvedValue(null);
      const result = await service.run(NOW);

      expect(result.remindersSent).toBe(0);
      expect(notifyEnrolledStudents).not.toHaveBeenCalled();
    });
  });

  describe('attendance reconciliation', () => {
    it('applies the provider report to an ended session', async () => {
      withEndedCandidates([endedSession()]);
      fetchParticipantIntervals.mockResolvedValue([
        { participantKey: 'atlas_a', joinedAt: new Date(), leftAt: new Date() },
      ]);

      const result = await service.run(NOW);

      expect(result.sessionsReconciled).toBe(1);
      expect(reconcileFromProviderReport).toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { attendanceReconciledAt: NOW } }),
      );
    });

    /*
     * THE MOST DESTRUCTIVE POSSIBLE BUG IN THIS FILE.
     *
     * An empty report is indistinguishable from "not ready yet". Applying
     * it would DELETE every real webhook interval and record that nobody
     * attended the class. It is never applied.
     */
    it('NEVER applies an empty report', async () => {
      withEndedCandidates([endedSession()]);
      fetchParticipantIntervals.mockResolvedValue([]);

      const result = await service.run(NOW);

      expect(reconcileFromProviderReport).not.toHaveBeenCalled();
      expect(result.sessionsReconciled).toBe(0);
      // Deliberately NOT stamped — a later tick may find a real report.
      expect(update).not.toHaveBeenCalled();
    });

    /*
     * THE ATTEMPT IS CHARGED BEFORE THE CALL. Counting afterwards means a
     * call that throws never increments, and the session is retried for
     * ever.
     */
    it('counts the attempt even when the provider call throws', async () => {
      withEndedCandidates([endedSession()]);
      fetchParticipantIntervals.mockRejectedValue(new Error('zoom down'));

      const result = await service.run(NOW);

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { reconciliationAttempts: { increment: 1 } },
        }),
      );
      expect(result.reconciliationFailures).toBe(1);
    });

    it('stops selecting a session once its attempts are exhausted', async () => {
      withEndedCandidates([]);
      await service.run(NOW);

      expect(findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({
            reconciliationAttempts: { lt: MAX_RECONCILIATION_ATTEMPTS },
            attendanceReconciledAt: null,
            status: 'ended',
          }),
        }),
      );
    });

    /* A disconnected academy has nothing to reconcile against — not an error. */
    /* A dead authorization is not an Atlas error — the tick continues. */
    it('counts a failure when the authorization can no longer be refreshed', async () => {
      withEndedCandidates([endedSession()]);
      getAccessTokenForAcademy.mockRejectedValue(new Error('reconnect required'));

      const result = await service.run(NOW);

      expect(fetchParticipantIntervals).not.toHaveBeenCalled();
      expect(result.reconciliationFailures).toBe(1);
      expect(reconcileFromProviderReport).not.toHaveBeenCalled();
    });

    it('skips a session whose academy disconnected the provider', async () => {
      withEndedCandidates([endedSession()]);
      findUniqueConnection.mockResolvedValue(null);

      const result = await service.run(NOW);

      expect(fetchParticipantIntervals).not.toHaveBeenCalled();
      expect(result.sessionsReconciled).toBe(0);
      expect(result.reconciliationFailures).toBe(0);
    });

    it('only selects sessions that actually have a provider meeting', async () => {
      withEndedCandidates([]);
      await service.run(NOW);

      expect(findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({ providerMeetingId: { not: null } }),
        }),
      );
    });

    it('keeps reconciling other sessions after one fails', async () => {
      withEndedCandidates([endedSession(), endedSession({ id: 'session-3' })]);
      fetchParticipantIntervals
        .mockRejectedValueOnce(new Error('zoom down'))
        .mockResolvedValue([{ participantKey: 'atlas_a', joinedAt: new Date() }]);

      const result = await service.run(NOW);

      expect(result.reconciliationFailures).toBe(1);
      expect(result.sessionsReconciled).toBe(1);
    });
  });
});
