/**
 * B0-SUP-04 — retention for marketing enquiries (`platform_contact_submissions`).
 *
 * An enquiry older than CONTACT_ENQUIRY_RETENTION_MONTHS (24 unless set — a
 * PROPOSAL; counsel sets the real period) is DELETED, the same way an
 * operator's delete works: the row goes, and the copies its new-enquiry
 * notification made are blanked (`CommunicationService.forgetEntity`) in the
 * same transaction. One audit row per run records how many went (ids and
 * counts only, never a name, address or message).
 *
 * MODE. `FLAG_CONTACT_RETENTION_MODE`, re-read on every run: `off` does
 * nothing; `dry_run` (the default, like `FLAG_MEDIA_ARCHIVE_PURGE_MODE`)
 * counts and logs what WOULD be deleted and deletes nothing; `on` deletes,
 * at most PLATFORM_CONTACT_RETENTION_MAX_PER_RUN per run (the rest waits for
 * the next day's run). The period is bounded at boot (6–120 months), so a
 * typo cannot erase fresh enquiries.
 *
 * Runs in the first Platform Owner's context — the only context the table's
 * DELETE policy admits — exactly as `ArchivedMediaPurgeService` does.
 * Idempotent: a re-run finds nothing new.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LeadCaptureConfig } from '../../config/configuration';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { PlatformContactSubmissionsRepository } from '../repositories/platform-contact-submissions.repository';
import {
  PLATFORM_CONTACT_AUDIT_ACTIONS,
  PLATFORM_CONTACT_AUDIT_TARGET,
  PLATFORM_CONTACT_NOTIFICATION,
  PLATFORM_CONTACT_RETENTION_MAX_PER_RUN,
} from '../platform-contact.constants';

export interface PlatformContactRetentionResult {
  readonly mode: LeadCaptureConfig['contactRetentionMode'];
  readonly retentionMonths: number;
  readonly cutoff: string | null;
  /** Enquiries past the period (all of them in `dry_run`, this run's batch in `on`). */
  readonly eligible: number;
  readonly deleted: number;
}

/** `now` minus whole calendar months (UTC), clamped to the month's last day. */
export function retentionCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now.getTime());
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return cutoff;
}

@Injectable()
export class PlatformContactRetentionService {
  private readonly logger = new Logger(PlatformContactRetentionService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly repository: PlatformContactSubmissionsRepository,
    private readonly communicationService: CommunicationService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly configService: ConfigService,
  ) {}

  async run(now: Date = new Date()): Promise<PlatformContactRetentionResult> {
    const config = this.configService.getOrThrow<LeadCaptureConfig>('leadCapture');
    const mode = config.contactRetentionMode;
    const retentionMonths = config.contactRetentionMonths;
    if (mode === 'off') {
      return { mode, retentionMonths, cutoff: null, eligible: 0, deleted: 0 };
    }
    const actor = await this.usersRepository.findFirstPlatformOwnerId();
    if (!actor) {
      this.logger.error(
        'No platform owner exists; the enquiry retention run was skipped.',
      );
      return { mode, retentionMonths, cutoff: null, eligible: 0, deleted: 0 };
    }
    const cutoff = retentionCutoff(now, retentionMonths);

    if (mode === 'dry_run') {
      const eligible = await this.tenancyContextService.runInUserContext(actor.id, (tx) =>
        this.repository.countCreatedBefore(tx, cutoff),
      );
      if (eligible > 0) {
        this.logger.log(
          { mode, eligible, retentionMonths, cutoff: cutoff.toISOString() },
          'Enquiry retention (dry run): these marketing enquiries are past the retention period and would be deleted.',
        );
      }
      return {
        mode,
        retentionMonths,
        cutoff: cutoff.toISOString(),
        eligible,
        deleted: 0,
      };
    }

    const result = await this.tenancyContextService.runInUserContext(
      actor.id,
      async (tx) => {
        const ids = await this.repository.findIdsCreatedBefore(
          tx,
          cutoff,
          PLATFORM_CONTACT_RETENTION_MAX_PER_RUN,
        );
        if (ids.length === 0) return { eligible: 0, deleted: 0 };
        const deleted = await this.repository.deleteMany(tx, ids);
        for (const id of ids) {
          await this.communicationService.forgetEntity(
            tx,
            PLATFORM_CONTACT_NOTIFICATION.key,
            {
              type: PLATFORM_CONTACT_NOTIFICATION.entityType,
              id,
            },
          );
        }
        await this.auditLogWriterService.write(tx, {
          actorUserId: actor.id,
          role: 'platform_owner',
          action: PLATFORM_CONTACT_AUDIT_ACTIONS.retentionPurged,
          targetType: PLATFORM_CONTACT_AUDIT_TARGET,
          targetId: 'retention',
          context: { deletedCount: deleted, retentionMonths },
        });
        return { eligible: ids.length, deleted };
      },
    );
    if (result.deleted > 0) {
      this.logger.log(
        { mode, ...result, retentionMonths, cutoff: cutoff.toISOString() },
        'Enquiry retention: deleted marketing enquiries past the retention period.',
      );
    }
    return { mode, retentionMonths, cutoff: cutoff.toISOString(), ...result };
  }
}
