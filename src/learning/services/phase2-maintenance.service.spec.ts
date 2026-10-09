/**
 * Phase2MaintenanceService — mocked unit tests for the retention half of
 * the sweep (P64 Phase 2 §F, Phase 4 §D.5).
 *
 * Deliberately mocked, not run against the database: what this file proves
 * is the CONTROL FLOW around the two prunes — the cutoff each one derives
 * from its retention constant, that both run in a platform owner's user
 * context (never a tenant one, never context-free), that a missing owner
 * skips them safely, that a failure in one neither throws out of `run()`
 * nor stops the other, and
 * that the retention metrics describe exactly what happened. Whether the
 * DELETE actually removes the right rows under RLS is a database property
 * and is covered by `test/p64-phase4-observability.e2e-spec.ts`.
 */
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Phase2MaintenanceService } from './phase2-maintenance.service';
import { ConfigService } from '@nestjs/config';
import { ForensicWatermarkService } from '../../forensic-watermark/services/forensic-watermark.service';

const WATERMARK_RETENTION_DAYS = 730;
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { ContentAccessLogRepository } from '../repositories/content-access-log.repository';
import { QuizAttemptsRepository } from '../repositories/quiz-attempts.repository';
import { VideoReconciliationService } from '../../media/services/video-reconciliation.service';
import { QuizAttemptEngineService } from './quiz-attempt-engine.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import {
  CONTENT_ACCESS_LOG_RETENTION_DAYS,
  QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS,
} from '../queue/phase2-maintenance.types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed "now" so the cutoffs are exact numbers rather than "roughly 90 days ago". */
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
/** Stands in for the transaction client `runInUserContext` would open. */
const TX = { sentinel: 'tx' };

const PLATFORM_OWNER_ID = 'platform-owner-1';

