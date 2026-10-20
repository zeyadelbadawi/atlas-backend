import { AnnouncementsRepository } from './announcements.repository';

describe('AnnouncementsRepository.publishDueScheduled', () => {
  it('publishes a row only if it is still due when written (an editor may have moved it later)', async () => {
    const asOf = new Date('2026-10-20T12:00:00Z');
    const tx = {
      announcement: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'a1', academyId: 'ac', courseId: null, authorId: 'u' },
          ]),
        // The row was rescheduled after the read: the conditional write matches nothing.
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const published = await new AnnouncementsRepository().publishDueScheduled(
      tx as never,
      asOf,
    );
    expect(tx.announcement.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', status: 'scheduled', scheduledAt: { lte: asOf } },
      data: { status: 'published', publishedAt: asOf },
    });
    expect(published).toEqual([]);
  });
});
