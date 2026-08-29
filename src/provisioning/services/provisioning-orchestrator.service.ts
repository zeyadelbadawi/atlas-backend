/**
 * ProvisioningOrchestratorService — the 7-step resumable state machine
 * itself (master plan §21 Phase P14's own Definition of Done: "the state
 * machine survives a mid-flight failure and resumes correctly"). The ONE
 * place any provisioning step actually executes — called identically by
 * `ProvisioningProcessor` (the real, only trigger — creation enqueues a
 * job, `retry` re-enqueues one) and directly by e2e tests that need to
 * observe a single step in isolation, never a second orchestration path.
 *
 * Every step follows the same three-phase shape, each phase its own
 * committed transaction — the real mechanism that makes "resume after a
 * mid-flight crash" possible at all (an in-memory-only multi-step
 * transaction would roll back everything on a crash, defeating the whole
 * point):
 *
 *   1. `beginStep` — reads the step's CURRENT row. If it is already
 *      `completed`/`skipped`, this method does nothing further for that
 *      step (never increments `attemptNumber`, never re-runs — master plan
 *      §21 P14's own mandatory test) and the caller advances past it. Only
 *      a `pending`/`running`/`failed` row is marked `running` (attemptNumber
 *      incremented) and committed BEFORE any real work starts — so a crash
 *      between this commit and the work finishing leaves an honest,
 *      resumable `running` row behind, never silently lost progress.
 *   2. `executeStep` — the real work, outside any single long-lived
 *      transaction (each sub-operation, e.g. `AcademiesService.create`,
 *      manages its own). Every step's real work is independently idempotent
 *      (existence-checked before writing) — see each step's own method doc
 *      comment — so re-running it after a crash between phases 1 and 2 is
 *      always safe, never a duplicate Academy/subdomain allocation.
 *   3. `completeStep` — persists the outcome (`completed`/`skipped`/
 *      `failed`) onto the step row AND advances `provisioning_requests.
 *      status`/`currentStepKey` (or sets the terminal `failed`/`ready`
 *      state) in one committed transaction.
 *
 * `runToCompletion` loops phases 1–3 across the remaining steps in
 * `PROVISIONING_STEP_ORDER`, stopping the moment any step fails or the
 * last step (`finalization`) completes — matching "a failed step may be
 * retried... but a process crash... must allow the request to resume from
 * the correct incomplete step" exactly: nothing here assumes it runs to
 * completion in one call: each iteration re-reads live state fresh from
 * the database (`app.current_organization_id`, never an in-memory cache),
 * so a concurrent cancel or a redelivered duplicate job both observe and
 * respect whatever the OTHER concurrent execution already committed.
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProvisioningRequest, ProvisioningStepKey } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AcademiesService } from '../../academy/services/academies.service';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { PlatformDomainConfigurationRepository } from '../../domain/repositories/platform-domain-configuration.repository';
import { ProvisioningRequestsRepository } from '../repositories/provisioning-requests.repository';
import { ProvisioningStepsRepository } from '../repositories/provisioning-steps.repository';
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';
import { WebsiteConfigurationService } from '../../website/services/website-configuration.service';
import { WEBSITE_THEME_KEYS } from '../../website/constants/website.constants';
import {
  PROVISIONING_STEP_ORDER,
  STATUS_AFTER_STEP,
} from '../dto/provisioning.constants';
import type { ProvisioningErrorResponse } from '../dto/provisioning-step.contract';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Confirmed, reproducible in this environment, in two related shapes:
 *
 * 1. Opening a brand-new Prisma interactive transaction immediately after
 *    catching an error from a DIFFERENT interactive transaction that just
 *    aborted (e.g. `academiesService.create`'s own internal transaction,
 *    rolled back by a real `P2002`) can fail on that new transaction's
 *    very first statement with "Transaction ID is invalid, refers to an
 *    old closed transaction."
 * 2. Under genuinely heavy concurrent load (the full e2e regression suite
 *    — dozens of files, hundreds of simultaneous transactions across
 *    every phase, not just this one) the SAME underlying connection-pool/
 *    transaction-engine contention surfaces as a `P2024` ("timed out
 *    fetching a new connection from the pool") or a `P2028`
 *    ("transaction API error") — reproduced directly running the full
 *    suite, not merely this phase's own tests in isolation.
 *
 * Both are connection-pool-level timing issues one layer below this code,
 * not business-logic bugs, and both are genuinely transient — a retry a
 * short moment later succeeds. `withTransientRetry` isolates this
 * specific, narrow class of error and retries a bounded number of times
 * with short exponential backoff — never swallowing any OTHER error,
 * which always propagates on the first attempt.
 */
