/**
 * The work behind the W3 security-maintenance sweep — retention for:
 *
 *   - `auth_email_challenges` (24 h). The table had a 24-hour
 *     `auth_email_challenges_retention_delete` policy since the C4
 *     foundation but NO job ever ran it, so every challenge — with the raw
 *     client `ip_address` of the sign-in — accumulated forever.
 *   - `account_deletion_challenges` (24 h, policy added by
 *     `20261104000010_w3_email_activity_index_challenge_retention`).
 *   - `security_events` (90 days).
 *
 * Every DELETE runs in a PLATFORM OWNER's user context — the
 * `Phase2MaintenanceService.pruneAccessLog` precedent — and is bounded
 * independently by the table's own retention DELETE policy, so even a wrong
 * cutoff could not reach a live row. The two challenge tables have NO
 * platform SELECT policy (a live login code's HMAC is nobody else's
 * business), so their DELETE is UNQUALIFIED: PostgreSQL applies SELECT
 * policies to a DELETE only when it has a WHERE clause, and the retention
 * policy alone then decides which rows are old enough — exactly how the
 * communications prune deletes `notifications`.
 *
 * Never throws out of the processor: each table is pruned in its own
 * transaction and a failure is logged and retried by the next run.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { SECURITY_EVENTS_RETENTION_DAYS } from '../queue/security-maintenance.types';

export interface SecurityMaintenanceResult {
  readonly authEmailChallenges: number;
  readonly accountDeletionChallenges: number;
  readonly securityEvents: number;
}

@Injectable()
export class SecurityMaintenanceService {
  private readonly logger = new Logger(SecurityMaintenanceService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
  ) {}

  async run(): Promise<SecurityMaintenanceResult> {
    const owner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!owner) {
      this.logger.warn(
        'No platform owner account exists yet — security retention skipped.',
      );
      return { authEmailChallenges: 0, accountDeletionChallenges: 0, securityEvents: 0 };
    }
    const cutoff = new Date(
      Date.now() - SECURITY_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    return {
      authEmailChallenges: await this.prune(
        owner.id,
        'auth_email_challenges',
        (tx) => tx.$executeRaw`DELETE FROM "auth_email_challenges"`,
      ),
      accountDeletionChallenges: await this.prune(
        owner.id,
        'account_deletion_challenges',
        (tx) => tx.$executeRaw`DELETE FROM "account_deletion_challenges"`,
      ),
      securityEvents: await this.prune(
        owner.id,
        'security_events',
        (tx) =>
          tx.$executeRaw`DELETE FROM "security_events" WHERE "created_at" < ${cutoff}`,
      ),
    };
  }

  private async prune(
    platformOwnerId: string,
    table: string,
    statement: (tx: Prisma.TransactionClient) => Promise<number>,
  ): Promise<number> {
    try {
      const deleted = await this.tenancyContextService.runInUserContext(
        platformOwnerId,
        statement,
      );
      if (deleted > 0) {
        this.logger.log({ table, deleted }, 'Pruned rows past their retention window.');
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        { table, error: error instanceof Error ? error.message : String(error) },
        'Security retention prune failed; the next run will retry.',
      );
      return 0;
    }
  }
}
