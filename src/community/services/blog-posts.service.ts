/**
 * BlogPostsService — matches `BlogService` (atlas frontend) exactly.
 * `CreateBlogPostPayload` carries no `academyId` field at all
 * (`BlogService`'s own doc comment: "Ownership... resolved server-side
 * from the authenticated session") — `resolveAuthorAcademyId` is the one
 * real business rule this phase adds to make that concrete, since no
 * frontend contract or master plan §5.5 line spells it out: a
 * `platform_owner` authors a platform-level post (`academyId: null`); any
 * other user must hold exactly one real `academy_members` staff row to
 * author an academy-level post — zero real ownership decisions are
 * available otherwise, so this is deliberately narrow rather than
 * guessing which of several academies a multi-academy staff member meant
 * (a genuine product decision this phase does not invent an answer to).
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { BlogPostsRepository } from '../repositories/blog-posts.repository';
import { toBlogPostResponse } from '../dto/blog-post.contract';
import type { BlogPostResponse } from '../dto/blog-post.contract';
import type { CreateBlogPostDto } from '../dto/create-blog-post.dto';
import type { UpdateBlogPostDto } from '../dto/update-blog-post.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { Prisma } from '@prisma/client';

/**
 * Phase 9 (roadmap finding I1) removed `'instructor'` from this set. The
 * Blog is one of the three surfaces the roadmap identified as still
 * leaking to Instructors, and its acceptance criterion requires a real
 * 403 through a direct API call, not just a hidden navigation link — so
 * the matching `blog.view` string was dropped from
 * `ORGANIZATION_INSTRUCTOR_PERMISSIONS` at the same time. `'staff'` is
 * deliberately kept: staff are an academy's content/administrative
 * people and were never named as leaking.
 */
const AUTHORING_ROLES = ['owner', 'administrator', 'manager', 'staff'];

