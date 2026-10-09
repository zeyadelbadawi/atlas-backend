/**
 * SecurityEventsService — the writer behind `security_events` (W3,
 * investigation §4.3): the Platform Owner's OTP & Security Monitoring record.
 *
 * NEVER BLOCKS AUTHENTICATION. Every call runs OUTSIDE the caller's auth
 * transaction, in its own statement, and swallows every failure (logged,
 * counted, never rethrown). A monitoring row that fails to land must never
 * be the reason a sign-in, a code check or a deletion fails — and a write
 * that rolled back with the auth transaction would lose exactly the failed
 * attempts this record exists to show.
 *
 * NEVER STORES A SECRET. The input type has no field a code, token,
 * password, raw email or raw IP could go into: callers hand over the email
 * and IP and receive keyed hashes (`SecurityEventHasher`); `reason` is a
 * closed vocabulary.
 *
 * WRITES WITHOUT A CONTEXT. Most events are pre-session (a challenge
 * reference authenticates nothing), so the INSERT runs on the application
 * role with no context variables, admitted by
 * `security_events_system_insert WITH CHECK (true)`. It uses a raw INSERT
 * without RETURNING because nobody but a Platform Owner may SELECT the
 * table — Prisma's `create` would read the row back and be refused.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { SecurityEventType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { SecurityEventHasher } from './security-event-hasher.service';

/** The closed vocabulary `security_events.reason` accepts. */
export type SecurityEventReason =
  | 'invalid_code'
  | 'context_mismatch'
  | 'expired'
  | 'dead_challenge'
  | 'attempts_exhausted'
  | 'account_budget'
  // ATO F7 — the address's account-wide failure ceiling (unknown browsers).
  | 'account_ceiling'
  | 'ip_budget'
  | 'resend_budget'
  | 'hourly_budget'
  | 'cooldown'
  | 'address_suppressed';

export interface SecurityEventInput {
  readonly type: SecurityEventType;
  readonly surface?: 'management' | 'academy' | null;
  /** Only when the account is known AND already proven (post-password, or a session). */
  readonly userId?: string | null;
  /** Hashed before storage; never persisted as given. */
  readonly email?: string | null;
  /** Hashed before storage; never persisted as given. */
  readonly ipAddress?: string | null;
  readonly academyId?: string | null;
  readonly challengeId?: string | null;
  readonly reason?: SecurityEventReason | null;
  readonly attemptsRemaining?: number | null;
}

/** Event types that are folded into one row per minute (flood protection). */
const BUCKETED_TYPES: ReadonlySet<SecurityEventType> = new Set<SecurityEventType>([
  'otp_rate_limited',
  'deletion_code_rate_limited',
  'signin_rate_limited',
]);

function surfaceOf(value: unknown): 'management' | 'academy' | null {
  return value === 'management' || value === 'academy' ? value : null;
}

@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: SecurityEventHasher,
  ) {}

  /** Records one event. Resolves in every case; never throws. */
  async record(input: SecurityEventInput): Promise<void> {
    try {
      const now = new Date();
      const subjectHash = this.hasher.subjectHash(input.email);
      const ipHash = this.hasher.ipHash(input.ipAddress, now);
      const surface = surfaceOf(input.surface);
      if (BUCKETED_TYPES.has(input.type)) {
        const minute = now.toISOString().slice(0, 16);
        const bucketKey = [input.type, ipHash ?? '-', subjectHash ?? '-', minute]
          .join('|')
          .slice(0, 200);
        await this.prisma.$executeRaw`
          SELECT record_security_event_bucket(
            ${randomUUID()}, CAST(${input.type} AS "security_event_type"), ${surface},
            ${subjectHash}, ${ipHash}, ${input.reason ?? null}, ${bucketKey}
          )
        `;
        return;
      }
      const attempts =
        typeof input.attemptsRemaining === 'number' &&
        Number.isFinite(input.attemptsRemaining)
          ? Math.max(0, Math.min(32767, Math.trunc(input.attemptsRemaining)))
          : null;
      await this.prisma.$executeRaw`
        INSERT INTO "security_events"
          ("id", "event_type", "surface", "user_id", "subject_hash", "ip_hash",
           "academy_id", "challenge_id", "reason", "attempts_remaining", "created_at")
        VALUES (
          ${randomUUID()}, CAST(${input.type} AS "security_event_type"), ${surface},
          ${input.userId ?? null}, ${subjectHash}, ${ipHash}, ${input.academyId ?? null},
          ${input.challengeId ?? null}, ${input.reason ?? null}, ${attempts}, ${now}
        )
      `;
    } catch (error) {
      // The type and the error only — never the input, which carries an
      // email and an IP before hashing.
      this.logger.warn(
        {
          type: input.type,
          error: error instanceof Error ? error.message : String(error),
        },
        'Security event could not be recorded; authentication continues.',
      );
    }
  }
}
