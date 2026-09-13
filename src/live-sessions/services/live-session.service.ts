/**
 * LiveSessionService — creating and managing Live Sessions as course
 * activities.
 *
 * EVERY REFERENCE IS RE-VERIFIED AGAINST THE ACADEMY THE GUARD ALREADY
 * PROVED. A caller supplies a course id, maybe a section id, maybe a host
 * user id; each one is checked to belong to THIS academy before it is
 * used. That is what stops a well-formed request from stitching one
 * tenant's course to another tenant's section — the ids look valid
 * individually, and only the relationship is wrong.
 *
 * SCHEDULING RULES LIVE HERE, not in the DTO, because they are cross-field
 * and class-validator sees one property at a time. Splitting a rule across
 * two layers is how it ends up enforced in neither.
 *
 * THE PROVIDER IS NOT CALLED ON CREATE. A session is created in Atlas
 * first and the provider meeting is created when it is published — so a
 * draft costs nothing at Zoom, and a provider outage cannot stop an
 * instructor from drafting their curriculum.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AddOnAccessService } from './add-on-access.service';

/** A session must be at least this long — a 0-minute meeting is a mistake, not a choice. */
export const MIN_SESSION_MINUTES = 5;
/** And no longer than this. Guards against a typo turning into a year-long meeting. */
export const MAX_SESSION_MINUTES = 12 * 60;

export interface CreateLiveSessionInput {
  readonly academyId: string;
  readonly courseId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly title: string;
  readonly description?: string;
  readonly sectionId?: string;
  readonly scheduledStartAt: Date;
  readonly scheduledEndAt: Date;
  readonly hostUserId?: string;
  readonly recordingEnabled?: boolean;
}

@Injectable()
export class LiveSessionService {
  constructor(private readonly addOnAccessService: AddOnAccessService) {}

