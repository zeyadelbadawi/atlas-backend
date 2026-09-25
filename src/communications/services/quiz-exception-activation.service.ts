/**
 * QuizExceptionActivationService — W-EXC: the moment a SCHEDULED learner
 * exception opens.
 *
 * WHY THIS IS A SWEEP AND NOT A DELAYED JOB. A reviewer can move or
 * delete an exception at any time, so a job scheduled for the old
 * `availableFrom` would have to be found and revoked — and a job that is
 * lost (a Redis flush, a queue drained during a deploy) is a message
 * nobody ever notices is missing. A sweep holds no state at all: every
 * tick re-asks the rows "has a scheduled exception opened?", which is the
 * same design `TenantLifecycleService` uses and for the same reason.
 *
 * WHY IT DOES NOT RE-NOTIFY — the one property this whole file exists to
 * get right. The dedupe key is
 * `quiz_override.activated:<override id>:<availableFrom>`: the instant
 * that transitioned, never the instant of the tick. It is byte-identical
 * on every tick, so the `(recipient_user_id, dedupe_key)` unique index
 * rejects the second INSERT and `emit` reports `created: false`. A
 * reviewer who MOVES the window gets a new instant and therefore a
 * genuinely new message; one who re-saves the same window gets nothing.
 * The lookback window below is a cost bound, not the guard — with no
 * window at all this sweep would still send exactly once.
 *
 * WHICH ROWS ARE ELIGIBLE. `available_from > updated_at` is the whole
 * "was this exception SCHEDULED when it was granted?" test, read from the
 * row and nothing else:
 *
 *   - granted with a future window  → `available_from` is after the write
 *     that set it, so the learner got the "it becomes active on <date>"
 *     message and is owed the follow-up;
 *   - granted already open (no `available_from`, or one in the past) →
 *     the grant message already said "you can use it now"; saying it
 *     again when the sweep next runs would be the noise this guard
 *     exists to prevent;
 *   - edited after it opened → `updated_at` moves past `available_from`
 *     and the row leaves the set, while the edit's own `granted` message
 *     (which correctly reads "active now") carries the news.
 *
 * WHY IT LIVES IN THIS MODULE. It emits a communication and writes
 * nothing to the assessment domain — and, decisively, the ONE processor
 * allowed on the `communications` queue is here. A second worker on that
 * queue, declared in the instructor module, would compete for the
 * outbox's own jobs and silently drop half of them; see
 * `communications.types.ts` and `one-worker-per-queue.spec.ts`.
 *
 * WHY THERE IS NO "YOUR EXCEPTION HAS EXPIRED" MESSAGE. `availableUntil`
 * closing is the only transition of this row that is deliberately
 * silent, and it is a judgement, not an omission:
 *
 *   - it carries nothing the learner can act on. At the moment a window
 *     shuts they have either used the accommodation or they have not,
 *     and nothing about the message changes what happens next;
 *   - they were already told the date. Every one of the three messages
 *     above prints `availableUntil` when the row has one, so the closing
 *     date arrives with the news that there is an exception at all —
 *     which is when it is still useful;
 *   - the quiz's OWN window and due date are what actually stop a
 *     learner from attempting it, and those already have their own
 *     surfaces. A fourth message that says "the private extension you
 *     were given has ended" invites the reading that the quiz itself has
 *     ended, which is usually false;
 *   - and it would be the one message in this family that fires for
 *     every learner every term, with nothing to do about it. That is the
 *     shape of notification people learn to ignore — and they ignore the
 *     other three along with it.
 *
 * If it is ever wanted, it is a second `case` on this sweep keyed on
 * `availableUntil` and nothing else changes.
 *
 * RLS. Runs as the platform owner (the established sweep precedent — see
 * `CommunicationDispatchService`'s header on why "no context" silently
 * reads nothing under FORCE RLS). `quiz_student_overrides`, `courses` and
 * `academies` each have a `*_platform_select` policy; `quizzes` does NOT,
 * so the quiz title is read in a second pass under the academy's OWN
 * tenant context through `quizzes_tenant_select`, and the course id comes
 * from the existing `quiz_course_id()` definer rather than from a join
 * this context cannot make. Nothing here widens any policy.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import { CommunicationService } from './communication.service';
import { activatedValues, type QuizExceptionFacts } from './quiz-exception-values.util';
import {
  COMMUNICATION_EXCEPTION_ACTIVATION_BATCH,
  COMMUNICATION_EXCEPTION_ACTIVATION_LOOKBACK_MS,
} from '../queue/communications.types';

export interface ExceptionActivationResult {
  /** Rows whose scheduled window had opened within the lookback. */
  readonly due: number;
  /** Rows that produced a new communication on this tick. */
  readonly emitted: number;
  /** Rows already told — the expected outcome on every tick but the first. */
  readonly deduped: number;
}

/** One due override, as the platform-owner pass can see it. */
interface DueOverrideRow {
  readonly id: string;
  readonly quiz_id: string;
  readonly student_id: string;
  readonly time_multiplier: string;
  readonly extra_attempts: number;
  readonly available_from: Date;
  readonly available_until: Date | null;
  readonly course_id: string;
  readonly academy_id: string;
  readonly organization_id: string;
}

