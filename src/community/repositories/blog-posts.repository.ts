/** BlogPostsRepository — every method takes a `Prisma.TransactionClient` obtained from `TenancyContextService.runInUserContext`, matching every other repository in this codebase's established rule. */
import { Injectable } from '@nestjs/common';
import type { BlogPost, Prisma } from '@prisma/client';

export type BlogPostWithAuthor = BlogPost & { author: { name: string } };

const WITH_AUTHOR = { author: { select: { name: true } } } as const;

@Injectable()
export class BlogPostsRepository {
  async findVisible(
    tx: Prisma.TransactionClient,
    options: { skip: number; take: number },
  ): Promise<{ items: BlogPostWithAuthor[]; totalItems: number }> {
    const [items, totalItems] = await Promise.all([
      tx.blogPost.findMany({
        include: WITH_AUTHOR,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.blogPost.count(),
    ]);
    return { items, totalItems };
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<BlogPostWithAuthor | null> {
    return tx.blogPost.findUnique({ where: { id }, include: WITH_AUTHOR });
  }

  findByAcademyAndSlug(
    tx: Prisma.TransactionClient,
    academyId: string | null,
    slug: string,
  ): Promise<BlogPost | null> {
    return tx.blogPost.findFirst({ where: { academyId, slug } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.BlogPostCreateInput,
  ): Promise<BlogPostWithAuthor> {
    return tx.blogPost.create({ data, include: WITH_AUTHOR });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.BlogPostUpdateInput,
  ): Promise<BlogPostWithAuthor> {
    return tx.blogPost.update({ where: { id }, data, include: WITH_AUTHOR });
  }

  delete(tx: Prisma.TransactionClient, id: string): Promise<BlogPost> {
    return tx.blogPost.delete({ where: { id } });
  }
}