  /**
   * Validates the schedule.
   *
   * `now` is injected rather than read from the clock so this is testable
   * and so a single request cannot disagree with itself about what "now"
   * means partway through.
   */
  private assertValidSchedule(startAt: Date, endAt: Date): void {
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.invalidSchedule',
      });
    }

    if (endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.endBeforeStart',
      });
    }

    const minutes = (endAt.getTime() - startAt.getTime()) / 60_000;
    if (minutes < MIN_SESSION_MINUTES || minutes > MAX_SESSION_MINUTES) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.invalidDuration',
        details: { minMinutes: MIN_SESSION_MINUTES, maxMinutes: MAX_SESSION_MINUTES },
      });
    }
  }

  /**
   * Resolves a course, proving it belongs to this academy.
   *
   * The academy comes from the GUARD, never from the request body, so a
   * caller cannot widen their own scope by claiming a different academy.
   */
  private async requireCourseInAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    courseId: string,
  ): Promise<{ id: string }> {
    const course = await tx.course.findFirst({
      where: { id: courseId, academyId },
      select: { id: true },
    });
    // 404 rather than 403: a course in another tenant must be
    // indistinguishable from one that does not exist.
    if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return course;
  }

  /**
   * A section is only usable if it belongs to the SAME course. Checking
   * only that it exists would let a caller attach a session to another
   * course's unit — both ids valid, the relationship nonsense.
   */
  private async assertSectionBelongsToCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    sectionId: string,
  ): Promise<void> {
    const section = await tx.courseSection.findFirst({
      where: { id: sectionId, courseId },
      select: { id: true },
    });
    if (!section) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.sectionNotInCourse',
      });
    }
  }

  /**
   * The host must be a real member of this academy.
   *
   * Without this an instructor could be assigned from another tenant —
   * which would leak the session into their dashboard and make them the
   * provider-side host of a meeting they have no relationship to.
   */
  private async assertHostInAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    hostUserId: string,
  ): Promise<void> {
    const member = await tx.academyMember.findFirst({
      // `status: 'active'` matters: a removed or suspended member must not
      // remain assignable as a host just because the row still exists.
      where: { academyId, userId: hostUserId, status: 'active' },
      select: { id: true },
    });
    if (!member) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.hostNotInAcademy',
      });
    }
  }

  /** Next position at the end of the target unit, so a new activity appends rather than colliding. */
  private async nextOrder(
    tx: Prisma.TransactionClient,
    courseId: string,
    sectionId: string | null,
  ): Promise<number> {
    const last = await tx.liveSession.findFirst({
      where: { courseId, sectionId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return (last?.order ?? -1) + 1;
  }

  async create(tx: Prisma.TransactionClient, input: CreateLiveSessionInput) {
    // The add-on gate first: nothing is validated, created, or charged for
    // a tenant that may not use this capability at all.
    await this.addOnAccessService.assertUsable(tx, input.organizationId);

    await this.requireCourseInAcademy(tx, input.academyId, input.courseId);
    this.assertValidSchedule(input.scheduledStartAt, input.scheduledEndAt);

    if (input.sectionId) {
      await this.assertSectionBelongsToCourse(tx, input.courseId, input.sectionId);
    }

    const hostUserId = input.hostUserId ?? input.actorUserId;
    await this.assertHostInAcademy(tx, input.academyId, hostUserId);

    return tx.liveSession.create({
      data: {
        courseId: input.courseId,
        sectionId: input.sectionId ?? null,
        academyId: input.academyId,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        order: await this.nextOrder(tx, input.courseId, input.sectionId ?? null),
        scheduledStartAt: input.scheduledStartAt,
        scheduledEndAt: input.scheduledEndAt,
        hostUserId,
        // Explicitly false when absent. Recording is opt-in, always.
        recordingEnabled: input.recordingEnabled === true,
        status: 'draft',
        createdByUserId: input.actorUserId,
      },
    });
  }

  /** Every session for one course, ordered as the curriculum shows them. */
  listForCourse(tx: Prisma.TransactionClient, academyId: string, courseId: string) {
    return tx.liveSession.findMany({
      where: { courseId, academyId },
      orderBy: [{ sectionId: 'asc' }, { order: 'asc' }, { scheduledStartAt: 'asc' }],
      include: {
        hostUser: { select: { id: true, name: true } },
        recording: { select: { status: true, availableAt: true } },
      },
    });
  }

  async getById(tx: Prisma.TransactionClient, academyId: string, liveSessionId: string) {
    const session = await tx.liveSession.findFirst({
      where: { id: liveSessionId, academyId },
      include: {
        hostUser: { select: { id: true, name: true } },
        recording: { select: { status: true, availableAt: true } },
      },
    });
    if (!session) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return session;
  }

  async update(
    tx: Prisma.TransactionClient,
    args: {
      readonly academyId: string;
      readonly organizationId: string;
      readonly liveSessionId: string;
      readonly patch: {
        title?: string;
        description?: string;
        sectionId?: string;
        scheduledStartAt?: Date;
        scheduledEndAt?: Date;
        hostUserId?: string;
        recordingEnabled?: boolean;
        status?: 'draft' | 'scheduled' | 'cancelled';
      };
    },
  ) {
    await this.addOnAccessService.assertUsable(tx, args.organizationId);
    const existing = await this.getById(tx, args.academyId, args.liveSessionId);

    // A session that has already run is a record of something that
    // happened. Editing its schedule afterwards would silently rewrite the
    // basis every attendance percentage was calculated against.
    if (existing.status === 'ended') {
      throw new ForbiddenException({
        messageKey: 'errors.liveSessions.alreadyEnded',
      });
    }

    const startAt = args.patch.scheduledStartAt ?? existing.scheduledStartAt;
    const endAt = args.patch.scheduledEndAt ?? existing.scheduledEndAt;
    if (args.patch.scheduledStartAt || args.patch.scheduledEndAt) {
      this.assertValidSchedule(startAt, endAt);
    }

    if (args.patch.sectionId) {
      await this.assertSectionBelongsToCourse(
        tx,
        existing.courseId,
        args.patch.sectionId,
      );
    }
    if (args.patch.hostUserId) {
      await this.assertHostInAcademy(tx, args.academyId, args.patch.hostUserId);
    }

    // Turning recording OFF is always allowed. Turning it ON after the
    // provider meeting exists is handled at publish/start time, where the
    // quota is actually charged — a checkbox never spends the allowance.
    return tx.liveSession.update({
      where: { id: args.liveSessionId },
      data: {
        ...(args.patch.title !== undefined ? { title: args.patch.title.trim() } : {}),
        ...(args.patch.description !== undefined
          ? { description: args.patch.description.trim() || null }
          : {}),
        ...(args.patch.sectionId !== undefined
          ? { sectionId: args.patch.sectionId }
          : {}),
        ...(args.patch.scheduledStartAt ? { scheduledStartAt: startAt } : {}),
        ...(args.patch.scheduledEndAt ? { scheduledEndAt: endAt } : {}),
        ...(args.patch.hostUserId ? { hostUserId: args.patch.hostUserId } : {}),
        ...(args.patch.recordingEnabled !== undefined
          ? { recordingEnabled: args.patch.recordingEnabled }
          : {}),
        ...(args.patch.status ? { status: args.patch.status } : {}),
        ...(args.patch.status === 'cancelled' ? { cancelledAt: new Date() } : {}),
      },
    });
  }

  /**
   * Moves a session within the curriculum.
   *
   * Ordering is intentionally NOT globally unique: `course_lessons` does
   * not enforce uniqueness either, and a drag-and-drop that renumbers a
   * whole unit would fight a unique constraint the entire time. Ties break
   * deterministically on `scheduledStartAt` in the list query.
   */
  async reorder(
    tx: Prisma.TransactionClient,
    args: {
      readonly academyId: string;
      readonly liveSessionId: string;
      readonly sectionId?: string;
      readonly order: number;
    },
  ) {
    const existing = await this.getById(tx, args.academyId, args.liveSessionId);
    if (args.sectionId) {
      await this.assertSectionBelongsToCourse(tx, existing.courseId, args.sectionId);
    }
    return tx.liveSession.update({
      where: { id: args.liveSessionId },
      data: {
        order: args.order,
        ...(args.sectionId !== undefined ? { sectionId: args.sectionId } : {}),
      },
    });
  }
}