@Injectable()
export class QuizExceptionActivationService {
  private readonly logger = new Logger(QuizExceptionActivationService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly communicationService: CommunicationService,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  /** One tick. Directly callable by the processor and by tests, like `TenantLifecycleService.run`. */
  async run(now: Date = this.clock.now()): Promise<ExceptionActivationResult> {
    const result = { due: 0, emitted: 0, deduped: 0 };

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping exception activation.',
      );
      return result;
    }
    const actorUserId = platformOwner.id;

    const rows = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.findDue(tx, now),
    );
    if (rows.length === 0) return result;
    result.due = rows.length;

    const titles = await this.quizTitles(rows);

    for (const row of rows) {
      const title = titles.get(row.quiz_id);
      if (title === undefined) {
        // The quiz is invisible even inside its own tenant (deleted
        // mid-tick, or an academy whose organisation row has gone). There
        // is no message to send about a quiz that no longer exists, and
        // sending one that says "a quiz" would be worse than silence.
        this.logger.warn(
          { overrideId: row.id, quizId: row.quiz_id },
          'Skipping exception activation: the quiz is no longer readable.',
        );
        continue;
      }

      const facts: QuizExceptionFacts = {
        overrideId: row.id,
        quizId: row.quiz_id,
        quizTitle: title,
        courseId: row.course_id,
        timeMultiplier: row.time_multiplier,
        extraAttempts: row.extra_attempts,
        availableFrom: row.available_from,
        availableUntil: row.available_until,
      };

      /*
        One transaction per row: a row whose emit fails must not take the
        rest of the tick down with it, and a deduped row (the normal case)
        must not leave a transaction carrying a genuinely new one aborted.
        `emit` guards the duplicate INSERT with a SAVEPOINT for the same
        reason; one transaction per row makes the blast radius one row
        regardless.
      */
      const emitted = await this.tenancyContextService.runInUserContext(
        actorUserId,
        (tx) =>
          this.communicationService.emit(tx, {
            // THE RECIPIENT IS THE ROW'S OWN `student_id`. Read from the
            // override server-side; no request reaches this code path.
            key: 'assessment.exception.activated',
            recipientUserId: row.student_id,
            organizationId: row.organization_id,
            academyId: row.academy_id,
            entity: { type: 'quiz_student_override', id: row.id },
            values: activatedValues(facts),
          }),
      );
      if (emitted.created) result.emitted++;
      else result.deduped++;
      await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    }

    if (result.emitted > 0) {
      this.logger.log(result, 'Learner exception activations announced.');
    }
    return result;
  }

  /**
   * Overrides whose SCHEDULED window opened between `now - lookback` and
   * `now`, with the tenant facts the emit needs.
   *
   * Raw because the eligibility test compares two COLUMNS of the same row
   * (`available_from > updated_at`), which Prisma's `where` cannot
   * express, and because the course is reached through the existing
   * `quiz_course_id()` definer — the platform owner has no SELECT policy
   * on `quizzes` and this sweep is not the place to give it one.
   *
   * A window that has ALREADY closed is excluded: telling someone their
   * exception just opened, when it also already expired, is an email
   * whose only possible effect is confusion.
   */
  private findDue(tx: Prisma.TransactionClient, now: Date): Promise<DueOverrideRow[]> {
    const from = new Date(now.getTime() - COMMUNICATION_EXCEPTION_ACTIVATION_LOOKBACK_MS);
    return tx.$queryRaw<DueOverrideRow[]>`
      SELECT o."id",
             o."quiz_id",
             o."student_id",
             o."time_multiplier"::text AS time_multiplier,
             o."extra_attempts",
             o."available_from",
             o."available_until",
             c."id"              AS course_id,
             c."academy_id"      AS academy_id,
             a."organization_id" AS organization_id
      FROM "quiz_student_overrides" o
      JOIN "courses"   c ON c."id" = quiz_course_id(o."quiz_id")
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE o."available_from" IS NOT NULL
        AND o."available_from" <= ${now}
        AND o."available_from" > ${from}
        AND o."available_from" > o."updated_at"
        AND (o."available_until" IS NULL OR o."available_until" > ${now})
      ORDER BY o."available_from" ASC
      LIMIT ${COMMUNICATION_EXCEPTION_ACTIVATION_BATCH}
    `;
  }

  /**
   * Quiz titles, read one ORGANISATION at a time under that tenant's own
   * context (`quizzes_tenant_select`).
   *
   * The platform owner cannot see `quizzes` at all, and this sweep
   * deliberately does not change that: a notification job is a poor
   * reason to widen what one account can read across every tenant in the
   * system. Grouping keeps it to one query per organisation per tick
   * rather than one per row.
   */
  private async quizTitles(
    rows: readonly DueOverrideRow[],
  ): Promise<Map<string, string>> {
    const byOrganization = new Map<string, Set<string>>();
    for (const row of rows) {
      const quizIds = byOrganization.get(row.organization_id) ?? new Set<string>();
      quizIds.add(row.quiz_id);
      byOrganization.set(row.organization_id, quizIds);
    }

    const titles = new Map<string, string>();
    for (const [organizationId, quizIds] of byOrganization) {
      const found = await this.tenancyContextService.runInTenantContext(
        organizationId,
        (tx) =>
          tx.quiz.findMany({
            where: { id: { in: [...quizIds] } },
            select: { id: true, title: true },
          }),
      );
      for (const quiz of found) titles.set(quiz.id, quiz.title);
    }
    return titles;
  }
}