describe('Phase2MaintenanceService — retention sweep', () => {
  let service: Phase2MaintenanceService;
  let runInUserContext: jest.Mock;
  let runWithoutContext: jest.Mock;
  let usersRepository: { findFirstPlatformOwnerId: jest.Mock };
  let accessLog: { pruneOlderThan: jest.Mock };
  let quizAttempts: { pruneEventsOlderThan: jest.Mock };
  let reconciliation: { pollStalled: jest.Mock };
  let quizEngine: { finalizeOverdue: jest.Mock };
  let metrics: { recordRetentionPruned: jest.Mock; recordRetentionSweepRun: jest.Mock };
  let forensicWatermarks: { pruneOlderThan: jest.Mock };
  let nowSpy: jest.SpyInstance;
  const silenced: jest.SpyInstance[] = [];

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      silenced.push(
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
    }
  });

  afterAll(() => {
    for (const spy of silenced) spy.mockRestore();
  });

  beforeEach(async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    // Real `runInUserContext` opens a transaction and sets
    // `app.current_user_id`; here the callback is invoked directly with a
    // placeholder `tx` and the id it was asked for is recorded.
    runInUserContext = jest.fn(
      (_userId: string, work: (tx: unknown) => Promise<unknown>) => work(TX),
    );
    runWithoutContext = jest.fn((work: (tx: unknown) => Promise<unknown>) => work(TX));
    usersRepository = {
      findFirstPlatformOwnerId: jest.fn().mockResolvedValue({ id: PLATFORM_OWNER_ID }),
    };
    accessLog = { pruneOlderThan: jest.fn().mockResolvedValue(3) };
    quizAttempts = { pruneEventsOlderThan: jest.fn().mockResolvedValue(5) };
    reconciliation = { pollStalled: jest.fn().mockResolvedValue(0) };
    quizEngine = { finalizeOverdue: jest.fn().mockResolvedValue(0) };
    metrics = { recordRetentionPruned: jest.fn(), recordRetentionSweepRun: jest.fn() };
    forensicWatermarks = { pruneOlderThan: jest.fn().mockResolvedValue(7) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        Phase2MaintenanceService,
        {
          provide: TenancyContextService,
          useValue: { runInUserContext, runWithoutContext },
        },
        { provide: UsersRepository, useValue: usersRepository },
        { provide: ContentAccessLogRepository, useValue: accessLog },
        { provide: QuizAttemptsRepository, useValue: quizAttempts },
        { provide: VideoReconciliationService, useValue: reconciliation },
        { provide: QuizAttemptEngineService, useValue: quizEngine },
        { provide: LearningMetricsService, useValue: metrics },
        { provide: ForensicWatermarkService, useValue: forensicWatermarks },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => ({ retentionDays: WATERMARK_RETENTION_DAYS }) },
        },
      ],
    }).compile();
    service = moduleRef.get(Phase2MaintenanceService);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('prunes content_access_log at now minus the 90-day window, in the platform owner user context', async () => {
    await service.run();
    expect(CONTENT_ACCESS_LOG_RETENTION_DAYS).toBe(90);
    expect(accessLog.pruneOlderThan).toHaveBeenCalledTimes(1);
    const [tx, cutoff] = accessLog.pruneOlderThan.mock.calls[0] as [unknown, Date];
    expect(tx).toBe(TX);
    expect(cutoff.getTime()).toBe(NOW - CONTENT_ACCESS_LOG_RETENTION_DAYS * DAY_MS);
    expect(runInUserContext.mock.calls[0][0]).toBe(PLATFORM_OWNER_ID);
  });

  it('prunes quiz_attempt_events at now minus the 180-day window, in the platform owner user context', async () => {
    await service.run();
    expect(QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS).toBe(180);
    expect(quizAttempts.pruneEventsOlderThan).toHaveBeenCalledTimes(1);
    const [tx, cutoff] = quizAttempts.pruneEventsOlderThan.mock.calls[0] as [
      unknown,
      Date,
    ];
    expect(tx).toBe(TX);
    expect(cutoff.getTime()).toBe(NOW - QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS * DAY_MS);
    // Both prunes went through the platform owner's user context (row
    // visibility; the DELETE policies still bound what is deleted) —
    // never the context-free transaction, which RLS turns into a no-op.
    expect(runInUserContext).toHaveBeenCalledTimes(3);
    expect(runInUserContext.mock.calls[2][0]).toBe(PLATFORM_OWNER_ID);
    expect(runWithoutContext).not.toHaveBeenCalled();
    // Never a tenant context: retention is platform-wide.
    expect(usersRepository.findFirstPlatformOwnerId).toHaveBeenCalledTimes(3);
  });

  it('with no platform owner account both prunes are skipped: 0 rows, an error run per table, no delete attempted, nothing thrown', async () => {
    usersRepository.findFirstPlatformOwnerId.mockResolvedValue(null);
    const result = await service.run();
    expect(result.prunedAccessLogRows).toBe(0);
    expect(result.prunedQuizAttemptEventRows).toBe(0);
    expect(result.prunedWatermarkRows).toBe(0);
    expect(forensicWatermarks.pruneOlderThan).not.toHaveBeenCalled();
    expect(runInUserContext).not.toHaveBeenCalled();
    expect(accessLog.pruneOlderThan).not.toHaveBeenCalled();
    expect(quizAttempts.pruneEventsOlderThan).not.toHaveBeenCalled();
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'content_access_log',
      false,
    );
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'quiz_attempt_events',
      false,
    );
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'forensic_watermarks',
      false,
    );
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledTimes(3);
    expect(metrics.recordRetentionPruned).not.toHaveBeenCalled();
    // The other duties are unaffected.
    expect(reconciliation.pollStalled).toHaveBeenCalledTimes(1);
    expect(quizEngine.finalizeOverdue).toHaveBeenCalledTimes(1);
  });

  it('reports both pruned counts in the result and records ok runs with their row counts', async () => {
    const result = await service.run();
    expect(result).toEqual({
      prunedAccessLogRows: 3,
      prunedWatermarkRows: 7,
      prunedQuizAttemptEventRows: 5,
      reconciledVideos: 0,
      finalizedOverdueQuizAttempts: 0,
    });
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'content_access_log',
      true,
    );
    expect(metrics.recordRetentionPruned).toHaveBeenCalledWith('content_access_log', 3);
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'quiz_attempt_events',
      true,
    );
    expect(metrics.recordRetentionPruned).toHaveBeenCalledWith('quiz_attempt_events', 5);
    expect(metrics.recordRetentionPruned).toHaveBeenCalledWith('forensic_watermarks', 7);
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledTimes(3);
    expect(metrics.recordRetentionPruned).toHaveBeenCalledTimes(3);
  });

  it('a failing quiz-event prune never throws out of run(), counts as an error run, and leaves the other duties intact', async () => {
    quizAttempts.pruneEventsOlderThan.mockRejectedValue(new Error('deadlock detected'));
    const result = await service.run();
    expect(result.prunedQuizAttemptEventRows).toBe(0);
    expect(result.prunedAccessLogRows).toBe(3);
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'quiz_attempt_events',
      false,
    );
    expect(metrics.recordRetentionPruned).not.toHaveBeenCalledWith(
      'quiz_attempt_events',
      expect.anything(),
    );
    // The other three duties still ran.
    expect(accessLog.pruneOlderThan).toHaveBeenCalledTimes(1);
    expect(reconciliation.pollStalled).toHaveBeenCalledTimes(1);
    expect(quizEngine.finalizeOverdue).toHaveBeenCalledTimes(1);
  });

  it('a failing access-log prune is likewise contained and does not stop the quiz-event prune', async () => {
    accessLog.pruneOlderThan.mockRejectedValue(new Error('connection reset'));
    const result = await service.run();
    expect(result.prunedAccessLogRows).toBe(0);
    expect(result.prunedQuizAttemptEventRows).toBe(5);
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'content_access_log',
      false,
    );
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'quiz_attempt_events',
      true,
    );
    expect(metrics.recordRetentionPruned).toHaveBeenCalledTimes(2);
    expect(metrics.recordRetentionPruned).toHaveBeenCalledWith('quiz_attempt_events', 5);
  });

  it('prunes forensic watermarks last shown before the configured window, as the platform owner', async () => {
    await service.run();
    expect(forensicWatermarks.pruneOlderThan).toHaveBeenCalledTimes(1);
    const [tx, cutoff] = forensicWatermarks.pruneOlderThan.mock.calls[0] as [
      unknown,
      Date,
    ];
    expect(tx).toBe(TX);
    expect(cutoff.getTime()).toBe(NOW - WATERMARK_RETENTION_DAYS * DAY_MS);
  });

  it('a failing watermark prune is contained and counted as an error run', async () => {
    forensicWatermarks.pruneOlderThan.mockRejectedValue(new Error('boom'));
    const result = await service.run();
    expect(result.prunedWatermarkRows).toBe(0);
    expect(result.prunedAccessLogRows).toBe(3);
    expect(metrics.recordRetentionSweepRun).toHaveBeenCalledWith(
      'forensic_watermarks',
      false,
    );
  });
});
