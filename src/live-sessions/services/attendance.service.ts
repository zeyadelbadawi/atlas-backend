/**
 * AttendanceService — interval-based attendance, and the arithmetic the
 * UI reports.
 *
 * ATTENDANCE IS NOT A BOOLEAN. A student who joins at 09:01, drops at
 * 09:03, rejoins 09:07–09:09 and again 09:12–09:17 attended three times
 * for eleven minutes, and that is a materially different fact from
 * "attended: true". Every interval is its own row; totals are derived, not
 * stored, so a late correction from the provider cannot leave a stale
 * aggregate behind.
 *
 * IDENTITY IS EXACT OR IT IS NOTHING. Every interval hangs off a
 * `live_session_participants` row, which Atlas minted at join time with an
 * opaque `participant_key` handed to the provider. Reconciliation matches
 * on that key. There is deliberately NO fallback to display name or email
 * similarity: two students called "Ahmed", a participant who renames
 * themselves mid-meeting, or a shared family address would each silently
 * corrupt the record. An event that cannot be matched exactly is recorded
 * as unmatched and surfaced, never guessed.
 *
 * THREE SOURCES, RANKED. `provider_report` (post-session, authoritative)
 * supersedes `provider_webhook` (live, fast, occasionally lost or
 * reordered), which supersedes `sdk_event` (a browser, which stops talking
 * when a laptop lid closes). `manual` is an explicit human override and is
 * always visibly marked as such in the UI.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { ProviderParticipantInterval } from '../providers/live-provider.interface';

/**
 * The default attendance policy.
 *
 * Atlas had no attendance-policy architecture before this feature, so this
 * establishes one rather than scattering magic numbers: a participant
 * counts as ATTENDED when they were present for at least
 * `minimumPercent` of the session's SCHEDULED duration AND at least
 * `minimumMinutes` in absolute terms.
 *
 * Both conditions exist because either alone misbehaves at the extremes: a
 * percentage alone would mark 3 minutes of a 5-minute session as full
 * attendance, and an absolute minimum alone would fail every short
 * session. Deterministic, and expressed once so a future per-academy
 * setting has a single place to override.
 */
export const DEFAULT_ATTENDANCE_POLICY = Object.freeze({
  minimumPercent: 60,
  minimumMinutes: 5,
});

export type AttendanceStatus = 'attended' | 'partial' | 'absent';

export interface AttendanceInterval {
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
  readonly source: string;
}

export interface ParticipantAttendance {
  readonly userId: string;
  readonly participantId: string;
  readonly name: string;
  readonly email: string;
  readonly intervals: readonly AttendanceInterval[];
  readonly joinCount: number;
  readonly totalSeconds: number;
  readonly firstJoinedAt: Date | null;
  readonly lastLeftAt: Date | null;
  /** Of the session's SCHEDULED duration, capped at 100. */
  readonly attendancePercent: number;
  readonly status: AttendanceStatus;
}

/**
 * Total seconds actually present, with OVERLAPPING intervals merged.
 *
 * Merging matters: a participant joining from a phone and a laptop
 * produces two concurrent intervals, and naively summing them would report
 * 90 minutes of attendance in a 45-minute session. Presence is a union of
 * time ranges, not a sum of durations.
 */
