import { BadRequestException, ConflictException } from '@nestjs/common';
import { AnnouncementsService, assertScheduleNotInPast } from './announcements.service';

/**
 * A schedule edit decides the new status from the status it read. The write
 * must not land if the sweep published the row in between.
 */
describe('AnnouncementsService — schedule edits race the publish sweep', () => {
  const academyId = 'academy-1';
  const announcementId = 'ann-1';
  const userId = 'user-1';
  const existing = { id: announcementId, academyId, courseId: null, status: 'scheduled' };
  const tx = {
    academyMember: { findFirst: jest.fn().mockResolvedValue({ role: 'owner' }) },
  };

  function build(updateIfStatus: jest.Mock) {
    const repo = {
      findById: jest.fn().mockResolvedValue(existing),
      update: jest.fn(),
      updateIfStatus,
    };
    const tenancy = {
      runInUserContext: (_: string, fn: (t: unknown) => unknown) => fn(tx),
    };
    const service = new AnnouncementsService(
      tenancy as never,
      repo as never,
      {} as never,
    );
    return { service, repo };
  }

  it('writes only while the row is still in the status it was read in', async () => {
    const updated = {
      ...existing,
      title: 'T',
      body: 'B',
      author: { name: 'Owner' },
      createdAt: new Date(),
      updatedAt: new Date(),
      scheduledAt: new Date(),
    };
    const updateIfStatus = jest.fn().mockResolvedValue(updated);
    const { service, repo } = build(updateIfStatus);
    await service.updateAcademyAnnouncement(userId, academyId, announcementId, {
      title: 'T',
      body: 'B',
      scheduledAt: null,
    } as never);
    expect(updateIfStatus).toHaveBeenCalledWith(tx, announcementId, 'scheduled', {
      title: 'T',
      body: 'B',
      scheduledAt: null,
      status: 'draft',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('answers 409 when the sweep published it first, instead of un-publishing it', async () => {
    const { service } = build(jest.fn().mockResolvedValue(null));
    await expect(
      service.updateAcademyAnnouncement(userId, academyId, announcementId, {
        title: 'T',
        body: 'B',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

/** B4 (UX audit) — a past date would go out at once, skipping the publish confirmation. */
describe('assertScheduleNotInPast', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');

  it('refuses a date in the past, on the scheduledAt field', () => {
    let caught: unknown;
    try {
      assertScheduleNotInPast('2026-11-03T12:00:00Z', now);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toEqual({
      messageKey: 'errors.announcement.scheduleInPast',
      violations: [{ field: 'scheduledAt', messageKey: 'validation:scheduleInPast' }],
    });
  });

  it('accepts no date, a future date, and "now" picked a few seconds ago', () => {
    expect(() => assertScheduleNotInPast(undefined, now)).not.toThrow();
    expect(() => assertScheduleNotInPast(null, now)).not.toThrow();
    expect(() => assertScheduleNotInPast('2026-11-07T12:00:00Z', now)).not.toThrow();
    expect(() => assertScheduleNotInPast('2026-11-06T11:59:30Z', now)).not.toThrow();
  });
});

describe('AnnouncementsService — schedule in the past', () => {
  const academyId = 'academy-1';
  const tx = {
    academyMember: { findFirst: jest.fn().mockResolvedValue({ role: 'owner' }) },
  };
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();

  function build(existing: Record<string, unknown>) {
    const repo = {
      findById: jest.fn().mockResolvedValue(existing),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({
        ...existing,
        title: 'T',
        body: 'B',
        author: { name: 'O' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      updateIfStatus: jest.fn(),
    };
    const tenancy = {
      runInUserContext: (_: string, fn: (t: unknown) => unknown) => fn(tx),
    };
    const service = new AnnouncementsService(
      tenancy as never,
      repo as never,
      {} as never,
    );
    return { service, repo };
  }

  it('refuses a new past date on a draft and writes nothing', async () => {
    const { service, repo } = build({
      id: 'a',
      academyId,
      courseId: null,
      status: 'draft',
      scheduledAt: null,
    });
    await expect(
      service.updateAcademyAnnouncement('u', academyId, 'a', {
        scheduledAt: past,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.updateIfStatus).not.toHaveBeenCalled();
  });

  it('lets a published announcement keep its stored past date', async () => {
    const stored = new Date(past);
    const { service, repo } = build({
      id: 'a',
      academyId,
      courseId: null,
      status: 'published',
      scheduledAt: stored,
    });
    await service.updateAcademyAnnouncement('u', academyId, 'a', {
      title: 'New title',
      scheduledAt: past,
    } as never);
    expect(repo.update).toHaveBeenCalled();
  });
});
