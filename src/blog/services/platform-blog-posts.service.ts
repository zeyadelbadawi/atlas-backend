/**
 * PlatformBlogPostsService — B3: the marketing blog, written by Platform
 * Owners and read by the public marketing site.
 *
 * CONTEXT. Platform Owner reads and writes run in the caller's user
 * context (`runInUserContext`): `platform_blog_posts` RLS admits writes
 * from Platform Owners only. Public reads run with NO context
 * (`runWithoutContext`), where RLS shows only public posts (scheduled or
 * published, publish time reached); the queries filter the same way, so
 * either line alone keeps drafts out.
 *
 * CONCURRENCY. Every write locks the row (`FOR UPDATE`), compares the
 * `version` the editor read, and bumps it → 409 `errors.blog.stale`
 * (code `BLOG_POST_STALE`) when someone else saved first.
 *
 * PARITY (W2). A post goes public only with both languages complete, and
 * a public post cannot be edited out of that state → 422
 * `errors.blog.translationsIncomplete`.
 *
 * EDGE. After any write that changes what the public sees, the edge tag
 * `atlas-blog` is purged (after commit; never fails the write).
 *
 * AUDIT. Every mutation writes its audit row in the same transaction.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PlatformBlogPost } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { EdgeCachePurgeService } from '../../edge-cache/edge-cache-purge.service';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import { findUnsafeMarkdownUrls } from '../../common/validation/safe-url.util';
import {
  BLOG_DEFAULT_AUTHOR,
  BLOG_LOCALES,
  BLOG_SLUG_PATTERN,
  affectsPublicSite,
  hasTranslation,
  incompleteLocales,
  isPubliclyVisible,
  readingMinutes,
  resolvePublish,
  translationColumns,
  type BlogLocale,
  type BlogTranslationColumns,
} from '../blog-rules';
import {
  PUBLIC_BLOG_DEFAULT_PAGE_SIZE,
  type BlogTranslationDto,
  type BlogTranslationsDto,
  type CreateBlogPostDto,
  type ListBlogPostsQueryDto,
  type PublicBlogListQueryDto,
  type PublishBlogPostDto,
  type UpdateBlogPostDto,
} from '../dto/blog.dto';
import type {
  BlogPostDetail,
  BlogPostListItem,
  BlogTranslation,
  PublicBlogPost,
  PublicBlogPostSummary,
  PublicBlogSitemap,
} from '../dto/blog.contract';

const TARGET_TYPE = 'platform_blog_post';
const ROLE = 'platform_owner';

export const BLOG_AUDIT = {
  created: 'platform.blog_post.created',
  updated: 'platform.blog_post.updated',
  published: 'platform.blog_post.published',
  unpublished: 'platform.blog_post.unpublished',
  archived: 'platform.blog_post.archived',
  deleted: 'platform.blog_post.deleted',
} as const;

export const BLOG_ERRORS = {
  notFound: 'errors.blog.notFound',
  stale: 'errors.blog.stale',
  slugTaken: 'errors.blog.slugTaken',
  translationsIncomplete: 'errors.blog.translationsIncomplete',
  translationMissing: 'errors.blog.translationMissing',
  relatedPostInvalid: 'errors.blog.relatedPostInvalid',
  unsafeMarkdownUrl: 'errors.blog.unsafeMarkdownUrl',
  invalidTransition: 'errors.blog.invalidTransition',
  deleteNotAllowed: 'errors.blog.deleteNotAllowed',
} as const;

export const BLOG_STALE_CODE = 'BLOG_POST_STALE';

type TranslationData = Pick<
  Prisma.PlatformBlogPostUncheckedCreateInput,
  | 'titleEn'
  | 'excerptEn'
  | 'bodyEn'
  | 'coverAltEn'
  | 'seoTitleEn'
  | 'seoDescriptionEn'
  | 'readingMinutesEn'
  | 'titleAr'
  | 'excerptAr'
  | 'bodyAr'
  | 'coverAltAr'
  | 'seoTitleAr'
  | 'seoDescriptionAr'
  | 'readingMinutesAr'
>;

function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().length === 0 ? null : value;
}

/** A language as stored: text trimmed (the body as written), blank → null. */
export function normalizeTranslation(
  input: BlogTranslationDto | null | undefined,
): BlogTranslationColumns {
  const empty: BlogTranslationColumns = {
    title: null,
    excerpt: null,
    body: null,
    coverAlt: null,
    seoTitle: null,
    seoDescription: null,
  };
  if (!input) return empty;
  const columns: BlogTranslationColumns = {
    title: blankToNull(input.title?.trim()),
    excerpt: blankToNull(input.excerpt?.trim()),
    body: blankToNull(input.body),
    coverAlt: blankToNull(input.coverAlt?.trim()),
    seoTitle: blankToNull(input.seoTitle?.trim()),
    seoDescription: blankToNull(input.seoDescription?.trim()),
  };
  // A language with no title, excerpt or body is absent, whatever else it held.
  return hasTranslation(columns) ? columns : empty;
}

