/** `BlogPost` response contract — matches `blog.types.ts` field-for-field. */
import type { BlogPost as PrismaBlogPost } from '@prisma/client';

export interface BlogPostResponse {
  readonly id: string;
  readonly academyId?: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly title: string;
  readonly slug: string;
  readonly excerpt?: string;
  readonly content: string;
  readonly featuredImage?: string;
  readonly category?: string;
  readonly tags: readonly string[];
  readonly status: PrismaBlogPost['status'];
  readonly publishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toBlogPostResponse(
  post: PrismaBlogPost,
  authorName: string,
): BlogPostResponse {
  return {
    id: post.id,
    academyId: post.academyId ?? undefined,
    authorId: post.authorId,
    authorName,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt ?? undefined,
    content: post.content,
    featuredImage: post.featuredImage ?? undefined,
    category: post.category ?? undefined,
    tags: post.tags,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString(),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}
