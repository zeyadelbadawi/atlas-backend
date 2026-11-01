/**
 * Due-date pushes (Atlas mobile app): the day before a quiz or assignment
 * is due, a push to the learners who turned it on for their device.
 *
 * PUSH ONLY. No `notifications` row and no outbox row is written, so the
 * web inbox and the app's own feed are untouched — this is a reminder on
 * the phone, not a notification. The device setting is off by default.
 *
 * TENANT-SAFE. Candidates come from `due_reminder_candidates()` (SECURITY
 * DEFINER, answers only under platform-owner context, ids and due dates
 * only), so no table's visibility is widened for this. Everything after
 * that runs in the learner's OWN context:
 * the enrollment, the membership and "not yet submitted" are re-checked
 * there, and the claim row is inserted there under own-row RLS.
 *
 * ONCE PER ITEM AND DUE DATE. The claim (`due_reminder_sends`, unique on
 * user + item + due date, ON CONFLICT DO NOTHING) is written before the
 * push is sent, so two instances never send it twice. A moved due date is
 * a new reminder. A learner who already submitted is claimed and skipped,
 * so they are not reconsidered every tick.
 *
 * `FLAG_PUSH_MODE` other than `on` → nothing runs (the default).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PushDeliveryService } from '../push-delivery.service';
import { PUSH_PROVIDER } from '../providers/push-provider';
import type { PushProvider } from '../providers/push-provider';
import { dueReminderBody, pushTitle } from '../push-copy';
import {
  DUE_REMINDER_MAX_PER_TICK,
  DUE_REMINDER_WINDOW_MS,
  type DueItemKind,
} from './due-reminder.types';

export interface DueReminderSweepResult {
  readonly reminded: number;
  readonly skipped: number;
  readonly pushesSent: number;
  readonly failures: number;
}

interface CandidateRow {
  readonly user_id: string;
  readonly academy_id: string;
  readonly academy_name: string;
  readonly kind: DueItemKind;
  readonly item_id: string;
  readonly course_id: string;
  readonly due_at: Date;
}

@Injectable()
export class DueReminderSweepService {
  private readonly logger = new Logger(DueReminderSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyContextService,
    private readonly delivery: PushDeliveryService,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
  ) {}

  async run(now: Date = new Date()): Promise<DueReminderSweepResult> {
    const result = { reminded: 0, skipped: 0, pushesSent: 0, failures: 0 };
    if (!this.delivery.enabled()) return result;

    const candidates = await this.candidates(now);
    for (const c of candidates) {
      try {
        const sent = await this.remind(c, now);
        if (sent === null) {
          result.skipped += 1;
        } else {
          result.reminded += 1;
          result.pushesSent += sent;
        }
      } catch (error) {
        // One learner's failure never stops the others. A failure before
        // the send rolls the claim back with its transaction; a send that
        // failed only transiently releases it (below). Either way the pair
        // is retried next tick.
        result.failures += 1;
        this.logger.warn(
          { kind: c.kind, itemId: c.item_id, detail: (error as Error).message },
          'Due reminder failed; will retry on the next tick.',
        );
      }
    }
    return result;
  }

  /**
   * Learner + item pairs: a published quiz or assignment due within the
   * window, in a course the learner is enrolled in on the academy a
   * reminder-enabled device is registered for, not yet claimed.
   */
  private async candidates(now: Date): Promise<readonly CandidateRow[]> {
    const ownerId = await this.platformOwnerId();
    if (!ownerId) {
      this.logger.error('No platform owner exists — the due-reminder sweep cannot run.');
      return [];
    }
    const until = new Date(now.getTime() + DUE_REMINDER_WINDOW_MS);
    return this.tenancy.runInUserContext(
      ownerId,
      (tx) =>
        tx.$queryRaw<CandidateRow[]>`
        SELECT * FROM due_reminder_candidates(
          ${now}::timestamp(3), ${until}::timestamp(3), ${DUE_REMINDER_MAX_PER_TICK}::integer)`,
    );
  }

  /** The number of pushes sent, or null when the pair was claimed and skipped. */
  private async remind(c: CandidateRow, now: Date): Promise<number | null> {
    const devices = await this.tenancy.runInUserContext(c.user_id, async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO due_reminder_sends (id, user_id, item_type, item_id, due_at)
        VALUES (gen_random_uuid()::text, ${c.user_id}, ${c.kind}, ${c.item_id}, ${c.due_at})
        ON CONFLICT (user_id, item_type, item_id, due_at) DO NOTHING
        RETURNING id`;
      if (claimed.length === 0) return null;

      const membership = await tx.academyStudent.findUnique({
        where: { academyId_userId: { academyId: c.academy_id, userId: c.user_id } },
        select: { status: true, blockedAt: true },
      });
      if (!membership || membership.status !== 'active' || membership.blockedAt) {
        return null;
      }
      const done =
        c.kind === 'quiz'
          ? await tx.quizAttempt.count({
              where: {
                quizId: c.item_id,
                studentId: c.user_id,
                submittedAt: { not: null },
              },
            })
          : await tx.assignmentSubmission.count({
              where: {
                assignmentId: c.item_id,
                studentId: c.user_id,
                submittedAt: { not: null },
              },
            });
      if (done > 0) return null;

      const candidates = await tx.pushDevice.findMany({
        where: { userId: c.user_id, academyId: c.academy_id, dueReminders: true },
      });
      if (candidates.length === 0) return null;
      // A device is used only while the session that registered it is alive.
      const live = await tx.refreshToken.findMany({
        where: {
          userId: c.user_id,
          sessionId: { in: [...new Set(candidates.map((d) => d.sessionId))] },
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { sessionId: true },
      });
      const liveSessions = new Set(live.map((t) => t.sessionId));
      return candidates.filter((d) => liveSessions.has(d.sessionId));
    });
    if (!devices || devices.length === 0) return null;

    const data: Record<string, string> = {
      kind: 'due_reminder',
      context: 'academy',
      academyId: c.academy_id,
      // The web path, which the app already maps to the quiz or assignment.
      path: `/my/courses/${c.course_id}/activities/${c.item_id}`,
    };
    let sent = 0;
    let transient = 0;
    const dead: string[] = [];
    const delivered: string[] = [];
    for (const device of devices) {
      const locale = device.locale === 'ar' ? 'ar' : 'en';
      const result = await this.provider.send({
        token: device.token,
        title: pushTitle(c.academy_name, locale),
        body: dueReminderBody(c.kind, locale),
        data,
      });
      if (result.ok) {
        sent += 1;
        delivered.push(device.id);
      } else if (result.reason === 'invalid_token') {
        dead.push(device.id);
      } else {
        if (result.reason === 'transient') transient += 1;
        this.logger.warn(
          { deviceId: device.id, reason: result.reason, detail: result.detail },
          'Due reminder push not delivered',
        );
      }
    }
    if (sent === 0 && transient > 0) {
      // Nothing reached the learner and a retry may: release the claim so
      // the next tick tries again (while the item is still due soon).
      await this.tenancy.runInUserContext(c.user_id, (tx) =>
        tx.dueReminderSend.deleteMany({
          where: {
            userId: c.user_id,
            itemType: c.kind,
            itemId: c.item_id,
            dueAt: c.due_at,
          },
        }),
      );
    }
    if (dead.length > 0 || delivered.length > 0) {
      await this.tenancy.runInUserContext(c.user_id, async (tx) => {
        if (dead.length > 0) {
          await tx.pushDevice.deleteMany({
            where: { id: { in: dead }, userId: c.user_id },
          });
        }
        if (delivered.length > 0) {
          await tx.pushDevice.updateMany({
            where: { id: { in: delivered }, userId: c.user_id },
            data: { lastSentAt: now },
          });
        }
      });
    }
    return sent;
  }

  private async platformOwnerId(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT platform_owner_user_id() AS id`;
    return rows[0]?.id ?? null;
  }
}