async function withTransientRetry<T>(
  work: () => Promise<T>,
  attemptsRemaining = 3,
  delayMs = 150,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isTransientDatabaseError(error) || attemptsRemaining <= 1) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withTransientRetry(work, attemptsRemaining - 1, delayMs * 2);
  }
}

function isTransientDatabaseError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2024' || error.code === 'P2028')
  ) {
    return true;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return true;
  return (
    error instanceof Error &&
    (error.message.includes('old closed transaction') ||
      error.message.includes('Transaction API error') ||
      error.message.includes('Timed out fetching'))
  );
}

type StepOutcome =
  | { readonly result: 'completed' | 'skipped' }
  | { readonly result: 'failed'; readonly error: ProvisioningErrorResponse };

function toProvisioningError(error: unknown): ProvisioningErrorResponse {
  if (error instanceof Error) {
    return {
      code: 'step_execution_failed',
      messageKey: 'errors.provisioning.stepFailed',
      detail: error.message,
    };
  }
  return { code: 'step_execution_failed', messageKey: 'errors.provisioning.stepFailed' };
}

@Injectable()
export class ProvisioningOrchestratorService {
  private readonly logger = new Logger(ProvisioningOrchestratorService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly provisioningRequestsRepository: ProvisioningRequestsRepository,
    private readonly provisioningStepsRepository: ProvisioningStepsRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academiesService: AcademiesService,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
    private readonly notificationFanoutService: NotificationFanoutService,
    private readonly websiteConfigurationService: WebsiteConfigurationService,
  ) {}

  /** `TenancyContextService.runInTenantContext`, wrapped with `withTransientRetry` — the ONE call path every method in this class uses to touch the database, so the transient-connection-pool protection documented on `withTransientRetry` applies uniformly, not just at the one call site that first surfaced it. */
  private runTenant<T>(
    organizationId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return withTransientRetry(() =>
      this.tenancyContextService.runInTenantContext(organizationId, work),
    );
  }

  /**
   * Drives one provisioning request from its current step through to
   * `ready`/`failed`, or until it is discovered to already be
   * `ready`/`cancelled` (a genuinely idempotent no-op — safe to call for a
   * redelivered/duplicate job, matching §18's worker-redelivery
   * requirement). Increments `attempt_count` exactly once per call — one
   * real "the orchestrator picked this request up" event, distinct from
   * each individual step's own `attemptNumber`.
   *
   * `failed` is deliberately NOT one of the statuses that stops this
   * method early — a failed request is exactly what `retryRequest`
   * re-enqueues a job for, and it must resume from its own
   * `currentStepKey` (still pointing at the step that failed) rather than
   * being silently ignored. Only `ready`/`cancelled` are genuinely done —
   * see `isAbandoned` below.
   */
  async runToCompletion(
    provisioningRequestId: string,
    organizationId: string,
  ): Promise<void> {
    const bumped = await this.runTenant(organizationId, async (tx) => {
      const request = await this.provisioningRequestsRepository.findById(
        tx,
        provisioningRequestId,
      );
      if (!request) return null;
      if (isAbandoned(request.status)) return request;
      return this.provisioningRequestsRepository.update(tx, provisioningRequestId, {
        attemptCount: { increment: 1 },
        startedAt: request.startedAt ?? new Date(),
      });
    });
    if (!bumped || isAbandoned(bumped.status)) return;

    for (;;) {
      const shouldContinue = await this.runOneStep(provisioningRequestId, organizationId);
      if (!shouldContinue) return;
    }
  }

