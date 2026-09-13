/**
 * LiveSessionAccessService — the join-eligibility rules.
 *
 * Written from the direction of ABUSE rather than the happy path, because
 * every rule here exists to refuse somebody: a student from another
 * academy holding a real session id, a student who was never enrolled, one
 * whose enrollment is merely `pending`, someone replaying a captured join
 * token. The happy path is covered too, but it is not what these are for.
 *
 * Mocked rather than run against Postgres: each branch is a pure decision
 * over a handful of rows, and two of them depend on the CLOCK, which is
 * far easier to control here than to arrange in real data. The database's
 * own independent refusal (RLS) is a separate layer with its own
 * verification — these tests prove the GUARD half of "guard decides, RLS
 * independently agrees".
 */
import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LiveSessionAccessService } from './live-session-access.service';
import { AddOnAccessService } from './add-on-access.service';

const SESSION_ID = 'session-1';
const ACADEMY_ID = 'academy-1';
const COURSE_ID = 'course-1';
const ORG_ID = 'org-1';
const STUDENT_ID = 'student-1';
const HOST_ID = 'instructor-1';

/** Scheduled comfortably "now" so the clock is never the reason a test fails. */
const START = new Date('2026-06-01T10:00:00.000Z');
const END = new Date('2026-06-01T11:00:00.000Z');
const DURING = new Date('2026-06-01T10:30:00.000Z');