export function totalAttendedSeconds(
  intervals: readonly { joinedAt: Date; leftAt: Date | null }[],
  fallbackEnd: Date,
): number {
  const ranges = intervals
    .map((i) => ({
      start: i.joinedAt.getTime(),
      // An interval still open is measured to the session's end rather
      // than to "now", so a finished session's numbers stop moving.
      end: (i.leftAt ?? fallbackEnd).getTime(),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let cursorStart: number | null = null;
  let cursorEnd = 0;

  for (const range of ranges) {
    if (cursorStart === null) {
      cursorStart = range.start;
      cursorEnd = range.end;
      continue;
    }
    if (range.start <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, range.end);
    } else {
      total += cursorEnd - cursorStart;
      cursorStart = range.start;
      cursorEnd = range.end;
    }
  }
  if (cursorStart !== null) total += cursorEnd - cursorStart;

  return Math.round(total / 1000);
}

export function classifyAttendance(
  totalSeconds: number,
  scheduledSeconds: number,
  policy = DEFAULT_ATTENDANCE_POLICY,
): { percent: number; status: AttendanceStatus } {
  const percent =
    scheduledSeconds > 0
      ? Math.min(100, Math.round((totalSeconds / scheduledSeconds) * 100))
      : 0;

  if (totalSeconds <= 0) return { percent, status: 'absent' };

  const meetsPercent = percent >= policy.minimumPercent;
  const meetsMinutes = totalSeconds >= policy.minimumMinutes * 60;

  // BOTH conditions, deliberately — see the policy's own doc comment.
  if (meetsPercent && meetsMinutes) return { percent, status: 'attended' };
  return { percent, status: 'partial' };
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  /**
   * Records one live join/leave from a provider webhook.
   *
   * `eventKey` is a deterministic digest of the event's identifying parts,
   * stored UNIQUE — so a redelivered or replayed webhook cannot create a
   * second identical interval. Idempotency lives in the database, not in a
   * "have I seen this?" check that races with itself.
   *
   * @returns whether a new interval was recorded.
   */
  async recordWebhookInterval(
    tx: Prisma.TransactionClient,
    args: {
      readonly liveSessionId: string;
      readonly participantKey: string;
      readonly joinedAt: Date;
      readonly leftAt?: Date;
      readonly providerParticipantId?: string;
      readonly providerEventId: string;
    },
  ): Promise<boolean> {
    // EXACT MATCH ONLY. An unknown key means the provider reported someone
    // Atlas never authorized — which is a signal worth surfacing, not a
    // reason to start guessing at names.
    const participant = await tx.liveSessionParticipant.findUnique({
      where: { participantKey: args.participantKey },
      select: { id: true, liveSessionId: true, academyId: true },
    });

    if (!participant || participant.liveSessionId !== args.liveSessionId) {
      this.logger.warn(
        { liveSessionId: args.liveSessionId },
        'Attendance event could not be matched to an authorized participant — ignored.',
      );
      return false;
    }

    if (args.providerParticipantId) {
      // Recorded for reconciliation only; never promoted to identity.
      await tx.liveSessionParticipant.update({
        where: { id: participant.id },
        data: { providerParticipantId: args.providerParticipantId },
      });
    }

    const eventKey = createHash('sha256')
      .update(
        [
          args.providerEventId,
          args.participantKey,
          args.joinedAt.toISOString(),
          args.leftAt?.toISOString() ?? 'open',
        ].join('|'),
      )
      .digest('hex');

    // ON CONFLICT DO NOTHING, for the same reason `TrialEligibilityService`
    // uses it: a raised unique violation would poison the caller's whole
    // transaction in Postgres, and no application catch could rescue it.
    const inserted = await tx.liveSessionAttendanceInterval.createMany({
      data: [
        {
          liveSessionId: args.liveSessionId,
          participantId: participant.id,
          academyId: participant.academyId,
          joinedAt: args.joinedAt,
          leftAt: args.leftAt ?? null,
          source: 'provider_webhook',
          eventKey,
        },
      ],
      skipDuplicates: true,
    });

    return inserted.count === 1;
  }

  /**
   * Replaces webhook-derived intervals with the provider's post-session
   * report.
   *
   * WHY REPLACE RATHER THAN MERGE. The report is the provider's own final
   * tally; merging it with the live stream would double-count every
   * interval that appears in both. Only `provider_webhook` and `sdk_event`
   * rows are cleared — a `manual` override is a human decision and
   * survives reconciliation untouched.
   */
  async reconcileFromProviderReport(
    tx: Prisma.TransactionClient,
    args: {
      readonly liveSessionId: string;
      readonly intervals: readonly ProviderParticipantInterval[];
    },
  ): Promise<{ recorded: number; unmatched: number }> {
    const participants = await tx.liveSessionParticipant.findMany({
      where: { liveSessionId: args.liveSessionId },
      select: { id: true, participantKey: true, academyId: true },
    });
    const byKey = new Map(participants.map((p) => [p.participantKey, p]));

    await tx.liveSessionAttendanceInterval.deleteMany({
      where: {
        liveSessionId: args.liveSessionId,
        source: { in: ['provider_webhook', 'sdk_event'] },
      },
    });

    let recorded = 0;
    let unmatched = 0;

    for (const interval of args.intervals) {
      const participant = interval.participantKey
        ? byKey.get(interval.participantKey)
        : undefined;

      if (!participant) {
        // Counted and reported, never approximated onto a nearby name.
        unmatched += 1;
        continue;
      }

      await tx.liveSessionAttendanceInterval.create({
        data: {
          liveSessionId: args.liveSessionId,
          participantId: participant.id,
          academyId: participant.academyId,
          joinedAt: interval.joinedAt,
          leftAt: interval.leftAt ?? null,
          source: 'provider_report',
        },
      });
      recorded += 1;
    }

    if (unmatched > 0) {
      this.logger.warn(
        { liveSessionId: args.liveSessionId, unmatched },
        'Provider report contained participants Atlas never authorized.',
      );
    }

    return { recorded, unmatched };
  }

  /**
   * The session's attendance, ready for the management table.
   *
   * Every number here is derived from the intervals at read time, so a
   * later reconciliation is reflected immediately with no aggregate to
   * invalidate.
   */
  async getSessionAttendance(
    tx: Prisma.TransactionClient,
    liveSessionId: string,
  ): Promise<readonly ParticipantAttendance[]> {
    const session = await tx.liveSession.findUniqueOrThrow({
      where: { id: liveSessionId },
      select: { scheduledStartAt: true, scheduledEndAt: true, endedAt: true },
    });

    const scheduledSeconds = Math.max(
      0,
      Math.round(
        (session.scheduledEndAt.getTime() - session.scheduledStartAt.getTime()) / 1000,
      ),
    );
    const fallbackEnd = session.endedAt ?? session.scheduledEndAt;

    const participants = await tx.liveSessionParticipant.findMany({
      where: { liveSessionId },
      select: {
        id: true,
        userId: true,
        user: { select: { name: true, email: true } },
        attendance: {
          select: { joinedAt: true, leftAt: true, source: true },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });

    return participants.map((participant) => {
      const intervals = participant.attendance;
      const totalSeconds = totalAttendedSeconds(intervals, fallbackEnd);
      const { percent, status } = classifyAttendance(totalSeconds, scheduledSeconds);

      const leaveTimes = intervals
        .map((i) => i.leftAt)
        .filter((d): d is Date => d !== null);

      return {
        userId: participant.userId,
        participantId: participant.id,
        name: participant.user.name,
        email: participant.user.email,
        intervals: intervals.map((i) => ({
          joinedAt: i.joinedAt,
          leftAt: i.leftAt,
          source: i.source,
        })),
        joinCount: intervals.length,
        totalSeconds,
        firstJoinedAt: intervals[0]?.joinedAt ?? null,
        lastLeftAt:
          leaveTimes.length > 0
            ? new Date(Math.max(...leaveTimes.map((d) => d.getTime())))
            : null,
        attendancePercent: percent,
        status,
      };
    });
  }
}
