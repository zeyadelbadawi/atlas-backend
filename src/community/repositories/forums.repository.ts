/** ForumsRepository — every method takes a `Prisma.TransactionClient` obtained from `TenancyContextService.runInUserContext`, matching every other repository in this codebase's established rule. */
import { Injectable } from '@nestjs/common';
import type { Forum, ForumReply, ForumThread, Prisma } from '@prisma/client';

export type ForumThreadWithAuthor = ForumThread & { author: { name: string } };
export type ForumReplyWithAuthor = ForumReply & { author: { name: string } };

@Injectable()
export class ForumsRepository {
  findByCourseId(tx: Prisma.TransactionClient, courseId: string): Promise<Forum | null> {
    return tx.forum.findUnique({ where: { courseId } });
  }

  create(tx: Prisma.TransactionClient, data: Prisma.ForumCreateInput): Promise<Forum> {
    return tx.forum.create({ data });
  }

  countThreads(tx: Prisma.TransactionClient, forumId: string): Promise<number> {
    return tx.forumThread.count({ where: { forumId } });
  }

  async findThreads(
    tx: Prisma.TransactionClient,
    forumId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: ForumThreadWithAuthor[]; totalItems: number }> {
    const where: Prisma.ForumThreadWhereInput = { forumId };
    const [items, totalItems] = await Promise.all([
      tx.forumThread.findMany({
        where,
        include: { author: { select: { name: true } } },
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        skip: options.skip,
        take: options.take,
      }),
      tx.forumThread.count({ where }),
    ]);
    return { items, totalItems };
  }

  findThreadById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<ForumThreadWithAuthor | null> {
    return tx.forumThread.findUnique({
      where: { id },
      include: { author: { select: { name: true } } },
    });
  }

  createThread(
    tx: Prisma.TransactionClient,
    data: Prisma.ForumThreadCreateInput,
  ): Promise<ForumThreadWithAuthor> {
    return tx.forumThread.create({
      data,
      include: { author: { select: { name: true } } },
    });
  }

  updateThread(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.ForumThreadUpdateInput,
  ): Promise<ForumThreadWithAuthor> {
    return tx.forumThread.update({
      where: { id },
      data,
      include: { author: { select: { name: true } } },
    });
  }

  countReplies(tx: Prisma.TransactionClient, threadId: string): Promise<number> {
    return tx.forumReply.count({ where: { threadId } });
  }

  async findReplies(
    tx: Prisma.TransactionClient,
    threadId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: ForumReplyWithAuthor[]; totalItems: number }> {
    const where: Prisma.ForumReplyWhereInput = { threadId };
    const [items, totalItems] = await Promise.all([
      tx.forumReply.findMany({
        where,
        include: { author: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.forumReply.count({ where }),
    ]);
    return { items, totalItems };
  }

  createReply(
    tx: Prisma.TransactionClient,
    data: Prisma.ForumReplyCreateInput,
  ): Promise<ForumReplyWithAuthor> {
    return tx.forumReply.create({
      data,
      include: { author: { select: { name: true } } },
    });
  }
}
