/**
 * The work behind the P64 Phase 2 maintenance sweep.
 *
 * Two independent duties, run together because they share a cadence and
 * because a second scheduler is explicitly ruled out by
 * `SubscriptionSweepScheduler`'s own reasoning:
 *
 *   - **Retention (§F, Phase 4 §D.5).** `content_access_log` keeps 90
 *     days. Long enough to investigate a sharing report, short enough that
 *     the table is not a permanent record of what every learner read.
 *     `quiz_attempt_events` keeps 180, for the same reason on an
 *     integrity dispute's longer timescale. Both deletes run in a platform
 *     owner's user context — see `pruneAccessLog` for why "no context"
 *     silently deleted nothing.
 *   - **Status poll (§D.4).** Asks each provider about uploads that have
 *     been waiting too long. It is the only way to recover from a webhook
 *     that was never delivered: the provider will not resend it, and
 *     without this the asset stays `processing` forever while its
 *     reservation keeps consuming the tenant's quota.
 *
 * Neither duty may throw out of the processor. A failed sweep is
 * recoverable by the next one ten minutes later; an unhandled rejection
 * is not.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { ContentAccessLogRepository } from '../repositories/content-access-log.repository';
import { QuizAttemptsRepository } from '../repositories/quiz-attempts.repository';
import { VideoReconciliationService } from '../../media/services/video-reconciliation.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import {
  CONTENT_ACCESS_LOG_RETENTION_DAYS,
  QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS,
} from '../queue/phase2-maintenance.types';
import { QuizAttemptEngineService } from './quiz-attempt-engine.service';

export interface Phase2MaintenanceResult {
  readonly prunedAccessLogRows: number;
  /** P64 Phase 4 (§D.5) — `quiz_attempt_events` rows past the 180-day window. */
  readonly prunedQuizAttemptEventRows: number;
  readonly reconciledVideos: number;
  /**
   * P64 Phase 3 (AD-8) — timed attempts past `deadline + grace` that the
   * delayed job did not finalise, finalised by this sweep instead.
   */
  readonly finalizedOverdueQuizAttempts: number;
}

@Injectable()
export class Phase2MaintenanceService {
  private readonly logger = new Logger(Phase2MaintenanceService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly accessLog: ContentAccessLogRepository,
    private readonly quizAttempts: QuizAttemptsRepository,
    private readonly reconciliation: VideoReconciliationService,
    private readonly quizEngine: QuizAttemptEngineService,
    private readonly metrics: LearningMetricsService,
  ) {}

  async run(): Promise<Phase2MaintenanceResult> {
    return {
      prunedAccessLogRows: await this.pruneAccessLog(),
      prunedQuizAttemptEventRows: await this.pruneQuizAttemptEvents(),
      reconciledVideos: await this.pollStalledVideos(),
      finalizedOverdueQuizAttempts: await this.finalizeOverdueQuizAttempts(),
    };
  }

