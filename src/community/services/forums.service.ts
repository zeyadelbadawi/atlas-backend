/**
 * ForumsService — matches `ForumService` (atlas frontend) exactly: one
 * service for Forum/Thread/Reply, nested under `courses/:id/forum/*`.
 *
 * Participant check (read/post) mirrors the `forums_participant_select`/
 * `_insert` RLS policies (P7 migration) exactly: an active enrollment, a
 * real `course_instructors` row, or any real `academy_members` row for the
 * course's academy. Moderation (pin/unpin/lock/unlock — "Requires forum
 * moderation authorization", the frontend service's own doc comments) is
 * narrower: the course's real instructor, or the owning academy's
 * `owner`/`administrator` — mirrors `forum_threads_moderate_update`'s RLS
 * exactly, the same two write-authorization mechanisms this codebase
 * already has elsewhere, never a third.
 *
 * No create endpoint exists for `Forum` itself — a course's forum is
 * get-or-created lazily on first legitimate access (see schema.prisma's
 * `Forum` doc comment).
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { ForumsRepository } from '../repositories/forums.repository';
import {
  toForumReplyResponse,
  toForumResponse,
  toForumThreadResponse,
} from '../dto/forum.contract';
import type {
  ForumReplyResponse,
  ForumResponse,
  ForumThreadResponse,
} from '../dto/forum.contract';
import type { CreateForumThreadDto } from '../dto/create-forum-thread.dto';
import type { CreateForumReplyDto } from '../dto/create-forum-reply.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { Forum, Prisma } from '@prisma/client';

const MODERATING_ROLES = new Set(['owner', 'administrator']);
const ACTIVE_ENROLLMENT_STATUSES = new Set(['enrolled', 'completed']);

@Injectable()
export class ForumsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly forumsRepository: ForumsRepository,
  ) {}

  private async findParticipantFacts(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<{
    isParticipant: boolean;
    isModerator: boolean;
    enrollmentAcademyId?: string;
  }> {
    const [enrollment, isInstructor, membership] = await Promise.all([
      tx.enrollment.findUnique({
        where: { studentId_courseId: { studentId: userId, courseId } },
      }),
      tx.courseInstructor
        .findUnique({ where: { courseId_userId: { courseId, userId } } })
        .then((row) => row !== null),
      tx.course
        .findUnique({ where: { id: courseId }, select: { academyId: true } })
        .then(async (course) =>
          course
            ? tx.academyMember.findFirst({
                where: { academyId: course.academyId, userId },
              })
            : null,
        ),
    ]);

    const hasActiveEnrollment =
      !!enrollment && ACTIVE_ENROLLMENT_STATUSES.has(enrollment.status);

    return {
      isParticipant: hasActiveEnrollment || isInstructor || !!membership,
      isModerator:
        isInstructor || (!!membership && MODERATING_ROLES.has(membership.role)),
      enrollmentAcademyId: enrollment?.academyId,
    };
  }

  private async assertParticipant(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<{ isModerator: boolean; enrollmentAcademyId?: string }> {
    const facts = await this.findParticipantFacts(tx, userId, courseId);
    if (!facts.isParticipant) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return facts;
  }

  private async getOrCreateForum(
    tx: Prisma.TransactionClient,
    courseId: string,
    knownAcademyId?: string,
  ): Promise<Forum> {
    const existing = await this.forumsRepository.findByCourseId(tx, courseId);
    if (existing) return existing;

    const academyId =
      knownAcademyId ??
      (
        await tx.course.findUnique({
          where: { id: courseId },
          select: { academyId: true },
        })
      )?.academyId;
    if (!academyId) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return this.forumsRepository.create(tx, {
      course: { connect: { id: courseId } },
      academyId,
      title: 'Course Discussion',
    });
  }

  async getForum(userId: string, courseId: string): Promise<ForumResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { enrollmentAcademyId } = await this.assertParticipant(tx, userId, courseId);
      const forum = await this.getOrCreateForum(tx, courseId, enrollmentAcademyId);
      const threadCount = await this.forumsRepository.countThreads(tx, forum.id);
      return toForumResponse(forum, threadCount);
    });
  }

  async getThreads(
    userId: string,
    courseId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<ForumThreadResponse>> {
    const page = query?.page ?? DEFAULT_PAGE;
    const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { enrollmentAcademyId } = await this.assertParticipant(tx, userId, courseId);
      const forum = await this.getOrCreateForum(tx, courseId, enrollmentAcademyId);
      const { items, totalItems } = await this.forumsRepository.findThreads(
        tx,
        forum.id,
        {
          skip: (page - 1) * pageSize,
          take: pageSize,
        },
      );
      const withReplyCounts = await Promise.all(
        items.map(async (thread) => {
          const replyCount = await this.forumsRepository.countReplies(tx, thread.id);
          return toForumThreadResponse(thread, thread.author.name, replyCount);
        }),
      );
      return {
        items: withReplyCounts,
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  private async assertThreadInCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    threadId: string,
  ) {
    const thread = await this.forumsRepository.findThreadById(tx, threadId);
    if (!thread || thread.courseId !== courseId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return thread;
  }

  async getThread(
    userId: string,
    courseId: string,
    threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertParticipant(tx, userId, courseId);
      const thread = await this.assertThreadInCourse(tx, courseId, threadId);
      const replyCount = await this.forumsRepository.countReplies(tx, thread.id);
      return toForumThreadResponse(thread, thread.author.name, replyCount);
    });
  }

  async getReplies(
    userId: string,
    courseId: string,
    threadId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<ForumReplyResponse>> {
    const page = query?.page ?? DEFAULT_PAGE;
    const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertParticipant(tx, userId, courseId);
      await this.assertThreadInCourse(tx, courseId, threadId);
      const { items, totalItems } = await this.forumsRepository.findReplies(
        tx,
        threadId,
        {
          skip: (page - 1) * pageSize,
          take: pageSize,
        },
      );
      return {
        items: items.map((r) => toForumReplyResponse(r, r.author.name)),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async createThread(
    userId: string,
    courseId: string,
    payload: CreateForumThreadDto,
  ): Promise<ForumThreadResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { enrollmentAcademyId } = await this.assertParticipant(tx, userId, courseId);
      const forum = await this.getOrCreateForum(tx, courseId, enrollmentAcademyId);
      const thread = await this.forumsRepository.createThread(tx, {
        forum: { connect: { id: forum.id } },
        courseId,
        author: { connect: { id: userId } },
        title: payload.title,
        body: payload.body,
      });
      return toForumThreadResponse(thread, thread.author.name, 0);
    });
  }

  async createReply(
    userId: string,
    courseId: string,
    threadId: string,
    payload: CreateForumReplyDto,
  ): Promise<ForumReplyResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertParticipant(tx, userId, courseId);
      const thread = await this.assertThreadInCourse(tx, courseId, threadId);
      if (thread.locked) {
        throw new ForbiddenException({ messageKey: 'errors.forum.threadLocked' });
      }
      const reply = await this.forumsRepository.createReply(tx, {
        thread: { connect: { id: threadId } },
        author: { connect: { id: userId } },
        body: payload.body,
      });
      return toForumReplyResponse(reply, reply.author.name);
    });
  }

  private async assertModerator(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<void> {
    const { isModerator } = await this.findParticipantFacts(tx, userId, courseId);
    if (!isModerator) throw new ForbiddenException({ messageKey: 'errors.forbidden' });
  }

  private async setThreadFlags(
    userId: string,
    courseId: string,
    threadId: string,
    data: Prisma.ForumThreadUpdateInput,
  ): Promise<ForumThreadResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertModerator(tx, userId, courseId);
      await this.assertThreadInCourse(tx, courseId, threadId);
      const updated = await this.forumsRepository.updateThread(tx, threadId, data);
      const replyCount = await this.forumsRepository.countReplies(tx, threadId);
      return toForumThreadResponse(updated, updated.author.name, replyCount);
    });
  }

  pinThread(
    userId: string,
    courseId: string,
    threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.setThreadFlags(userId, courseId, threadId, { pinned: true });
  }

  unpinThread(
    userId: string,
    courseId: string,
    threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.setThreadFlags(userId, courseId, threadId, { pinned: false });
  }

  lockThread(
    userId: string,
    courseId: string,
    threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.setThreadFlags(userId, courseId, threadId, { locked: true });
  }

  unlockThread(
    userId: string,
    courseId: string,
    threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.setThreadFlags(userId, courseId, threadId, { locked: false });
  }
}
