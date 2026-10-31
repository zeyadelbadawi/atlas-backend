/**
 * A learner's notes and saved lessons, synced between their phones (Atlas
 * mobile app). Own rows only (`learner_notes`, FORCE RLS), in the academy
 * the session serves.
 *
 * LAST WRITE WINS by the phone's edit time, capped at the server's clock so
 * a phone set in the future cannot freeze a note. An empty, unsaved note is
 * kept as the deletion and listed, so every phone drops it.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { LearnerNote, Prisma } from '@prisma/client';
import { TenancyContextService } from '../tenancy/services/tenancy-context.service';
import type {
  LearnerNoteResponse,
  PutLearnerNoteDto,
  PutLearnerNoteResponse,
} from './dto/learner-sync.dto';

/** Enough for any learner; the list is one request. */
const LIST_LIMIT = 2000;

@Injectable()
export class LearnerNotesService {
  constructor(private readonly tenancy: TenancyContextService) {}

  async list(userId: string, academyId: string): Promise<readonly LearnerNoteResponse[]> {
    return this.tenancy.runInUserContext(userId, async (tx) => {
      const rows = await tx.learnerNote.findMany({
        where: { userId, academyId },
        orderBy: { editedAt: 'desc' },
        take: LIST_LIMIT,
        include: { lesson: { select: { title: true } } },
      });
      const titles = await courseTitles(tx, rows);
      return rows.map((r) => toResponse(r, titles.get(r.courseId) ?? '', r.lesson.title));
    });
  }

  async put(
    userId: string,
    academyId: string,
    lessonId: string,
    dto: PutLearnerNoteDto,
    now: Date = new Date(),
  ): Promise<PutLearnerNoteResponse> {
    const edited = new Date(Math.min(Date.parse(dto.editedAt), now.getTime()));
    return this.tenancy.runInUserContext(userId, async (tx) => {
      // Only on a lesson of a course the learner is enrolled in, here.
      const enrollment = await tx.enrollment.findFirst({
        where: { studentId: userId, courseId: dto.courseId, academyId },
        select: { id: true },
      });
      const lesson = enrollment
        ? await tx.courseLesson.findFirst({
            where: { id: lessonId, courseId: dto.courseId },
            select: { title: true },
          })
        : null;
      const course = lesson
        ? await tx.course.findFirst({
            where: { id: dto.courseId, academyId },
            select: { title: true },
          })
        : null;
      if (!lesson || !course)
        throw new NotFoundException({ messageKey: 'errors.notFound' });

      const current = await tx.learnerNote.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
      });
      if (current && current.editedAt.getTime() >= edited.getTime()) {
        return { ...toResponse(current, course.title, lesson.title), applied: false };
      }
      const values = { note: dto.note, saved: dto.saved, editedAt: edited };
      const row = await tx.learnerNote.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        create: { userId, academyId, courseId: dto.courseId, lessonId, ...values },
        update: values,
      });
      return { ...toResponse(row, course.title, lesson.title), applied: true };
    });
  }
}

async function courseTitles(
  tx: Prisma.TransactionClient,
  rows: readonly LearnerNote[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.courseId))];
  if (ids.length === 0) return new Map();
  const courses = await tx.course.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true },
  });
  return new Map(courses.map((c) => [c.id, c.title]));
}

function toResponse(
  row: LearnerNote,
  courseTitle: string,
  lessonTitle: string,
): LearnerNoteResponse {
  return {
    courseId: row.courseId,
    lessonId: row.lessonId,
    courseTitle,
    lessonTitle,
    note: row.note,
    saved: row.saved,
    editedAt: row.editedAt.toISOString(),
  };
}