function translationData(
  locale: BlogLocale,
  columns: BlogTranslationColumns,
): TranslationData {
  const minutes = readingMinutes(columns.body);
  return locale === 'en'
    ? {
        titleEn: columns.title,
        excerptEn: columns.excerpt,
        bodyEn: columns.body,
        coverAltEn: columns.coverAlt,
        seoTitleEn: columns.seoTitle,
        seoDescriptionEn: columns.seoDescription,
        readingMinutesEn: minutes,
      }
    : {
        titleAr: columns.title,
        excerptAr: columns.excerpt,
        bodyAr: columns.body,
        coverAltAr: columns.coverAlt,
        seoTitleAr: columns.seoTitle,
        seoDescriptionAr: columns.seoDescription,
        readingMinutesAr: minutes,
      };
}

/** Refuses a body whose links or images use a scheme the site never renders. */
export function assertSafeMarkdown(locale: BlogLocale, body: string | null): void {
  if (!body) return;
  const unsafe = findUnsafeMarkdownUrls(body);
  if (unsafe.length > 0) {
    throw new BadRequestException({
      messageKey: BLOG_ERRORS.unsafeMarkdownUrl,
      details: { locale, kind: unsafe[0].kind, url: unsafe[0].url },
    });
  }
}

export function assertComplete(row: Parameters<typeof incompleteLocales>[0]): void {
  const missing = incompleteLocales(row);
  if (missing.length > 0) {
    throw new UnprocessableEntityException({
      messageKey: BLOG_ERRORS.translationsIncomplete,
      details: { locales: missing.join(',') },
    });
  }
}

function staleError(): ConflictException {
  return new ConflictException({ messageKey: BLOG_ERRORS.stale, code: BLOG_STALE_CODE });
}

function translationResponse(columns: BlogTranslationColumns): BlogTranslation | null {
  if (!hasTranslation(columns)) return null;
  return {
    title: columns.title ?? '',
    excerpt: columns.excerpt ?? '',
    body: columns.body ?? '',
    coverAlt: columns.coverAlt ?? '',
    seoTitle: columns.seoTitle,
    seoDescription: columns.seoDescription,
  };
}

function coverImage(row: PlatformBlogPost) {
  return row.coverImageUrl && row.coverImageWidth && row.coverImageHeight
    ? { url: row.coverImageUrl, width: row.coverImageWidth, height: row.coverImageHeight }
    : null;
}

/** Only columns a public reader may get (never ids, counters, authorship or drafts). */
const PUBLIC_SELECT = {
  id: true,
  slug: true,
  kind: true,
  topic: true,
  status: true,
  featured: true,
  publishAt: true,
  updatedAt: true,
  coverImageUrl: true,
  coverImageWidth: true,
  coverImageHeight: true,
  authorName: true,
  relatedPostIds: true,
  titleEn: true,
  excerptEn: true,
  coverAltEn: true,
  readingMinutesEn: true,
  titleAr: true,
  excerptAr: true,
  coverAltAr: true,
  readingMinutesAr: true,
} satisfies Prisma.PlatformBlogPostSelect;

type PublicRow = Prisma.PlatformBlogPostGetPayload<{ select: typeof PUBLIC_SELECT }>;

