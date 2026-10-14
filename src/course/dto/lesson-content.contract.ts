/**
 * The staff-facing `LessonContent` response.
 *
 * `bodyHtml` is ABSENT by default. The learner grant path renders lesson
 * bodies after all seven entitlement conditions pass, and the write
 * endpoint's response has no reason to echo HTML back.
 *
 * B0-LRN-01 — the ONE exception is the staff read
 * (`CourseCurriculumService.getLessonContent`), which passes
 * `includeBody`: editing an existing text lesson needs its body, and that
 * read climbs the same manage-permission ladder as the write, so it never
 * reveals a body to anyone who could not already replace it.
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
  /** Sanitised HTML; present only on the staff read of a `text` row. */
  readonly bodyHtml?: string;
  readonly updatedAt: Date;
}

export function toLessonContentResponse(
  content: PrismaLessonContent,
  options: { readonly includeBody?: boolean } = {},
): LessonContentResponse {
  return {
    id: content.id,
    lessonId: content.lessonId,
    courseId: content.courseId,
    academyId: content.academyId,
    kind: content.kind,
    mediaAssetId: content.mediaAssetId ?? undefined,
    externalUrl: content.externalUrl ?? undefined,
    ...(options.includeBody && content.kind === 'text' && content.bodyHtml !== null
      ? { bodyHtml: content.bodyHtml }
      : {}),
    updatedAt: content.updatedAt,
  };
}
