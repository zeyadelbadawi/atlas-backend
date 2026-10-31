import { NotFoundException } from '@nestjs/common';
import { LearnerNotesService } from './learner-notes.service';
import { validTimeZone } from './study-days.service';

const NOW = new Date('2026-10-31T12:00:00.000Z');

function make(
  current: { editedAt: Date; note: string; saved: boolean } | null,
  enrolled = true,
) {
  const upserts: unknown[] = [];
  const tx = {
    enrollment: {
      findFirst: jest.fn().mockResolvedValue(enrolled ? { id: 'e1' } : null),
    },
    courseLesson: { findFirst: jest.fn().mockResolvedValue({ title: 'Lesson' }) },
    course: { findFirst: jest.fn().mockResolvedValue({ title: 'Course' }) },
    learnerNote: {
      findUnique: jest
        .fn()
        .mockResolvedValue(current && { courseId: 'c1', lessonId: 'l1', ...current }),
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => {
        upserts.push(args);
        return { courseId: 'c1', lessonId: 'l1', ...args.create };
      }),
    },
  };
  const tenancy = {
    runInUserContext: (_u: string, fn: (t: typeof tx) => unknown) => fn(tx),
  };
  return { service: new LearnerNotesService(tenancy as never), upserts };
}

const dto = (editedAt: string, note = 'new') => ({
  courseId: 'c1',
  note,
  saved: true,
  editedAt,
});

describe('LearnerNotesService.put', () => {
  it('keeps the newer edit (last write wins)', async () => {
    const { service, upserts } = make({
      editedAt: new Date('2026-10-31T11:00:00Z'),
      note: 'server',
      saved: false,
    });
    const older = await service.put('u1', 'a1', 'l1', dto('2026-10-31T10:00:00Z'), NOW);
    expect(older).toMatchObject({ applied: false, note: 'server' });
    expect(upserts).toHaveLength(0);

    const newer = await service.put('u1', 'a1', 'l1', dto('2026-10-31T11:30:00Z'), NOW);
    expect(newer).toMatchObject({ applied: true, note: 'new', courseTitle: 'Course' });
  });

  it('caps a phone clock that runs ahead at the server time', async () => {
    const { service } = make(null);
    const res = await service.put('u1', 'a1', 'l1', dto('2030-01-01T00:00:00Z'), NOW);
    expect(res.editedAt).toBe(NOW.toISOString());
  });

  it('refuses a lesson outside the learner’s enrolled course', async () => {
    const { service } = make(null, false);
    await expect(
      service.put('u1', 'a1', 'l1', dto('2026-10-31T11:00:00Z'), NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('validTimeZone', () => {
  it('accepts IANA names, defaults to UTC, refuses the rest', () => {
    expect(validTimeZone('Africa/Cairo')).toBe('Africa/Cairo');
    expect(validTimeZone(undefined)).toBe('UTC');
    expect(() => validTimeZone('Not/AZone')).toThrow();
  });
});
