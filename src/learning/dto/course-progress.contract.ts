/**
 * `CourseProgress` response contract — matches `progress.types.ts`
 * field-for-field. `sections` is computed by grouping the materialized
 * `lesson_progress` rows by their denormalized `section_id` — never a
 * separate query against `course_sections`, since every published lesson
 * already has a `lesson_progress` row (materialized at enrollment time,
 * see `CourseProgressRepository`), so the grouping is always complete.
 */
import type {
  CourseProgress as PrismaCourseProgress,
  LessonProgress as PrismaLessonProgress,
} from '@prisma/client';

export interface LessonProgressResponse {
  readonly lessonId: string;
  readonly sectionId: string;
  readonly courseId: string;
  readonly status: PrismaLessonProgress['status'];
  readonly completedAt?: string;
}

export interface SectionProgressResponse {
  readonly sectionId: string;
  readonly totalLessons: number;
  readonly completedLessons: number;
}

export interface CourseProgressResponse {
  readonly courseId: string;
  readonly totalLessons: number;
  readonly completedLessons: number;
  readonly percentage: number;
  readonly currentLessonId?: string;
  readonly sections: readonly SectionProgressResponse[];
  readonly lessons: readonly LessonProgressResponse[];
  readonly completionState: PrismaCourseProgress['completionState'];
  readonly certificateStatus: PrismaCourseProgress['certificateStatus'];
}

export function toLessonProgressResponse(
  lessonProgress: PrismaLessonProgress,
): LessonProgressResponse {
  return {
    lessonId: lessonProgress.lessonId,
    sectionId: lessonProgress.sectionId,
    courseId: lessonProgress.courseId,
    status: lessonProgress.status,
    completedAt: lessonProgress.completedAt?.toISOString(),
  };
}

function toSectionProgressResponses(
  lessonProgressRows: readonly PrismaLessonProgress[],
): readonly SectionProgressResponse[] {
  const bySection = new Map<string, { total: number; completed: number }>();
  // Preserve first-seen section order (rows are always fetched ordered by
  // section/lesson order — see the repository) rather than sorting by id.
  const order: string[] = [];

  for (const row of lessonProgressRows) {
    if (!bySection.has(row.sectionId)) {
      bySection.set(row.sectionId, { total: 0, completed: 0 });
      order.push(row.sectionId);
    }
    const entry = bySection.get(row.sectionId)!;
    entry.total += 1;
    if (row.status === 'completed') entry.completed += 1;
  }

  return order.map((sectionId) => ({
    sectionId,
    totalLessons: bySection.get(sectionId)!.total,
    completedLessons: bySection.get(sectionId)!.completed,
  }));
}

export function toCourseProgressResponse(
  courseId: string,
  courseProgress: PrismaCourseProgress,
  lessonProgressRows: readonly PrismaLessonProgress[],
): CourseProgressResponse {
  return {
    courseId,
    totalLessons: courseProgress.totalLessons,
    completedLessons: courseProgress.completedLessons,
    percentage: Number(courseProgress.percentage),
    currentLessonId: courseProgress.currentLessonId ?? undefined,
    sections: toSectionProgressResponses(lessonProgressRows),
    lessons: lessonProgressRows.map(toLessonProgressResponse),
    completionState: courseProgress.completionState,
    certificateStatus: courseProgress.certificateStatus,
  };
}
