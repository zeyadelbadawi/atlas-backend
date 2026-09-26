/**
 * Where a media asset is still in use (cloud remediation — media delete).
 *
 * Deleting media in Atlas is archive-then-purge: `POST …/media/:id/archive`
 * archives it, and `ArchivedMediaPurgeService` destroys the bytes after the
 * 30-day grace. Neither step may silently break something that still points
 * at the asset, so the archive refuses while any usage exists and names
 * each kind, so the UI can say exactly what must be changed first.
 *
 * Two reference shapes exist and both are checked:
 *   - foreign keys: lesson video, lesson content, lesson resource, course
 *     intro video, assignment-submission attachment (a learner's record),
 *     live-session recording file;
 *   - stored URLs: academy logo, course thumbnail, certificate template
 *     logo, and anywhere in website configuration, website pages and blog
 *     posts (JSON content), matched on the asset's own URL.
 *
 * Must run in the owning organization's TENANT context, where each of these
 * tables is fully visible for the academy.
 */
import { Prisma } from '@prisma/client';

export type MediaUsageKind =
  | 'lessonVideo'
  | 'lessonContent'
  | 'lessonResource'
  | 'courseIntroVideo'
  | 'submissionAttachment'
  | 'liveSessionRecording'
  | 'academyLogo'
  | 'courseThumbnail'
  | 'certificateTemplateLogo'
  | 'websiteContent';

export interface MediaUsage {
  readonly kind: MediaUsageKind;
  readonly count: number;
}

export async function findMediaUsages(
  tx: Prisma.TransactionClient,
  asset: { readonly id: string; readonly academyId: string; readonly url: string },
): Promise<MediaUsage[]> {
  const id = asset.id;
  const [
    lessonVideo,
    lessonContent,
    lessonResource,
    courseIntroVideo,
    submissionAttachment,
    liveSessionRecording,
  ] = await Promise.all([
    tx.courseLesson.count({ where: { videoAssetId: id } }),
    tx.lessonContent.count({ where: { mediaAssetId: id } }),
    tx.lessonResource.count({ where: { mediaAssetId: id } }),
    tx.course.count({ where: { introVideoAssetId: id } }),
    tx.assignmentSubmission.count({ where: { attachmentAssetId: id } }),
    tx.liveSessionRecordingFile.count({ where: { mediaAssetId: id } }),
  ]);

  let academyLogo = 0;
  let courseThumbnail = 0;
  let certificateTemplateLogo = 0;
  let websiteContent = 0;
  const url = asset.url.trim();
  if (url) {
    [academyLogo, courseThumbnail, certificateTemplateLogo] = await Promise.all([
      tx.academy.count({ where: { id: asset.academyId, logoUrl: url } }),
      tx.course.count({ where: { academyId: asset.academyId, thumbnailUrl: url } }),
      tx.certificateTemplate.count({
        where: { academyId: asset.academyId, logoUrl: url },
      }),
    ]);
    const rows = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT (
        (SELECT count(*) FROM website_configurations c
           WHERE c.academy_id = ${asset.academyId} AND strpos(row_to_json(c)::text, ${url}) > 0)
      + (SELECT count(*) FROM website_pages p
           WHERE p.academy_id = ${asset.academyId} AND strpos(row_to_json(p)::text, ${url}) > 0)
      + (SELECT count(*) FROM blog_posts b
           WHERE b.academy_id = ${asset.academyId} AND strpos(row_to_json(b)::text, ${url}) > 0)
      )::int AS n`);
    websiteContent = Number(rows[0]?.n ?? 0);
  }

  const all: MediaUsage[] = [
    { kind: 'lessonVideo', count: lessonVideo },
    { kind: 'lessonContent', count: lessonContent },
    { kind: 'lessonResource', count: lessonResource },
    { kind: 'courseIntroVideo', count: courseIntroVideo },
    { kind: 'submissionAttachment', count: submissionAttachment },
    { kind: 'liveSessionRecording', count: liveSessionRecording },
    { kind: 'academyLogo', count: academyLogo },
    { kind: 'courseThumbnail', count: courseThumbnail },
    { kind: 'certificateTemplateLogo', count: certificateTemplateLogo },
    { kind: 'websiteContent', count: websiteContent },
  ];
  return all.filter((usage) => usage.count > 0);
}