  /** Runs exactly the request's current step (if any real work remains) and returns whether the caller should continue to the next step. Exposed separately from `runToCompletion` so tests can observe one step in isolation without racing the rest of the state machine. */
  async runOneStep(
    provisioningRequestId: string,
    organizationId: string,
  ): Promise<boolean> {
    const request = await this.runTenant(organizationId, (tx) =>
      this.provisioningRequestsRepository.findById(tx, provisioningRequestId),
    );
    if (!request || isAbandoned(request.status)) return false;

    const stepKey = request.currentStepKey;

    const existingStep = await this.runTenant(organizationId, (tx) =>
      this.provisioningStepsRepository.findByRequestAndKey(
        tx,
        provisioningRequestId,
        stepKey,
      ),
    );

    // Rule #4/#5: a completed or skipped step is never re-executed — advance past it without touching its row at all.
    if (
      existingStep &&
      (existingStep.status === 'completed' || existingStep.status === 'skipped')
    ) {
      await this.advancePastStep(provisioningRequestId, organizationId, stepKey);
      return stepKey !== 'finalization';
    }

    await this.runTenant(organizationId, (tx) =>
      this.provisioningStepsRepository.markRunning(tx, provisioningRequestId, stepKey),
    );

    let outcome: StepOutcome;
    try {
      outcome = await this.executeStep(stepKey, request, organizationId);
    } catch (error) {
      this.logger.warn(
        {
          provisioningRequestId,
          stepKey,
          error: error instanceof Error ? error.message : error,
        },
        'Provisioning step threw — recording as a failed step',
      );
      outcome = { result: 'failed', error: toProvisioningError(error) };
    }

    const isFinalizationStep = stepKey === 'finalization';
    const { shouldContinue, notifiedNew } = await this.runTenant(
      organizationId,
      async (tx) => {
        if (outcome.result === 'failed') {
          await this.provisioningStepsRepository.markFailed(
            tx,
            provisioningRequestId,
            stepKey,
            outcome.error as unknown as Prisma.InputJsonValue,
          );
          await this.provisioningRequestsRepository.update(tx, provisioningRequestId, {
            status: 'failed',
            lastError: outcome.error as unknown as Prisma.InputJsonValue,
            failedAt: new Date(),
          });
          // Same transaction as the state transition above — a rollback
          // here (e.g. a later statement in this block failing) leaves no
          // misleading notification behind, matching master plan §21 P17's
          // own atomicity requirement.
          const created = await this.notificationFanoutService.notify(tx, {
            userId: request.requestedByUserId,
            type: 'system',
            priority: 'high',
            titleKey: 'notifications:events.provisioningFailed.title',
            messageKey: 'notifications:events.provisioningFailed.message',
            values: { academyName: request.requestedAcademyName },
            dedupeKey: `provisioning_failed:${provisioningRequestId}:${stepKey}`,
          });
          return { shouldContinue: false, notifiedNew: created };
        }

        if (outcome.result === 'skipped') {
          await this.provisioningStepsRepository.markSkipped(
            tx,
            provisioningRequestId,
            stepKey,
          );
        } else {
          await this.provisioningStepsRepository.markCompleted(
            tx,
            provisioningRequestId,
            stepKey,
          );
        }

        await this.advanceRequestAfterStep(tx, provisioningRequestId, stepKey);

        let created = false;
        if (isFinalizationStep) {
          created = await this.notificationFanoutService.notify(tx, {
            userId: request.requestedByUserId,
            type: 'system',
            priority: 'medium',
            titleKey: 'notifications:events.provisioningCompleted.title',
            messageKey: 'notifications:events.provisioningCompleted.message',
            values: { academyName: request.requestedAcademyName },
            dedupeKey: `provisioning_completed:${provisioningRequestId}`,
          });
        }

        return { shouldContinue: !isFinalizationStep, notifiedNew: created };
      },
    );

    // Step 2 of the notification contract — only after the transaction
    // above has actually committed (see `NotificationFanoutService`'s own
    // doc comment on why this is a separate call, never inside the `tx`
    // callback above). `notifiedNew` (the real dedupe result from step 1,
    // never a hardcoded `true`) decides whether an email actually goes
    // out — a redelivered/retried call that already notified once never
    // double-emails.
    if (outcome.result === 'failed') {
      await this.notificationFanoutService.sendEmailAfterCommit(
        request.requestedByUserId,
        notifiedNew,
        {
          template: 'provisioning_failed',
          values: { academyName: request.requestedAcademyName },
        },
      );
    } else if (isFinalizationStep) {
      await this.notificationFanoutService.sendEmailAfterCommit(
        request.requestedByUserId,
        notifiedNew,
        {
          template: 'provisioning_completed',
          values: { academyName: request.requestedAcademyName },
        },
      );
    }

    return shouldContinue;
  }