@Injectable()
export class BlogPostsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly blogPostsRepository: BlogPostsRepository,
  ) {}

  /**
   * Phase 1 (Extended Scope, Decision 11, dependency B) — `academyId`
   * omitted keeps the exact pre-existing rule (0 real memberships →
   * forbidden, exactly 1 → use it, more than 1 → the "ambiguous academy"
   * error, since guessing among several is still not this method's job).
   * `academyId` supplied is the actual gap closed: resolved against the
   * caller's own real `academy_members` rows, never trusted on its own —
   * a value that does not match one of the caller's own authoring-role
   * memberships is rejected exactly like having none at all, never
   * silently substituted for a different academy.
   */
  private async resolveAuthorAcademyId(
    tx: Prisma.TransactionClient,
    userId: string,
    requestedAcademyId?: string,
  ): Promise<string | null> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { isPlatformOwner: true },
    });
    if (user?.isPlatformOwner) return null;

    const memberships = await tx.academyMember.findMany({
      where: { userId, role: { in: AUTHORING_ROLES as never } },
      select: { academyId: true },
    });

    if (requestedAcademyId) {
      const matches = memberships.some((m) => m.academyId === requestedAcademyId);
      if (!matches) {
        throw new ForbiddenException({ messageKey: 'errors.forbidden' });
      }
      return requestedAcademyId;
    }

    if (memberships.length === 0) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }
    if (memberships.length > 1) {
      throw new BadRequestException({ messageKey: 'errors.blog.ambiguousAcademy' });
    }
    return memberships[0].academyId;
  }

  async getPosts(
    userId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<BlogPostResponse>> {
    const page = query?.page ?? DEFAULT_PAGE;
    const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { items, totalItems } = await this.blogPostsRepository.findVisible(tx, {
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      return {
        items: items.map((p) => toBlogPostResponse(p, p.author.name)),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async getPost(userId: string, id: string): Promise<BlogPostResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const post = await this.blogPostsRepository.findById(tx, id);
      if (!post) throw new NotFoundException({ messageKey: 'errors.notFound' });
      return toBlogPostResponse(post, post.author.name);
    });
  }

  /**
   * Phase 6 — `scheduledAt` must be a real future instant; a past/`now`
   * timestamp would create a `scheduled` post the sweep tick can never
   * legitimately "catch" as newly-due, so it is rejected outright rather
   * than silently published immediately (which "scheduled" `AnnouncementsService`
   * itself does not need to guard against, since nothing there prevents
   * `scheduled`-but-already-due either — this is a stricter rule this
   * phase adds specifically for blog per the master plan's own "validate
   * scheduled dates" instruction).
   */
  private assertValidScheduledAt(scheduledAt?: string): Date | undefined {
    if (!scheduledAt) return undefined;
    const date = new Date(scheduledAt);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      throw new BadRequestException({ messageKey: 'errors.blog.invalidScheduledDate' });
    }
    return date;
  }

  async createPost(
    userId: string,
    payload: CreateBlogPostDto,
  ): Promise<BlogPostResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const academyId = await this.resolveAuthorAcademyId(tx, userId, payload.academyId);
      const existing = await this.blogPostsRepository.findByAcademyAndSlug(
        tx,
        academyId,
        payload.slug,
      );
      if (existing)
        throw new BadRequestException({ messageKey: 'errors.blog.slugTaken' });

      const scheduledAt = this.assertValidScheduledAt(payload.scheduledAt);
      const created = await this.blogPostsRepository.create(tx, {
        academy: academyId ? { connect: { id: academyId } } : undefined,
        author: { connect: { id: userId } },
        title: payload.title,
        slug: payload.slug,
        excerpt: payload.excerpt,
        content: payload.content,
        featuredImage: payload.featuredImage,
        category: payload.category,
        tags: payload.tags ? [...payload.tags] : [],
        scheduledAt,
        status: scheduledAt ? 'scheduled' : 'draft',
        metaTitle: payload.metaTitle,
        metaDescription: payload.metaDescription,
        ogImage: payload.ogImage,
      });
      return toBlogPostResponse(created, created.author.name);
    });
  }

  private async assertOwnsPost(
    tx: Prisma.TransactionClient,
    userId: string,
    id: string,
  ): Promise<void> {
    const post = await this.blogPostsRepository.findById(tx, id);
    if (!post) throw new NotFoundException({ messageKey: 'errors.notFound' });
    if (post.authorId !== userId)
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
  }

  async updatePost(
    userId: string,
    id: string,
    payload: UpdateBlogPostDto,
  ): Promise<BlogPostResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertOwnsPost(tx, userId, id);
      const scheduledAt =
        payload.scheduledAt !== undefined
          ? this.assertValidScheduledAt(payload.scheduledAt)
          : undefined;
      const updated = await this.blogPostsRepository.update(tx, id, {
        title: payload.title,
        slug: payload.slug,
        excerpt: payload.excerpt,
        content: payload.content,
        featuredImage: payload.featuredImage,
        category: payload.category,
        tags: payload.tags ? [...payload.tags] : undefined,
        scheduledAt,
        status:
          payload.scheduledAt !== undefined
            ? scheduledAt
              ? 'scheduled'
              : 'draft'
            : undefined,
        metaTitle: payload.metaTitle,
        metaDescription: payload.metaDescription,
        ogImage: payload.ogImage,
      });
      return toBlogPostResponse(updated, updated.author.name);
    });
  }

  async publishPost(userId: string, id: string): Promise<BlogPostResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertOwnsPost(tx, userId, id);
      const updated = await this.blogPostsRepository.update(tx, id, {
        status: 'published',
        publishedAt: new Date(),
      });
      return toBlogPostResponse(updated, updated.author.name);
    });
  }

  async archivePost(userId: string, id: string): Promise<BlogPostResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertOwnsPost(tx, userId, id);
      const updated = await this.blogPostsRepository.update(tx, id, {
        status: 'archived',
      });
      return toBlogPostResponse(updated, updated.author.name);
    });
  }

  async deletePost(userId: string, id: string): Promise<void> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertOwnsPost(tx, userId, id);
      await this.blogPostsRepository.delete(tx, id);
    });
  }
}
