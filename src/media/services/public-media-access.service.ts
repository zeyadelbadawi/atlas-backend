/**
 * W1 — what `GET public/media/academies/:academyId/:fileName` may serve,
 * and how it may be cached.
 *
 * THE ROUTE USED TO READ NO DATABASE AT ALL: any object under
 * `academies/<uuid>/<uuid>.<ext>` in the public bucket was served to
 * anyone, `public, max-age=31536000, immutable`, so a URL that once
 * pointed at something was a permanent, edge-cached, unrevocable
 * capability. That included learners' assignment submissions (uploaded
 * through the public pipeline before P64 Phase 3) and lesson files picked
 * from the public library.
 *
 * NOW every request is decided from the asset's own row:
 *
 *  - no row for this academy + key, a row that is not `access = public`
 *    on `r2`, or a row whose bytes were purged → nothing (404);
 *  - a submission attachment (referenced by a submission, or uploaded by a
 *    learner) or a lesson file/resource → `signed-only`: served solely
 *    through a short-lived link from the grant paths
 *    (`PublicMediaLinkSigner`), never anonymously — UNLESS the same asset
 *    is also deliberately published (below), which keeps working;
 *  - a BRANDING asset — the academy logo, a course cover, a certificate
 *    template logo, or anything referenced by the website configuration,
 *    pages or blog posts → `branding`: anonymous, and the only kind that
 *    may still be cached `immutable` (its bytes never change, and it is
 *    public by purpose);
 *  - any other library asset (`public` tier by the uploader's own choice,
 *    e.g. an image not yet placed anywhere, an avatar) → `public`:
 *    anonymous, but cached for an hour, not a year, so a later purge or
 *    reclassification actually takes effect.
 *
 * Archived (not purged) assets keep serving on purpose, as before: pages
 * already using an asset are documented to keep working.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { toMediaAssetUrl } from '../dto/media-asset.contract';

export type PublicMediaAccess = 'branding' | 'public' | 'signed-only';

@Injectable()
export class PublicMediaAccessService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
  ) {}

  /** `null` when nothing may be served for this key at all. */
  async resolve(
    academyId: string,
    storageKey: string,
  ): Promise<PublicMediaAccess | null> {
    const organizationId =
      await this.academyStudentsRepository.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const asset = await tx.mediaAsset.findFirst({
        where: { academyId, storageKey },
        select: {
          id: true,
          url: true,
          access: true,
          provider: true,
          deletedAt: true,
          uploadedByUserId: true,
        },
      });
      if (
        !asset ||
        asset.access !== 'public' ||
        asset.provider !== 'r2' ||
        asset.deletedAt
      ) {
        return null;
      }

      const [submissions, lessonContents, lessonResources] = await Promise.all([
        tx.assignmentSubmission.count({ where: { attachmentAssetId: asset.id } }),
        tx.lessonContent.count({ where: { mediaAssetId: asset.id } }),
        tx.lessonResource.count({ where: { mediaAssetId: asset.id } }),
      ]);
      const restricted =
        asset.uploadedByUserId !== null ||
        submissions > 0 ||
        lessonContents > 0 ||
        lessonResources > 0;

      const branding = await this.isPublished(tx, academyId, [
        toMediaAssetUrl(storageKey),
        asset.url,
      ]);
      if (branding) return 'branding';
      return restricted ? 'signed-only' : 'public';
    });
  }

  /**
   * Whether the asset is referenced where the academy publishes it: its
   * logo, a course cover, a certificate template logo, or the website's
   * configuration, pages or blog posts (JSON content, matched on the URL,
   * the same way `findMediaUsages` finds website usages). Both the
   * derived app-relative URL — what the media library hands out and what
   * these fields store — and the row's stored `url` are tried.
   */
  private async isPublished(
    tx: Prisma.TransactionClient,
    academyId: string,
    candidates: readonly string[],
  ): Promise<boolean> {
    const urls = [...new Set(candidates.map((url) => url.trim()).filter(Boolean))];
    if (urls.length === 0) return false;
    const [logo, cover, certificateLogo] = await Promise.all([
      tx.academy.count({ where: { id: academyId, logoUrl: { in: urls } } }),
      tx.course.count({ where: { academyId, thumbnailUrl: { in: urls } } }),
      tx.certificateTemplate.count({ where: { academyId, logoUrl: { in: urls } } }),
    ]);
    if (logo + cover + certificateLogo > 0) return true;
    for (const url of urls) {
      const rows = await tx.$queryRaw<{ found: boolean }[]>(Prisma.sql`
        SELECT (
          EXISTS (SELECT 1 FROM website_configurations c
                   WHERE c.academy_id = ${academyId} AND strpos(row_to_json(c)::text, ${url}) > 0)
          OR EXISTS (SELECT 1 FROM website_pages p
                   WHERE p.academy_id = ${academyId} AND strpos(row_to_json(p)::text, ${url}) > 0)
          OR EXISTS (SELECT 1 FROM blog_posts b
                   WHERE b.academy_id = ${academyId} AND strpos(row_to_json(b)::text, ${url}) > 0)
        ) AS found`);
      if (rows[0]?.found) return true;
    }
    return false;
  }
}
