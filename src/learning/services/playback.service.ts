/**
 * Playback heartbeats and the evidence they produce (master plan Phase 2
 * §D.6).
 *
 * The player posts a heartbeat every ~20 seconds while a lesson is
 * playing. Two things happen per beat, and it is worth being clear that
 * they are separate concerns that happen to share a request:
 *
 *   1. EVIDENCE. `applyPlaybackHeartbeat` credits at most the wall-clock
 *      time that actually passed on the server, so `max_watched_ratio`
 *      means something even though the only thing reporting it is the
 *      learner's own browser. See that file for the full reasoning.
 *   2. THE LEASE. The same beat renews the single-session lease. Bundling
 *      them is deliberate: a browser that is genuinely playing is exactly
 *      the browser that should keep the lease, and a separate keep-alive
 *      endpoint would let a tab that is not playing anything hold it.
 *
 * The response tells the client whether it still holds the lease, so a
 * player that lost it can pause and show the takeover state instead of
 * playing on silently — Phase 2 §E.4's "lease-lost pause state (no
 * progress loss)". Progress already recorded is never rolled back.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseProgressRepository } from '../repositories/course-progress.repository';
import { LearningLeaseService } from './learning-lease.service';
import { assertActiveEnrollment } from './learning-access.util';
import { applyPlaybackHeartbeat } from './playback-evidence.util';
import { MINIMUM_WATCHED_RATIO } from '../dto/learning.constants';

export interface PlaybackHeartbeatInput {
  readonly lessonId: string;
  readonly positionSeconds: number;
  /** The lease this player believes it holds. Absent when the grant was issued without one (Redis outage). */
  readonly leaseId?: string;
}

export interface PlaybackHeartbeatResponse {
  readonly lessonId: string;
  readonly lastPositionSeconds: number;
  readonly watchedSeconds: number;
  readonly maxWatchedRatio: number;
  /** False when another device has taken over. The player pauses; nothing already recorded is lost. */
  readonly leaseHeld: boolean;
  /** Whether the watched-ratio rule is now satisfied, so the UI can offer completion without a second round-trip. */
  readonly completionEligible: boolean;
}

@Injectable()
export class PlaybackService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly courseProgressRepository: CourseProgressRepository,
    private readonly leaseService: LearningLeaseService,
  ) {}

  async recordHeartbeat(
    userId: string,
    courseId: string,
    input: PlaybackHeartbeatInput,
  ): Promise<PlaybackHeartbeatResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );

      const lesson = await tx.courseLesson.findFirst({
        where: { id: input.lessonId, courseId },
        select: { id: true, durationSeconds: true, completionRule: true, videoAsset: { select: { durationSeconds: true } } },
      });
      if (!lesson) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const progress = await this.courseProgressRepository.findLessonProgress(
        tx,
        enrollment.id,
        input.lessonId,
      );
      if (!progress) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const duration = lesson.durationSeconds ?? lesson.videoAsset?.durationSeconds ?? null;
      const now = new Date();
      const update = applyPlaybackHeartbeat(
        {
          lastPositionSeconds: progress.lastPositionSeconds,
          watchedSeconds: progress.watchedSeconds,
          maxWatchedRatio: Number(progress.maxWatchedRatio),
          lastActivityAt: progress.lastActivityAt,
        },
        { positionSeconds: input.positionSeconds, now },
        duration,
      );

      await this.courseProgressRepository.updateLessonProgress(tx, progress.id, {
        lastPositionSeconds: update.lastPositionSeconds,
        watchedSeconds: update.watchedSeconds,
        maxWatchedRatio: new PrismaNamespace.Decimal(update.maxWatchedRatio),
        lastActivityAt: update.lastActivityAt,
        // A lesson being watched is a lesson in progress. Never downgrade
        // a completed lesson back to `in_progress` — a learner revisiting
        // something they finished has not un-finished it.
        ...(progress.status === 'available' ? { status: 'in_progress' as const } : {}),
      });

      await this.accumulateTimeSpent(tx, enrollment.id, update.creditedSeconds, now);

      // The lease is renewed AFTER the evidence is written, so a player
      // that has just lost the lease still keeps the seconds it earned
      // before losing it.
      const leaseHeld = input.leaseId
        ? await this.leaseService.renew({
            userId,
            academyId: enrollment.academyId,
            leaseId: input.leaseId,
          })
        : true;

      return {
        lessonId: lesson.id,
        lastPositionSeconds: update.lastPositionSeconds,
        watchedSeconds: update.watchedSeconds,
        maxWatchedRatio: update.maxWatchedRatio,
        leaseHeld,
        completionEligible:
          lesson.completionRule === 'manual' ||
          update.maxWatchedRatio >= MINIMUM_WATCHED_RATIO,
      };
    });
  }

  /** Releases the lease when the learner deliberately leaves the player. Best-effort; expiry is the real guarantee. */
  async releaseLease(userId: string, courseId: string, leaseId: string): Promise<void> {
    await this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
        tx,
        userId,
        courseId,
      );
      if (!enrollment) return;
      await this.leaseService.release(userId, enrollment.academyId, leaseId);
    });
  }

  private async accumulateTimeSpent(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
    creditedSeconds: number,
    now: Date,
  ): Promise<void> {
    if (creditedSeconds <= 0) {
      // Still stamp activity: "when did this learner last touch this
      // course" is what the dashboard's Continue Learning ordering uses,
      // and a first heartbeat credits no seconds but IS activity.
      await this.courseProgressRepository.updateCourseProgress(tx, enrollmentId, {
        lastActivityAt: now,
      });
      return;
    }
    await tx.courseProgress.update({
      where: { enrollmentId },
      data: {
        timeSpentSeconds: { increment: creditedSeconds },
        lastActivityAt: now,
      },
    });
  }
}
