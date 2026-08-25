/** `Forum`/`ForumThread`/`ForumReply` response contracts — match `forum.types.ts` field-for-field. `threadCount`/`replyCount` are real, computed counts (never stored counters), matching `CourseCategoryResponse.courseCount`'s exact P5 precedent. */
import type {
  Forum as PrismaForum,
  ForumReply as PrismaForumReply,
  ForumThread as PrismaForumThread,
} from '@prisma/client';

export interface ForumResponse {
  readonly id: string;
  readonly academyId: string;
  readonly courseId: string;
  readonly title: string;
  readonly description?: string;
  readonly status: PrismaForum['status'];
  readonly threadCount: number;
}

export function toForumResponse(forum: PrismaForum, threadCount: number): ForumResponse {
  return {
    id: forum.id,
    academyId: forum.academyId,
    courseId: forum.courseId,
    title: forum.title,
    description: forum.description ?? undefined,
    status: forum.status,
    threadCount,
  };
}

export interface ForumThreadResponse {
  readonly id: string;
  readonly forumId: string;
  readonly courseId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly title: string;
  readonly body: string;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly replyCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toForumThreadResponse(
  thread: PrismaForumThread,
  authorName: string,
  replyCount: number,
): ForumThreadResponse {
  return {
    id: thread.id,
    forumId: thread.forumId,
    courseId: thread.courseId,
    authorId: thread.authorId,
    authorName,
    title: thread.title,
    body: thread.body,
    pinned: thread.pinned,
    locked: thread.locked,
    replyCount,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export interface ForumReplyResponse {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toForumReplyResponse(
  reply: PrismaForumReply,
  authorName: string,
): ForumReplyResponse {
  return {
    id: reply.id,
    threadId: reply.threadId,
    authorId: reply.authorId,
    authorName,
    body: reply.body,
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
  };
}