function publicSummary(row: PublicRow, locale: BlogLocale): PublicBlogPostSummary {
  const en = locale === 'en';
  return {
    slug: row.slug,
    kind: row.kind,
    topic: row.topic,
    featured: row.featured,
    publishAt: row.publishAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    coverImage:
      row.coverImageUrl && row.coverImageWidth && row.coverImageHeight
        ? {
            url: row.coverImageUrl,
            width: row.coverImageWidth,
            height: row.coverImageHeight,
          }
        : null,
    coverAlt: (en ? row.coverAltEn : row.coverAltAr) ?? '',
    title: (en ? row.titleEn : row.titleAr) ?? '',
    excerpt: (en ? row.excerptEn : row.excerptAr) ?? '',
    readingMinutes: (en ? row.readingMinutesEn : row.readingMinutesAr) ?? 1,
    authorName: row.authorName,
  };
}

function publicWhere(now: Date): Prisma.PlatformBlogPostWhereInput {
  return { status: { in: ['scheduled', 'published'] }, publishAt: { lte: now } };
}

function localePresent(locale: BlogLocale): Prisma.PlatformBlogPostWhereInput {
  return locale === 'en' ? { titleEn: { not: null } } : { titleAr: { not: null } };
}

@Injectable()
export class PlatformBlogPostsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly edgeCachePurgeService: EdgeCachePurgeService,
  ) {}

  // ---------------------------------------------------------------------
  // Platform Owner reads
  // ---------------------------------------------------------------------

  async list(
    platformOwnerId: string,
    query: ListBlogPostsQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResult<BlogPostListItem>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const term = query.search?.trim();
    const where: Prisma.PlatformBlogPostWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.topic ? { topic: query.topic } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(term
        ? {
            OR: [
              { slug: { contains: term, mode: 'insensitive' } },
              { titleEn: { contains: term, mode: 'insensitive' } },
              { titleAr: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const sortBy = query.sortBy ?? query.sort ?? 'updatedAt';
    const direction = query.sortDirection ?? (sortBy === 'title' ? 'asc' : 'desc');
    const orderBy: Prisma.PlatformBlogPostOrderByWithRelationInput[] =
      sortBy === 'title'
        ? [
            { titleEn: { sort: direction, nulls: 'last' } },
            { titleAr: { sort: direction, nulls: 'last' } },
          ]
        : sortBy === 'publishAt'
          ? [{ publishAt: { sort: direction, nulls: 'last' } }]
          : [{ updatedAt: direction }];
    orderBy.push({ id: 'asc' });

    const { rows, total, names } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const rows = await tx.platformBlogPost.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
        const total = await tx.platformBlogPost.count({ where });
        const names = await this.userNames(
          tx,
          rows.flatMap((row) => [row.createdByUserId, row.updatedByUserId]),
        );
        return { rows, total, names };
      },
    );
    return {
      items: rows.map((row) => this.toListItem(row, names, now)),
      pagination: buildPaginationMeta(page, pageSize, total),
    };
  }

  async get(
    platformOwnerId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<BlogPostDetail> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.loadDetail(tx, id, now),
    );
  }

  /** The public detail shape for any status (the dashboard preview). */
  async preview(
    platformOwnerId: string,
    id: string,
    locale: BlogLocale,
  ): Promise<PublicBlogPost> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const row = await tx.platformBlogPost.findUnique({ where: { id } });
      if (!row) throw new NotFoundException({ messageKey: BLOG_ERRORS.notFound });
      const columns = translationColumns(row, locale);
      if (!hasTranslation(columns)) {
        throw new NotFoundException({ messageKey: BLOG_ERRORS.translationMissing });
      }
      const related = row.relatedPostIds.length
        ? await tx.platformBlogPost.findMany({
            where: {
              id: { in: row.relatedPostIds },
              status: { not: 'archived' },
              ...localePresent(locale),
            },
            select: PUBLIC_SELECT,
          })
        : [];
      return this.toPublicDetail(row, locale, related);
    });
  }

  // ---------------------------------------------------------------------
  // Platform Owner writes
  // ---------------------------------------------------------------------

  async create(
    platformOwnerId: string,
    payload: CreateBlogPostDto,
    now: Date = new Date(),
  ): Promise<BlogPostDetail> {
    const en = normalizeTranslation(payload.translations?.en);
    const ar = normalizeTranslation(payload.translations?.ar);
    assertSafeMarkdown('en', en.body);
    assertSafeMarkdown('ar', ar.body);

    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      await this.assertSlugFree(tx, payload.slug);
      const relatedPostIds = await this.validRelated(
        tx,
        payload.relatedPostIds ?? [],
        null,
      );
      let created: PlatformBlogPost;
      try {
        created = await tx.platformBlogPost.create({
          data: {
            slug: payload.slug,
            kind: payload.kind,
            topic: payload.topic,
            status: 'draft',
            featured: payload.featured ?? false,
            coverImageUrl: payload.coverImage?.url ?? null,
            coverImageWidth: payload.coverImage?.width ?? null,
            coverImageHeight: payload.coverImage?.height ?? null,
            authorName: payload.authorName || BLOG_DEFAULT_AUTHOR,
            relatedPostIds,
            ...translationData('en', en),
            ...translationData('ar', ar),
            createdByUserId: platformOwnerId,
            updatedByUserId: platformOwnerId,
          },
        });
      } catch (error) {
        throw this.mapSlugConflict(error);
      }
      await this.audit(tx, platformOwnerId, BLOG_AUDIT.created, created, {
        slug: created.slug,
        kind: created.kind,
        topic: created.topic,
      });
      return this.loadDetail(tx, created.id, now);
    });
  }

  async update(
    platformOwnerId: string,
    id: string,
    payload: UpdateBlogPostDto,
    now: Date = new Date(),
  ): Promise<BlogPostDetail> {
    const translations = this.translationPatch(payload.translations);
    const result = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const current = await this.lockOrThrow(tx, id, payload.version);
        const data: Prisma.PlatformBlogPostUncheckedUpdateInput = {};
        const changed: string[] = [];

        if (payload.slug !== undefined && payload.slug !== current.slug) {
          await this.assertSlugFree(tx, payload.slug, id);
          data.slug = payload.slug;
          changed.push('slug');
        }
        if (payload.kind !== undefined && payload.kind !== current.kind) {
          data.kind = payload.kind;
          changed.push('kind');
        }
        if (payload.topic !== undefined && payload.topic !== current.topic) {
          data.topic = payload.topic;
          changed.push('topic');
        }
        if (payload.featured !== undefined && payload.featured !== current.featured) {
          data.featured = payload.featured;
          changed.push('featured');
        }
        if (
          payload.authorName !== undefined &&
          payload.authorName !== current.authorName
        ) {
          data.authorName = payload.authorName;
          changed.push('authorName');
        }
        if (payload.coverImage !== undefined) {
          const next = payload.coverImage;
          if (
            (next?.url ?? null) !== current.coverImageUrl ||
            (next?.width ?? null) !== current.coverImageWidth ||
            (next?.height ?? null) !== current.coverImageHeight
          ) {
            data.coverImageUrl = next?.url ?? null;
            data.coverImageWidth = next?.width ?? null;
            data.coverImageHeight = next?.height ?? null;
            changed.push('coverImage');
          }
        }
        if (payload.relatedPostIds !== undefined) {
          const related = await this.validRelated(tx, payload.relatedPostIds, id);
          if (related.join(',') !== current.relatedPostIds.join(',')) {
            data.relatedPostIds = related;
            changed.push('relatedPostIds');
          }
        }
        for (const locale of BLOG_LOCALES) {
          const next = translations[locale];
          if (next === undefined) continue;
          const before = translationColumns(current, locale);
          if (JSON.stringify(before) !== JSON.stringify(next)) {
            Object.assign(data, translationData(locale, next));
            changed.push(`translations.${locale}`);
          }
        }

        if (changed.length === 0) {
          return { detail: await this.loadDetail(tx, id, now), purge: false };
        }

        // A public post must stay publishable (W2 parity rule).
        if (affectsPublicSite(current.status)) {
          assertComplete({ ...current, ...(data as Partial<PlatformBlogPost>) });
        }

        data.updatedByUserId = platformOwnerId;
        data.version = { increment: 1 };
        let updated: PlatformBlogPost;
        try {
          updated = await tx.platformBlogPost.update({ where: { id }, data });
        } catch (error) {
          throw this.mapSlugConflict(error);
        }
        await this.audit(tx, platformOwnerId, BLOG_AUDIT.updated, updated, {
          slug: updated.slug,
          status: updated.status,
          changedFields: changed.join(','),
        });
        return {
          detail: await this.loadDetail(tx, id, now),
          purge: affectsPublicSite(current.status),
        };
      },
    );
    if (result.purge) this.edgeCachePurgeService.purgeBlog();
    return result.detail;
  }

  async publish(
    platformOwnerId: string,
    id: string,
    payload: PublishBlogPostDto,
    now: Date = new Date(),
  ): Promise<BlogPostDetail> {
    const target = resolvePublish(
      payload.publishAt ? new Date(payload.publishAt) : undefined,
      now,
    );
    const detail = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const current = await this.lockOrThrow(tx, id, payload.version);
        assertComplete(current);
        const updated = await tx.platformBlogPost.update({
          where: { id },
          data: {
            status: target.status,
            publishAt: target.publishAt,
            publishedAt:
              current.publishedAt && current.publishedAt.getTime() <= now.getTime()
                ? current.publishedAt
                : target.publishAt,
            updatedByUserId: platformOwnerId,
            version: { increment: 1 },
          },
        });
        await this.audit(tx, platformOwnerId, BLOG_AUDIT.published, updated, {
          slug: updated.slug,
          status: updated.status,
          previousStatus: current.status,
          publishAt: target.publishAt.toISOString(),
        });
        return this.loadDetail(tx, id, now);
      },
    );
    this.edgeCachePurgeService.purgeBlog();
    return detail;
  }

  /** Back to draft (also restores an archived post). */
  async unpublish(
    platformOwnerId: string,
    id: string,
    version: number,
    now: Date = new Date(),
  ): Promise<BlogPostDetail> {
    return this.transition(platformOwnerId, id, version, now, 'draft');
  }

  async archive(
    platformOwnerId: string,
    id: string,
    version: number,
    now: Date = new Date(),
  ): Promise<BlogPostDetail> {
    return this.transition(platformOwnerId, id, version, now, 'archived');
  }

  /** Only a draft or an archived post; its id is removed from other posts' related lists. */
  async remove(platformOwnerId: string, id: string): Promise<void> {
    const purge = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const current = await this.lockOrThrow(tx, id, null);
        if (current.status !== 'draft' && current.status !== 'archived') {
          throw new ConflictException({ messageKey: BLOG_ERRORS.deleteNotAllowed });
        }
        await tx.$executeRaw`
          UPDATE "platform_blog_posts"
             SET "related_post_ids" = array_remove("related_post_ids", ${id})
           WHERE ${id} = ANY("related_post_ids")`;
        await tx.platformBlogPost.delete({ where: { id } });
        await this.audit(tx, platformOwnerId, BLOG_AUDIT.deleted, current, {
          slug: current.slug,
          status: current.status,
        });
        // An archived post was public once; a draft never was.
        return current.status === 'archived' || current.publishedAt !== null;
      },
    );
    if (purge) this.edgeCachePurgeService.purgeBlog();
  }

  // ---------------------------------------------------------------------
  // Public reads (no context: RLS shows public posts only)
  // ---------------------------------------------------------------------

  async publicList(
    query: PublicBlogListQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResult<PublicBlogPostSummary>> {
    const locale = query.locale ?? 'en';
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? PUBLIC_BLOG_DEFAULT_PAGE_SIZE;
    const where: Prisma.PlatformBlogPostWhereInput = {
      ...publicWhere(now),
      ...localePresent(locale),
      ...(query.topic ? { topic: query.topic } : {}),
    };
    const { rows, total } = await this.tenancyContextService.runWithoutContext(
      async (tx) => ({
        rows: await tx.platformBlogPost.findMany({
          where,
          select: PUBLIC_SELECT,
          orderBy: [{ publishAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        total: await tx.platformBlogPost.count({ where }),
      }),
    );
    return {
      items: rows.map((row) => publicSummary(row, locale)),
      pagination: buildPaginationMeta(page, pageSize, total),
    };
  }

  async publicDetail(
    slug: string,
    locale: BlogLocale,
    now: Date = new Date(),
  ): Promise<PublicBlogPost> {
    if (!BLOG_SLUG_PATTERN.test(slug) || slug.length > 80) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return this.tenancyContextService.runWithoutContext(async (tx) => {
      const row = await tx.platformBlogPost.findFirst({
        where: { slug, ...publicWhere(now), ...localePresent(locale) },
      });
      if (!row || !isPubliclyVisible(row, now)) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const related = row.relatedPostIds.length
        ? await tx.platformBlogPost.findMany({
            where: {
              id: { in: row.relatedPostIds },
              ...publicWhere(now),
              ...localePresent(locale),
            },
            select: PUBLIC_SELECT,
          })
        : [];
      return this.toPublicDetail(row, locale, related);
    });
  }

  async publicSitemap(now: Date = new Date()): Promise<PublicBlogSitemap> {
    const rows = await this.tenancyContextService.runWithoutContext((tx) =>
      tx.platformBlogPost.findMany({
        where: publicWhere(now),
        select: { slug: true, updatedAt: true, titleEn: true, titleAr: true },
        orderBy: [{ publishAt: 'desc' }, { id: 'asc' }],
      }),
    );
    return {
      items: rows.map((row) => ({
        slug: row.slug,
        updatedAt: row.updatedAt.toISOString(),
        locales: BLOG_LOCALES.filter((locale) =>
          locale === 'en' ? row.titleEn !== null : row.titleAr !== null,
        ),
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async transition(
    platformOwnerId: string,
    id: string,
    version: number,
    now: Date,
    to: 'draft' | 'archived',
  ): Promise<BlogPostDetail> {
    const result = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const current = await this.lockOrThrow(tx, id, version);
        const allowed =
          to === 'draft' ? current.status !== 'draft' : current.status !== 'archived';
        if (!allowed) {
          throw new ConflictException({ messageKey: BLOG_ERRORS.invalidTransition });
        }
        const neverWentPublic =
          current.publishedAt !== null && current.publishedAt.getTime() > now.getTime();
        const updated = await tx.platformBlogPost.update({
          where: { id },
          data: {
            status: to,
            ...(to === 'draft' ? { publishAt: null } : {}),
            ...(neverWentPublic ? { publishedAt: null } : {}),
            updatedByUserId: platformOwnerId,
            version: { increment: 1 },
          },
        });
        await this.audit(
          tx,
          platformOwnerId,
          to === 'draft' ? BLOG_AUDIT.unpublished : BLOG_AUDIT.archived,
          updated,
          { slug: updated.slug, previousStatus: current.status },
        );
        return {
          detail: await this.loadDetail(tx, id, now),
          purge: affectsPublicSite(current.status),
        };
      },
    );
    if (result.purge) this.edgeCachePurgeService.purgeBlog();
    return result.detail;
  }

  private translationPatch(
    input: BlogTranslationsDto | undefined,
  ): Partial<Record<BlogLocale, BlogTranslationColumns>> {
    const patch: Partial<Record<BlogLocale, BlogTranslationColumns>> = {};
    if (!input) return patch;
    for (const locale of BLOG_LOCALES) {
      if (input[locale] === undefined) continue;
      const columns = normalizeTranslation(input[locale]);
      assertSafeMarkdown(locale, columns.body);
      patch[locale] = columns;
    }
    return patch;
  }

  /** Locks the row; with a version, refuses a stale one (409). */
  private async lockOrThrow(
    tx: Prisma.TransactionClient,
    id: string,
    version: number | null,
  ): Promise<PlatformBlogPost> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM platform_blog_posts WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) {
      throw new NotFoundException({ messageKey: BLOG_ERRORS.notFound });
    }
    const row = await tx.platformBlogPost.findUniqueOrThrow({ where: { id } });
    if (version !== null && row.version !== version) throw staleError();
    return row;
  }

  private async assertSlugFree(
    tx: Prisma.TransactionClient,
    slug: string,
    exceptId?: string,
  ): Promise<void> {
    const taken = await tx.platformBlogPost.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (taken && taken.id !== exceptId) {
      throw new ConflictException({ messageKey: BLOG_ERRORS.slugTaken });
    }
  }

  private mapSlugConflict(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException({ messageKey: BLOG_ERRORS.slugTaken });
    }
    return error;
  }

  /** 0..3 existing posts, never the post itself; order kept. */
  private async validRelated(
    tx: Prisma.TransactionClient,
    ids: readonly string[],
    selfId: string | null,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    if (selfId && ids.includes(selfId)) {
      throw new BadRequestException({ messageKey: BLOG_ERRORS.relatedPostInvalid });
    }
    const found = await tx.platformBlogPost.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true },
    });
    if (found.length !== new Set(ids).size) {
      throw new BadRequestException({ messageKey: BLOG_ERRORS.relatedPostInvalid });
    }
    return [...ids];
  }

  private async userNames(
    tx: Prisma.TransactionClient,
    ids: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private async loadDetail(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<BlogPostDetail> {
    const row = await tx.platformBlogPost.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ messageKey: BLOG_ERRORS.notFound });
    const names = await this.userNames(tx, [row.createdByUserId, row.updatedByUserId]);
    return {
      ...this.base(row, names, now),
      translations: {
        en: translationResponse(translationColumns(row, 'en')),
        ar: translationResponse(translationColumns(row, 'ar')),
      },
    };
  }

  private toListItem(
    row: PlatformBlogPost,
    names: Map<string, string>,
    now: Date,
  ): BlogPostListItem {
    const summary = (locale: BlogLocale) => {
      const columns = translationColumns(row, locale);
      return hasTranslation(columns)
        ? { title: columns.title ?? '', excerpt: columns.excerpt ?? '' }
        : null;
    };
    return {
      ...this.base(row, names, now),
      translations: { en: summary('en'), ar: summary('ar') },
    };
  }

  private base(row: PlatformBlogPost, names: Map<string, string>, now: Date) {
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      topic: row.topic,
      status: row.status,
      publishAt: row.publishAt?.toISOString() ?? null,
      isPublic: isPubliclyVisible(row, now),
      featured: row.featured,
      coverImage: coverImage(row),
      authorName: row.authorName,
      relatedPostIds: row.relatedPostIds,
      readingMinutes: { en: row.readingMinutesEn, ar: row.readingMinutesAr },
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdByName: names.get(row.createdByUserId) ?? null,
      updatedByName: names.get(row.updatedByUserId) ?? null,
    };
  }

  private toPublicDetail(
    row: PlatformBlogPost,
    locale: BlogLocale,
    relatedRows: readonly PublicRow[],
  ): PublicBlogPost {
    const columns = translationColumns(row, locale);
    const other: BlogLocale = locale === 'en' ? 'ar' : 'en';
    const byId = new Map(relatedRows.map((related) => [related.id, related]));
    return {
      ...publicSummary(row, locale),
      locale,
      body: columns.body ?? '',
      seoTitle: columns.seoTitle,
      seoDescription: columns.seoDescription,
      related: row.relatedPostIds
        .map((relatedId) => byId.get(relatedId))
        .filter((related): related is PublicRow => !!related)
        .map((related) => publicSummary(related, locale)),
      alternateLocaleAvailable: hasTranslation(translationColumns(row, other)),
    };
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    action: (typeof BLOG_AUDIT)[keyof typeof BLOG_AUDIT],
    row: Pick<PlatformBlogPost, 'id' | 'slug' | 'titleEn' | 'titleAr'>,
    context: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.auditLogWriterService.write(tx, {
      actorUserId,
      role: ROLE,
      action,
      targetType: TARGET_TYPE,
      targetId: row.id,
      targetLabel: row.titleEn ?? row.titleAr ?? row.slug,
      context,
    });
  }
}
