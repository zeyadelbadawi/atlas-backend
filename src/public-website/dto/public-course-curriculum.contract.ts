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
 *
 * `isPreview` IS public, and deliberately so. The schema's own
 * architecture note on `LessonContent` states the split: the lesson row
 * "stays publicly listable (title, order, duration, preview flag)" while
 * its CONTENT has no public RLS policy and is reachable only through
 * `LessonContentService.getContent()`, which re-decides entitlement when
 * the bytes are asked for. The flag was simply never projected here, so a
 * visitor could not see which lesson is the free sample even though
 * `getContent` already serves it to them anonymously (its `isOpenPreview`
 * short-circuit, behind `OptionalJwtAuthGuard`). Publishing the flag tells
 * the visitor what the server was already willing to give them; it grants
 * nothing new, and the content gate is untouched.
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
  /** The free sample. `LessonContentService` serves this lesson's content to anonymous visitors. */
  readonly isPreview: boolean;
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
        isPreview: lesson.isPreview,
      })),
  }));
}
