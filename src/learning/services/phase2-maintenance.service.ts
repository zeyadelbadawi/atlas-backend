/**
 * The work behind the P64 Phase 2 maintenance sweep.
 *
 * Two independent duties, run together because they share a cadence and
 * because a second scheduler is explicitly ruled out by
 * `SubscriptionSweepScheduler`'s own reasoning:
 *
 *   - **Retention (§F).** `content_access_log` keeps 90 days. Long enough
 *     to investigate a sharing report, short enough that the table is not
 *     a permanent record of what every learner read.
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
import { ContentAccessLogRepository } from '../repositories/content-access-log.repository';
import { VideoReconciliationService } from '../../media/services/video-reconciliation.service';
import { CONTENT_ACCESS_LOG_RETENTION_DAYS } from '../queue/phase2-maintenance.types';

export interface Phase2MaintenanceResult {
  readonly prunedAccessLogRows: number;
  readonly reconciledVideos: number;
}

@Injectable()
export class Phase2MaintenanceService {
  private readonly logger = new Logger(Phase2MaintenanceService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly accessLog: ContentAccessLogRepository,
    private readonly reconciliation: VideoReconciliationService,
  ) {}

  async run(): Promise<Phase2MaintenanceResult> {
    return {
      prunedAccessLogRows: await this.pruneAccessLog(),
      reconciledVideos: await this.pollStalledVideos(),
    };
  }

  /**
   * Runs with NO tenant context: retention is platform-wide, and the
   * DELETE policy independently refuses anything inside the 90-day window
   * — so even called with a wrong cutoff this cannot erase yesterday's
   * evidence.
   */
  private async pruneAccessLog(): Promise<number> {
    const cutoff = new Date(
      Date.now() - CONTENT_ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      const deleted = await this.tenancyContextService.runWithoutContext((tx) =>
        this.accessLog.pruneOlderThan(tx, cutoff),
      );
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
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Content-access log retention sweep failed; the next run will retry.',
      );
      return 0;
    }
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
