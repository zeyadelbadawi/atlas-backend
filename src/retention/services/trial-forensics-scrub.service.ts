/**
 * W8B — trial-ledger forensic retention.
 *
 * `trial_redemptions.ip_address` / `user_agent` are personal data recorded
 * only as abuse signals (the eligibility decision never reads them). After
 * TRIAL_FORENSICS_RETENTION_DAYS they are cleared. The subject hash and the
 * dates stay — they ARE the one-trial rule.
 *
 * The application role has no UPDATE on the append-only ledger, so this goes
 * through the narrow SECURITY DEFINER `scrub_trial_redemption_forensics`
 * (migration 20261104000630), which can only null those two columns on rows
 * older than the window and refuses windows under 30 days.
 *
 * Rides the `video-retention` queue's ONE processor as its own job name
 * (see `video-retention.types.ts`), once a day. Idempotent: a re-run clears
 * nothing new.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TRIAL_FORENSICS_RETENTION_DAYS } from '../queue/video-retention.types';

@Injectable()
export class TrialForensicsScrubService {
  private readonly logger = new Logger(TrialForensicsScrubService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Returns how many ledger rows had their IP/user agent cleared. */
  async run(retentionDays: number = TRIAL_FORENSICS_RETENTION_DAYS): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ scrubbed: number }[]>`
      SELECT scrub_trial_redemption_forensics(${retentionDays}::integer) AS scrubbed
    `;
    const scrubbed = Number(rows[0]?.scrubbed ?? 0);
    if (scrubbed > 0) {
      this.logger.log(
        { scrubbed, retentionDays },
        'Cleared IP address and user agent on aged trial-redemption rows.',
      );
    }
    return scrubbed;
  }
}