  /** Advances `current_step_key`/`status` without touching the step row — used when a step is discovered already `completed`/`skipped` on resume, so the request-level milestone stays consistent even though no new work happened. */
  private async advancePastStep(
    provisioningRequestId: string,
    organizationId: string,
    stepKey: ProvisioningStepKey,
  ): Promise<void> {
    await this.runTenant(organizationId, (tx) =>
      this.advanceRequestAfterStep(tx, provisioningRequestId, stepKey),
    );
  }

  private async advanceRequestAfterStep(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
    stepKey: ProvisioningStepKey,
  ): Promise<void> {
    const nextIndex = PROVISIONING_STEP_ORDER.indexOf(stepKey) + 1;
    const nextStepKey = PROVISIONING_STEP_ORDER[nextIndex] ?? stepKey;
    const isLastStep = stepKey === 'finalization';

    await this.provisioningRequestsRepository.update(tx, provisioningRequestId, {
      status: STATUS_AFTER_STEP[stepKey],
      currentStepKey: nextStepKey,
      ...(isLastStep ? { completedAt: new Date() } : {}),
    });
  }

  private async executeStep(
    stepKey: ProvisioningStepKey,
    request: ProvisioningRequest,
    organizationId: string,
  ): Promise<StepOutcome> {
    switch (stepKey) {
      case 'tenant':
        // Always complete immediately — a request only ever exists inside
        // an already-authenticated Organization context; there is no
        // "create the tenant" work left (schema.prisma's own P14 header
        // comment, confirmed against the real frontend contract).
        return { result: 'completed' };

      case 'academy':
        return this.executeAcademyStep(request, organizationId);

      case 'theme':
        return this.executeThemeStep(request, organizationId);

      case 'branding':
      case 'domain':
        // Still no branding/custom-domain data anywhere in
        // `CreateProvisioningRequestPayload` — remain skipped, matching
        // the deliberate decision that connecting a REAL custom domain
        // stays the existing, separate `DomainService.addCustomDomain`
        // flow (master plan §24: never fabricate a connected domain).
        // `theme` (Phase P19) is no longer in this branch — see
        // `executeThemeStep` below.
        return { result: 'skipped' };

      case 'subdomain':
        return this.executeSubdomainStep(request, organizationId);

      case 'finalization':
        return { result: 'completed' };
    }
  }

