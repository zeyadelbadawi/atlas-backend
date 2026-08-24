/** `CourseLesson` response contract — matches `course.types.ts` field-for-field. */
import type { CourseLesson as PrismaCourseLesson } from '@prisma/client';

export interface CourseLessonResponse {
  readonly id: string;
  readonly courseId: string;
  readonly sectionId: string;
  readonly title: string;
  readonly description?: string;
  readonly order: number;
  readonly contentType: PrismaCourseLesson['contentType'];
  readonly contentUrl?: string;
  readonly status: PrismaCourseLesson['status'];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCourseLessonResponse(lesson: PrismaCourseLesson): CourseLessonResponse {
  return {
    id: lesson.id,
    courseId: lesson.courseId,
    sectionId: lesson.sectionId,
    title: lesson.title,
    description: lesson.description ?? undefined,
    order: lesson.order,
    contentType: lesson.contentType,
    contentUrl: lesson.contentUrl ?? undefined,
    status: lesson.status,
    createdAt: lesson.createdAt.toISOString(),
    updatedAt: lesson.updatedAt.toISOString(),
  };
}
