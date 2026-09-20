/** LessonContentsRepository. */
import { Injectable } from '@nestjs/common';
import type { LessonContent, Prisma } from '@prisma/client';

@Injectable()
export class LessonContentsRepository {
  findByLessonId(
    tx: Prisma.TransactionClient,
    lessonId: string,
  ): Promise<LessonContent | null> {
    return tx.lessonContent.findUnique({ where: { lessonId } });
  }

  /**
   * Creates the lesson's content row, or replaces the one it already has.
   *
   * `upsert` on the UNIQUE `lessonId` is what keeps "one content row per
   * lesson" a database fact rather than an application convention: two
   * concurrent authors cannot race a second row into existence, because
   * the unique index refuses it whichever order they arrive in. A
   * read-then-create would leave exactly that window open.
   *
   * `create` and `update` are given the same fields deliberately. The
   * caller has already resolved which columns belong to the chosen kind
   * and nulled the rest, so an update switching a lesson from `video` to
   * `external` clears the stale `media_asset_id` instead of leaving a
   * dangling reference the grant path would still try to sign.
   */
  upsertForLesson(
    tx: Prisma.TransactionClient,
    lessonId: string,
    data: {
      readonly courseId: string;
      readonly academyId: string;
      readonly kind: LessonContent['kind'];
      readonly mediaAssetId: string | null;
      readonly externalUrl: string | null;
    },
  ): Promise<LessonContent> {
    return tx.lessonContent.upsert({
      where: { lessonId },
      create: {
        lessonId,
        courseId: data.courseId,
        academyId: data.academyId,
        kind: data.kind,
        mediaAssetId: data.mediaAssetId,
        externalUrl: data.externalUrl,
      },
      update: {
        kind: data.kind,
        mediaAssetId: data.mediaAssetId,
        externalUrl: data.externalUrl,
      },
    });
  }
}