  /**
   * Idempotent by construction: if `provisioning_requests.academy_id` is
   * already set, the Academy demonstrably already exists — no re-creation
   * attempt at all (rule #15: never a second Academy from a redelivered
   * worker). Otherwise calls `AcademiesService.create` (P3) directly,
   * reusing its complete slug-conflict-handling/membership-creation logic
   * verbatim. `slug` is deterministically the request's own
   * `requestedSubdomain` (already validated, already globally unique) —
   * so a genuine retry after a crash between Academy creation and this
   * request being updated with the new `academyId` hits the real slug
   * `@unique` constraint, not a fresh row; that conflict is resolved by
   * looking the Academy back up (only ever visible under THIS
   * Organization's own RLS context if it is genuinely ours) and adopting
   * it, rather than treating an idempotent replay as a hard failure.
   */
  private async executeAcademyStep(
    request: ProvisioningRequest,
    organizationId: string,
  ): Promise<StepOutcome> {
    if (request.academyId) return { result: 'completed' };

    try {
      const academy = await this.academiesService.create(request.requestedByUserId, {
        organizationId,
        name: request.requestedAcademyName,
        slug: request.requestedSubdomain,
      });
      await this.runTenant(organizationId, (tx) =>
        this.provisioningRequestsRepository.update(tx, request.id, {
          academyId: academy.id,
        }),
      );
      return { result: 'completed' };
    } catch (error) {
      const adopted = await this.tryAdoptExistingAcademy(request, organizationId, error);
      if (adopted) return { result: 'completed' };
      throw error;
    }
  }

  /**
   * Phase P19 — real theme selection during onboarding (previously
   * always `{ result: 'skipped' }`, see `Reports/
   * DEVELOPMENT_E2E_FLOW_AUDIT.md` P1-1). Reuses `WebsiteConfigurationService.
   * updateConfiguration` verbatim — the exact same write path the
   * post-onboarding Website Settings theme tab uses — never a second
   * theme-persistence mechanism. `request.academyId` is guaranteed set
   * here: `'academy'` always runs immediately before `'theme'` in
   * `PROVISIONING_STEP_ORDER`, and this orchestrator never skips ahead.
   *
   * No `selectedThemeKey` on the request is a real, valid outcome, not an
   * error: `WebsiteBootstrapService`'s own lazy get-or-create already
   * applies a sensible default theme the moment `updateConfiguration`
   * (or any website read) first touches this Academy — nothing to change,
   * so this step completes without a write, exactly like `'academy'`
   * completing immediately when `request.academyId` is already set.
   */
  private async executeThemeStep(
    request: ProvisioningRequest,
    organizationId: string,
  ): Promise<StepOutcome> {
    const themeKey = request.selectedThemeKey;
    const isKnownTheme = (value: string): value is (typeof WEBSITE_THEME_KEYS)[number] =>
      (WEBSITE_THEME_KEYS as readonly string[]).includes(value);

    // Not selected, or (defensively) no longer a real registry key — the
    // request-time DTO already validates against this exact list, so this
    // is unreachable in normal operation; treated as "nothing to change,"
    // never a failed step, consistent with this method's own doc comment.
    if (!themeKey || !isKnownTheme(themeKey)) return { result: 'completed' };

    await this.websiteConfigurationService.updateConfiguration(
      request.academyId!,
      organizationId,
      request.requestedByUserId,
      { themeKey },
    );
    return { result: 'completed' };
  }