describe('LiveSessionAccessService', () => {
  let service: LiveSessionAccessService;
  let tx: {
    liveSession: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    enrollment: { findFirst: jest.Mock };
    academyLiveProviderConnection: { findUnique: jest.Mock };
    liveSessionParticipant: { upsert: jest.Mock };
    liveSessionJoinGrant: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };
  let describeAddOn: jest.Mock;
  let assertAddOnUsable: jest.Mock;

  beforeEach(async () => {
    describeAddOn = jest.fn().mockResolvedValue({ usable: true, entitled: true });
    assertAddOnUsable = jest.fn().mockResolvedValue(undefined);

    tx = {
      liveSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: SESSION_ID,
          academyId: ACADEMY_ID,
          courseId: COURSE_ID,
          status: 'scheduled',
          hostUserId: HOST_ID,
          scheduledStartAt: START,
          scheduledEndAt: END,
          providerMeetingId: 'zoom-123',
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ academyId: ACADEMY_ID }),
      },
      enrollment: { findFirst: jest.fn().mockResolvedValue({ id: 'enrollment-1' }) },
      academyLiveProviderConnection: {
        findUnique: jest.fn().mockResolvedValue({ status: 'connected' }),
      },
      liveSessionParticipant: {
        upsert: jest.fn().mockResolvedValue({ participantKey: 'atlas_abc' }),
      },
      liveSessionJoinGrant: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ liveSessionId: SESSION_ID, role: 'attendee' }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSessionAccessService,
        {
          provide: AddOnAccessService,
          useValue: { describe: describeAddOn, assertUsable: assertAddOnUsable },
        },
      ],
    }).compile();

    service = moduleRef.get(LiveSessionAccessService);
  });

  const eligibility = (userId = STUDENT_ID, now = DURING) =>
    service.describeJoinEligibility(tx as never, {
      liveSessionId: SESSION_ID,
      userId,
      organizationId: ORG_ID,
      now,
    });

  it('lets an enrolled student join a scheduled session during its window', async () => {
    const result = await eligibility();
    expect(result.joinable).toBe(true);
    expect(result.isHost).toBe(false);
  });

  it('REFUSES a student who is not enrolled', async () => {
    tx.enrollment.findFirst.mockResolvedValue(null);
    const result = await eligibility();
    expect(result.joinable).toBe(false);
    expect(result.reason).toBe('not_enrolled');
  });

  /*
   * CROSS-ACADEMY. The attacker holds a genuine session id from another
   * academy. Their enrollment exists — but for a different academy — so
   * the query that matches on BOTH course and academy finds nothing.
   */
  it('REFUSES a student from another academy holding a real session id', async () => {
    tx.enrollment.findFirst.mockImplementation(({ where }: never) => {
      const w = where as unknown as { academyId: string };
      // Their enrolment belongs to academy-2; this session is academy-1.
      return Promise.resolve(w.academyId === 'academy-2' ? { id: 'e' } : null);
    });

    const result = await eligibility();

    expect(result.joinable).toBe(false);
    expect(result.reason).toBe('not_enrolled');
    // The academy was taken from the SESSION, never from the caller.
    expect(tx.enrollment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ academyId: ACADEMY_ID }),
      }),
    );
  });

  it('REFUSES an enrollment that is only pending or unavailable', async () => {
    await eligibility();
    const where = tx.enrollment.findFirst.mock.calls[0][0].where;
    // The predicate itself is the assertion: only real relationships count.
    expect(where.status).toEqual({ in: ['enrolled', 'completed'] });
  });

  it('REFUSES a draft session — it is not yet part of the curriculum', async () => {
    tx.liveSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      academyId: ACADEMY_ID,
      courseId: COURSE_ID,
      status: 'draft',
      hostUserId: HOST_ID,
      scheduledStartAt: START,
      scheduledEndAt: END,
      providerMeetingId: null,
    });
    expect((await eligibility()).reason).toBe('not_published');
  });

  it('REFUSES a cancelled session', async () => {
    tx.liveSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      academyId: ACADEMY_ID,
      courseId: COURSE_ID,
      status: 'cancelled',
      hostUserId: HOST_ID,
      scheduledStartAt: START,
      scheduledEndAt: END,
      providerMeetingId: null,
    });
    expect((await eligibility()).reason).toBe('cancelled');
  });

  it('REFUSES before the join window opens, and explains that it is early', async () => {
    const wayBefore = new Date(START.getTime() - 60 * 60 * 1000);
    expect((await eligibility(STUDENT_ID, wayBefore)).reason).toBe('too_early');
  });

  it('REFUSES long after the session ended', async () => {
    const wayAfter = new Date(END.getTime() + 24 * 60 * 60 * 1000);
    expect((await eligibility(STUDENT_ID, wayAfter)).reason).toBe('too_late');
  });

  it('allows a LIVE session even outside the scheduled window — the host started it', async () => {
    tx.liveSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      academyId: ACADEMY_ID,
      courseId: COURSE_ID,
      status: 'live',
      hostUserId: HOST_ID,
      scheduledStartAt: START,
      scheduledEndAt: END,
      providerMeetingId: 'z',
    });
    const late = new Date(END.getTime() + 20 * 60 * 1000);
    expect((await eligibility(STUDENT_ID, late)).joinable).toBe(true);
  });

  it('REFUSES when the academy provider connection is unhealthy', async () => {
    tx.academyLiveProviderConnection.findUnique.mockResolvedValue({ status: 'expired' });
    expect((await eligibility()).reason).toBe('provider_unavailable');
  });

  it('REFUSES when the add-on is disabled, without leaking why internally', async () => {
    describeAddOn.mockResolvedValue({
      usable: false,
      reason: 'disabled',
      entitled: true,
    });
    expect((await eligibility()).reason).toBe('add_on_unavailable');
  });

  it('recognises the host without requiring an enrollment', async () => {
    tx.enrollment.findFirst.mockResolvedValue(null);
    const result = await eligibility(HOST_ID);
    expect(result.isHost).toBe(true);
    expect(result.joinable).toBe(true);
  });

  it('does not reveal whether an unknown session id exists in another tenant', async () => {
    tx.liveSession.findUnique.mockResolvedValue(null);
    await expect(eligibility()).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('authorizeJoin', () => {
    it('mints a grant and one stable participant identity', async () => {
      const auth = await service.authorizeJoin(tx as never, {
        liveSessionId: SESSION_ID,
        userId: STUDENT_ID,
        organizationId: ORG_ID,
        now: DURING,
      });

      expect(auth.token).toEqual(expect.any(String));
      expect(auth.role).toBe('attendee');
      // Identity is upserted on (session, user) so repeated joins reuse it
      // rather than creating a second participant.
      expect(tx.liveSessionParticipant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            liveSessionId_userId: { liveSessionId: SESSION_ID, userId: STUDENT_ID },
          },
        }),
      );
    });

    it('stores only the token HASH, never the token itself', async () => {
      const auth = await service.authorizeJoin(tx as never, {
        liveSessionId: SESSION_ID,
        userId: STUDENT_ID,
        organizationId: ORG_ID,
        now: DURING,
      });
      const stored = tx.liveSessionJoinGrant.create.mock.calls[0][0].data;
      expect(stored.tokenHash).toEqual(expect.any(String));
      expect(stored.tokenHash).not.toBe(auth.token);
      expect(JSON.stringify(stored)).not.toContain(auth.token);
    });

    it('enforces the add-on gate before minting anything', async () => {
      assertAddOnUsable.mockRejectedValue(new ForbiddenException());
      await expect(
        service.authorizeJoin(tx as never, {
          liveSessionId: SESSION_ID,
          userId: STUDENT_ID,
          organizationId: ORG_ID,
          now: DURING,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.liveSessionJoinGrant.create).not.toHaveBeenCalled();
    });

    it('refuses to mint a grant for an ineligible student', async () => {
      tx.enrollment.findFirst.mockResolvedValue(null);
      await expect(
        service.authorizeJoin(tx as never, {
          liveSessionId: SESSION_ID,
          userId: STUDENT_ID,
          organizationId: ORG_ID,
          now: DURING,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.liveSessionJoinGrant.create).not.toHaveBeenCalled();
    });
  });

  describe('redeemGrant', () => {
    it('redeems a valid grant exactly once', async () => {
      const result = await service.redeemGrant(tx as never, {
        token: 'tok',
        userId: STUDENT_ID,
        now: DURING,
      });
      expect(result.liveSessionId).toBe(SESSION_ID);

      // The conditional UPDATE is the single-use mechanism: unredeemed,
      // unexpired, and belonging to this user.
      const where = tx.liveSessionJoinGrant.updateMany.mock.calls[0][0].where;
      expect(where.redeemedAt).toBeNull();
      expect(where.userId).toBe(STUDENT_ID);
      expect(where.expiresAt).toEqual({ gt: DURING });
    });

    it('REFUSES a replayed grant — the second redemption matches no row', async () => {
      tx.liveSessionJoinGrant.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.redeemGrant(tx as never, {
          token: 'tok',
          userId: STUDENT_ID,
          now: DURING,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REFUSES a grant forwarded to a different user', async () => {
      // The token is real, but `userId` is part of the match, so another
      // person redeeming it changes nothing.
      tx.liveSessionJoinGrant.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.redeemGrant(tx as never, {
          token: 'tok',
          userId: 'someone-else',
          now: DURING,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
