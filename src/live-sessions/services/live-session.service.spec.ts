/**
 * LiveSessionService — scheduling validation and tenant-safe references.
 *
 * The reference checks are the security-relevant half. A request carrying
 * a real course id, a real section id and a real user id can still be an
 * attack when those three belong to different tenants; individually valid
 * ids with an invalid RELATIONSHIP are exactly what these tests refuse.
 */
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LiveSessionService } from './live-session.service';
import { AddOnAccessService } from './add-on-access.service';

/**
 * What the mocked repository hands back. Declared explicitly rather than
 * reached for with `any`, so a field rename breaks these tests — which is
 * the entire point of asserting on them.
 */
interface CreatedSession {
  status: string;
  sectionId: string | null;
  order: number;
  recordingEnabled: boolean;
  hostUserId: string;
  cancelledAt?: Date | null;
}

const ACADEMY = 'academy-1';
const COURSE = 'course-1';
const ORG = 'org-1';
const ACTOR = 'instructor-1';

const START = new Date('2026-06-01T10:00:00.000Z');
const END = new Date('2026-06-01T11:00:00.000Z');

describe('LiveSessionService', () => {
  let service: LiveSessionService;
  /** A minimal structural stand-in for the Prisma transaction client. */
  let tx: Record<string, Record<string, jest.Mock>>;
  let assertUsable: jest.Mock;

  beforeEach(async () => {
    assertUsable = jest.fn().mockResolvedValue(undefined);

    tx = {
      course: { findFirst: jest.fn().mockResolvedValue({ id: COURSE }) },
      courseSection: { findFirst: jest.fn().mockResolvedValue({ id: 'section-1' }) },
      academyMember: { findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }) },
      liveSession: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'ls-1', ...data }),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'ls-1', ...data }),
          ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSessionService,
        { provide: AddOnAccessService, useValue: { assertUsable } },
      ],
    }).compile();

    service = moduleRef.get(LiveSessionService);
  });

  const create = (over: Partial<Parameters<LiveSessionService['create']>[1]> = {}) =>
    service.create(
      tx as never,
      {
        academyId: ACADEMY,
        courseId: COURSE,
        organizationId: ORG,
        actorUserId: ACTOR,
        title: 'Algebra live',
        scheduledStartAt: START,
        scheduledEndAt: END,
        ...over,
      } as never,
    );

  it('creates a session as a draft, appended to the unit', async () => {
    const created: CreatedSession = await create({ sectionId: 'section-1' });
    expect(created.status).toBe('draft');
    expect(created.sectionId).toBe('section-1');
    expect(created.order).toBe(0);
  });

  /* RECORDING IS OFF BY DEFAULT — the single most important default here. */
  it('defaults recording to OFF when not requested', async () => {
    const created: CreatedSession = await create();
    expect(created.recordingEnabled).toBe(false);
  });

  it('treats an omitted recording flag as OFF, never as inherited', async () => {
    const created: CreatedSession = await create({ recordingEnabled: undefined });
    expect(created.recordingEnabled).toBe(false);
  });

  it('enables recording only on an explicit true', async () => {
    const created: CreatedSession = await create({ recordingEnabled: true });
    expect(created.recordingEnabled).toBe(true);
  });

  it('refuses before doing anything when the add-on is not usable', async () => {
    assertUsable.mockRejectedValue(new ForbiddenException());
    await expect(create()).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.liveSession.create).not.toHaveBeenCalled();
  });

  /* CROSS-TENANT: the course id is real, but not in this academy. */
  it('REFUSES a course from another academy, indistinguishably from a missing one', async () => {
    tx.course.findFirst.mockResolvedValue(null);
    await expect(create()).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.course.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: COURSE, academyId: ACADEMY } }),
    );
  });

  /* CROSS-COURSE: a real section belonging to a different course. */
  it('REFUSES a section that belongs to a different course', async () => {
    tx.courseSection.findFirst.mockResolvedValue(null);
    await expect(create({ sectionId: 'other-course-section' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.liveSession.create).not.toHaveBeenCalled();
  });

  it('REFUSES a host who is not an active member of this academy', async () => {
    tx.academyMember.findFirst.mockResolvedValue(null);
    await expect(create({ hostUserId: 'outsider' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires the host membership to be active, not merely present', async () => {
    await create({ hostUserId: 'someone' });
    expect(tx.academyMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'active' }),
      }),
    );
  });

  it('defaults the host to the acting instructor', async () => {
    const created: CreatedSession = await create();
    expect(created.hostUserId).toBe(ACTOR);
  });

  describe('schedule validation', () => {
    it('REFUSES an end before the start', async () => {
      await expect(
        create({ scheduledStartAt: END, scheduledEndAt: START }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REFUSES a zero-length session', async () => {
      await expect(
        create({ scheduledStartAt: START, scheduledEndAt: START }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REFUSES an absurdly long session', async () => {
      const tooLong = new Date(START.getTime() + 48 * 60 * 60 * 1000);
      await expect(create({ scheduledEndAt: tooLong })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('REFUSES a session shorter than the minimum', async () => {
      const tooShort = new Date(START.getTime() + 60 * 1000);
      await expect(create({ scheduledEndAt: tooShort })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('REFUSES an unparseable date', async () => {
      await expect(
        create({ scheduledEndAt: new Date('not-a-date') }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    const existing = {
      id: 'ls-1',
      courseId: COURSE,
      academyId: ACADEMY,
      status: 'scheduled',
      scheduledStartAt: START,
      scheduledEndAt: END,
    };

    beforeEach(() => {
      tx.liveSession.findFirst.mockResolvedValue(existing);
    });

    it('REFUSES editing a session that has already ended', async () => {
      // Its schedule is the basis every attendance percentage was
      // computed against; rewriting it would silently rewrite history.
      tx.liveSession.findFirst.mockResolvedValue({ ...existing, status: 'ended' });
      await expect(
        service.update(tx as never, {
          academyId: ACADEMY,
          organizationId: ORG,
          liveSessionId: 'ls-1',
          patch: { title: 'new' },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('validates a rescheduled window against the resulting pair', async () => {
      await expect(
        service.update(tx as never, {
          academyId: ACADEMY,
          organizationId: ORG,
          liveSessionId: 'ls-1',
          // New start is AFTER the existing end.
          patch: { scheduledStartAt: new Date(END.getTime() + 3600_000) },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stamps cancelledAt when cancelling', async () => {
      const updated: CreatedSession = await service.update(tx as never, {
        academyId: ACADEMY,
        organizationId: ORG,
        liveSessionId: 'ls-1',
        patch: { status: 'cancelled' },
      });
      expect(updated.status).toBe('cancelled');
      expect(updated.cancelledAt).toBeInstanceOf(Date);
    });

    it('allows turning recording off', async () => {
      const updated: CreatedSession = await service.update(tx as never, {
        academyId: ACADEMY,
        organizationId: ORG,
        liveSessionId: 'ls-1',
        patch: { recordingEnabled: false },
      });
      expect(updated.recordingEnabled).toBe(false);
    });
  });
});
