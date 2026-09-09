/**
 * Public Course Curriculum contract.
 *
 * A deliberately slim projection of `CourseSectionResponse`/
 * `CourseLessonResponse` (`@course/dto`) for the ONE genuinely
 * unauthenticated consumer of curriculum data: the public marketing
 * Course Details page, previewing "what's inside" to a visitor who has
 * not enrolled yet (matches the reference product's own "curriculum
 * preview" pattern — lesson titles and structure are marketing content,
 * the lesson's actual `contentUrl`/`description` is not). Strips
 * `contentUrl` and `description` for exactly that reason: those are
 * gated, enrollment-only content (`assertCourseReadAccess`,
 * `CourseContentService`) and must never leak through a route with no
 * auth guard at all (`PublicWebsiteController`'s own doc comment).
 * Published lessons only, same rule `CourseContentService` already
 * applies for enrolled students.
 */
import type {
  CourseLesson as PrismaCourseLesson,
  CourseSection as PrismaCourseSection,
} from '@prisma/client';

export interface PublicCourseCurriculumLessonResponse {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly contentType: PrismaCourseLesson['contentType'];
}

export interface PublicCourseCurriculumSectionResponse {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly lessons: readonly PublicCourseCurriculumLessonResponse[];
}

export function toPublicCourseCurriculumResponse(
  sections: readonly (PrismaCourseSection & { lessons: PrismaCourseLesson[] })[],
): PublicCourseCurriculumSectionResponse[] {
  return sections.map((section) => ({
    id: section.id,
    title: section.title,
    order: section.order,
    lessons: section.lessons
      .filter((lesson) => lesson.status === 'published')
      .map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        order: lesson.order,
        contentType: lesson.contentType,
      })),
  }));
}
