import { ConflictException } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';

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