  /**
   * P64 Phase 3 (AD-8) — the auto-submit safety net the master plan
   * promises ("auto-submit by job and by sweep"). The delayed
   * `quiz-deadlines` job is the fast path; this sweep bounds the damage
   * when that job is lost, never scheduled, or never fires — which is
   * exactly what the 22 Sep 2026 production validation observed: the
   * engine's `finalizeOverdue` existed but nothing ever called it, so an
   * abandoned attempt stayed `in_progress` until its learner next read it.
   * The learner-facing outcome was already correct (every read, save and
   * submit finalises lazily); what was missing was the finalisation
   * happening at all for attempts nobody comes back to — the reviewer's
   * attempt list, completion, and the auto-submit metric all waited on it.
   */
  private async finalizeOverdueQuizAttempts(): Promise<number> {
    try {
      const finalized = await this.quizEngine.finalizeOverdue();
      if (finalized > 0) {
        this.logger.warn(
          { finalized },
          'Finalised overdue quiz attempts by sweep; their delayed deadline jobs did not fire.',
        );
      }
      return finalized;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Overdue quiz attempt sweep failed; the next run will retry.',
      );
      return 0;
    }
  }

  /**
   * Retention is platform-wide (no tenant context) and runs in a PLATFORM
   * OWNER's user context — the same `findFirstPlatformOwnerId` shape
   * `SubscriptionSweepService`/`SubscriptionExpiryService` use.
   *
   * WHY A USER CONTEXT AT ALL. PostgreSQL applies the table's SELECT
   * policies on top of its DELETE policy whenever the DELETE carries a
   * WHERE clause, and with no context every `content_access_log` SELECT
   * policy evaluates to false — so the Phase 2 sweep deleted nothing,
   * silently, ever (verified 23 Sep 2026: 0 rows with no context, the same
   * DELETE succeeds as a platform owner). The owner context satisfies row
   * VISIBILITY only (`content_access_log_platform_select`); what may be
   * deleted is still bounded independently by
   * `content_access_log_retention_delete` (`created_at < now() - 90
   * days`), so even called with a wrong cutoff this cannot erase
   * yesterday's evidence.
   */
  private async pruneAccessLog(): Promise<number> {
    const cutoff = new Date(
      Date.now() - CONTENT_ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      const platformOwnerId = await this.resolvePlatformOwnerId('content_access_log');
      if (!platformOwnerId) return 0;
      const deleted = await this.tenancyContextService.runInUserContext(
        platformOwnerId,
        (tx) => this.accessLog.pruneOlderThan(tx, cutoff),
      );
      this.metrics.recordRetentionSweepRun('content_access_log', true);
      this.metrics.recordRetentionPruned('content_access_log', deleted);
      if (deleted > 0) {
        this.logger.log(
          {
            deleted,
            cutoff: cutoff.toISOString(),
            retentionDays: CONTENT_ACCESS_LOG_RETENTION_DAYS,
          },
          'Pruned content-access log rows past the retention window.',
        );
      }
      return deleted;
    } catch (error) {
      this.metrics.recordRetentionSweepRun('content_access_log', false);
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Content-access log retention sweep failed; the next run will retry.',
      );
      return 0;
    }
  }

  /**
   * P64 Phase 4 (§D.5) — the `quiz_attempt_events` half of retention,
   * shaped exactly like `pruneAccessLog`: platform-wide, in a platform
   * owner's user context for row visibility only
   * (`quiz_attempt_events_platform_select`), and independently bounded by
   * the `quiz_attempt_events_retention_delete` policy (`server_at < now()
   * - 180 days`) — the policy still refuses any in-window row, so a wrong
   * cutoff here can never reach a live attempt's integrity trail.
   */
  private async pruneQuizAttemptEvents(): Promise<number> {
    const cutoff = new Date(
      Date.now() - QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      const platformOwnerId = await this.resolvePlatformOwnerId('quiz_attempt_events');
      if (!platformOwnerId) return 0;
      const deleted = await this.tenancyContextService.runInUserContext(
        platformOwnerId,
        (tx) => this.quizAttempts.pruneEventsOlderThan(tx, cutoff),
      );
      this.metrics.recordRetentionSweepRun('quiz_attempt_events', true);
      this.metrics.recordRetentionPruned('quiz_attempt_events', deleted);
      if (deleted > 0) {
        this.logger.log(
          {
            deleted,
            cutoff: cutoff.toISOString(),
            retentionDays: QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS,
          },
          'Pruned quiz attempt event rows past the retention window.',
        );
      }
      return deleted;
    } catch (error) {
      this.metrics.recordRetentionSweepRun('quiz_attempt_events', false);
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Quiz attempt event retention sweep failed; the next run will retry.',
      );
      return 0;
    }
  }

  /**
   * The platform owner whose context the retention deletes run in. A
   * platform with no owner account yet has nothing to retain either, so
   * the prune is skipped with a warning and counted as an `error` run —
   * never thrown.
   */
  private async resolvePlatformOwnerId(
    table: 'content_access_log' | 'quiz_attempt_events',
  ): Promise<string | null> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (platformOwner) return platformOwner.id;
    this.metrics.recordRetentionSweepRun(table, false);
    this.logger.warn(
      { table },
      'No platform owner account exists yet — skipping the retention sweep for this table.',
    );
    return null;
  }

  private async pollStalledVideos(): Promise<number> {
    try {
      const reconciled = await this.reconciliation.pollStalled();
      if (reconciled > 0) {
        this.logger.log(
          { reconciled },
          'Reconciled stalled video uploads by status poll.',
        );
      }
      return reconciled;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Stalled-video status poll failed; the next run will retry.',
      );
      return 0;
    }
  }
}
