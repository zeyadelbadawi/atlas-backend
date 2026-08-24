/** `CourseSection` response contract — matches `course.types.ts` field-for-field. `lessons` are always embedded, never paginated separately (the frontend type embeds them directly). */
import type {
  CourseLesson as PrismaCourseLesson,
  CourseSection as PrismaCourseSection,
} from '@prisma/client';
import { toCourseLessonResponse } from './course-lesson.contract';
import type { CourseLessonResponse } from './course-lesson.contract';

export interface CourseSectionResponse {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly description?: string;
  readonly order: number;
  readonly lessons: readonly CourseLessonResponse[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCourseSectionResponse(
  section: PrismaCourseSection & { lessons: PrismaCourseLesson[] },
): CourseSectionResponse {
  return {
    id: section.id,
    courseId: section.courseId,
    title: section.title,
    description: section.description ?? undefined,
    order: section.order,
    lessons: section.lessons.map(toCourseLessonResponse),
    createdAt: section.createdAt.toISOString(),
    updatedAt: section.updatedAt.toISOString(),
  };
}