  /**
   * Returns `true` only when the slug conflict was genuinely OUR own
   * Academy from an interrupted prior attempt (visible under this
   * Organization's own RLS-scoped read) — a real, different
   * Organization's collision on the same slug is structurally impossible
   * here anyway (the slug is the already-globally-unique
   * `requestedSubdomain`), but this never assumes that; it only ever
   * adopts a row this tenant context can actually see.
   *
   * Detects a slug collision two ways, not one: `AcademiesService.
   * create`'s own pre-check throws a clean `ConflictException`, but its
   * `withSlugConflictHandling` backstop (the real DB `@unique` constraint
   * path) only converts a raw `P2002` to that same `ConflictException`
   * when `error.meta.target` comes back as an array containing `'slug'` —
   * confirmed, in this environment's Postgres driver, to instead report
   * `target` as the literal string `"(not available)"`, so that backstop
   * silently never fires here and the raw `PrismaClientKnownRequestError`
   * propagates unconverted. That is a latent, pre-existing gap in P3's own
   * `AcademiesService` (out of P14's scope to fix — a different phase's
   * code, no P14 integration reason to touch it), but this orchestrator
   * cannot afford to miss the one case it actually depends on: a real,
   * redelivered idempotent retry hitting this exact constraint. So this
   * checks for a raw slug-`P2002` directly, in addition to the clean
   * `ConflictException`, rather than trusting the conversion to have
   * happened.
   */
  private async tryAdoptExistingAcademy(
    request: ProvisioningRequest,
    organizationId: string,
    error: unknown,
  ): Promise<boolean> {
    const isCleanConflict = error instanceof ConflictException;
    const isRawSlugConflict =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
    if (!isCleanConflict && !isRawSlugConflict) return false;

    const existing = await this.runTenant(organizationId, (tx) =>
      this.academiesRepository.findBySlug(tx, request.requestedSubdomain),
    );
    if (!existing) return false;

    await this.runTenant(organizationId, (tx) =>
      this.provisioningRequestsRepository.update(tx, request.id, {
        academyId: existing.id,
      }),
    );
    return true;
  }

  /**
   * Idempotent by construction: `subdomain_allocations.academy_id` is
   * `@unique`, checked before every insert attempt, and the insert itself
   * is caught for a P2002 race (two concurrent/redelivered workers both
   * reaching this step) — either path resolves to the SAME real row, never
   * a duplicate allocation (rule #16). `fullHost` is honestly `null` when
   * no Platform base domain is configured yet — never a fabricated host
   * (master plan §24).
   */
  private async executeSubdomainStep(
    request: ProvisioningRequest,
    organizationId: string,
  ): Promise<StepOutcome> {
    if (!request.academyId) {
      // Structurally unreachable — `subdomain` runs strictly after
      // `academy` in `PROVISIONING_STEP_ORDER` — but a real, honest
      // failure if it ever happens, never a silent skip.
      return {
        result: 'failed',
        error: {
          code: 'academy_not_ready',
          messageKey: 'errors.provisioning.academyNotReady',
        },
      };
    }
    const academyId = request.academyId;

    return this.runTenant(organizationId, async (tx) => {
      const existing = await this.subdomainAllocationsRepository.findByAcademyId(
        tx,
        academyId,
      );
      if (existing) return { result: 'completed' as const };

      const platformDomainConfig =
        await this.platformDomainConfigurationRepository.findSingleton();
      const fullHost = platformDomainConfig.baseDomain
        ? `${request.requestedSubdomain}.${platformDomainConfig.baseDomain}`
        : null;

      try {
        await this.subdomainAllocationsRepository.create(tx, {
          academyId,
          subdomain: request.requestedSubdomain,
          status: 'assigned',
          fullHost,
        });
        return { result: 'completed' as const };
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          const raced = await this.subdomainAllocationsRepository.findByAcademyId(
            tx,
            academyId,
          );
          if (raced) return { result: 'completed' as const };
        }
        throw error;
      }
    });
  }
}

/**
 * The orchestrator's own "never touch this again" set — deliberately
 * narrower than `TERMINAL_PROVISIONING_STATUSES` (`dto/provisioning.
 * constants.ts`, which also includes `failed` for API/polling purposes:
 * the frontend correctly stops polling on a failed request). Here,
 * `failed` must stay excluded: it is precisely the status a retry
 * resumes from, re-attempting the step recorded on `currentStepKey`.
 */
function isAbandoned(status: ProvisioningRequest['status']): boolean {
  return status === 'ready' || status === 'cancelled';
}
