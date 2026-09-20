/**
 * The staff-facing `LessonContent` response.
 *
 * `bodyHtml` IS DELIBERATELY ABSENT. The learner grant path is the only
 * thing that renders a lesson body, and it does so through
 * `LessonContentService` after all seven entitlement conditions pass. An
 * authoring response that echoed the stored HTML back would be a second,
 * unguarded way to read content — smaller than the grant path, easier to
 * overlook, and reachable by anyone who can reach this endpoint. The
 * authoring screen needs to know a row exists and what it points at; it
 * does not need the body it just sent.
 */
import type { LessonContent as PrismaLessonContent } from '@prisma/client';

export interface LessonContentResponse {
  readonly id: string;
  readonly lessonId: string;
  readonly courseId: string;
  readonly academyId: string;
  readonly kind: PrismaLessonContent['kind'];
  readonly mediaAssetId?: string;
  readonly externalUrl?: string;
  readonly updatedAt: Date;
}

export function toLessonContentResponse(
  content: PrismaLessonContent,
): LessonContentResponse {
  return {
    id: content.id,
    lessonId: content.lessonId,
    courseId: content.courseId,
    academyId: content.academyId,
    kind: content.kind,
    mediaAssetId: content.mediaAssetId ?? undefined,
    externalUrl: content.externalUrl ?? undefined,
    updatedAt: content.updatedAt,
  };
}
