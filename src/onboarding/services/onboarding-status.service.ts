/**
 * OnboardingStatusService — the server-derived onboarding state
 * (docs/NEW_CUSTOMER_ONBOARDING.md §3.4–3.5).
 *
 * EVERY STEP IS DERIVED from the records that actually define it — the
 * subscription, the academy and its provisioning request, the website
 * configuration, the logo, the courses. Nothing about step progress is
 * stored, so refresh, logout, another device or an expired session always
 * produce the same answer. The single stored fact is
 * `organizations.onboarding_completed_at`: whether the owner has finished or
 * deferred the wizard, which is a choice and cannot be derived.
 *
 * Reads run in the owner's own tenant + user context, so RLS still decides
 * visibility. A handful of indexed point reads; called only by the wizard
 * and the dashboard card, never on the login path.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TrialEligibilityService } from '../../plans/services/trial-eligibility.service';
import { TrialPolicyRepository } from '../../plans/repositories/trial-policy.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { resolveCanonicalHost } from '../../domain/utils/canonical-host.util';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import { recordOnboardingCompleted } from '../../observability/metrics/onboarding-metrics';
import type {
  OnboardingStatusResponse,
  OnboardingStep,
  OnboardingStepKey,
} from '../dto/onboarding.contract';

/** Payment states that are still waiting on someone (the customer's proof or the Platform Owner's review). */
const NON_TERMINAL_PAYMENT_STATUSES = new Set([
  'created',
  'pending',
  'processing',
  'requires_action',
  'requires_confirmation',
]);

/** Provisioning states after which nothing more will happen without a retry. */
const TERMINAL_PROVISIONING_STATUSES = new Set(['ready', 'failed', 'cancelled']);

/** A subscription that entitles the organization to build its academy. */
const ENTITLED_SUBSCRIPTION_STATUSES = new Set(['trialing', 'active']);

/**
 * Resume order: required work before recommended work. The wizard's VISUAL
 * order (plan, academy, branding, website, course) is the frontend's; this
 * decides only where "Continue setup" lands.
 */
const RESUME_ORDER: readonly OnboardingStepKey[] = [
  'plan',
  'academy',
  'website',
  'branding',
  'course',
];

export type OnboardingCompletionMode = 'finish' | 'defer';

@Injectable()
export class OnboardingStatusService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly trialEligibilityService: TrialEligibilityService,
    private readonly trialPolicyRepository: TrialPolicyRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly configService: ConfigService,
  ) {}

  async getStatus(
    organizationId: string,
    actorUserId: string,
  ): Promise<OnboardingStatusResponse> {
    const trialPolicy = await this.trialPolicyRepository.findSingleton();
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      (tx) => this.derive(tx, organizationId, actorUserId, trialPolicy.enabled),
    );
  }

  /**
   * "Finish" (`finish`) or "Finish for now" (`defer`). Idempotent: the first
   * call stamps `onboarding_completed_at`, later calls change nothing and are
   * not re-audited. `finish` is refused while a required step is open —
   * the only path that may end in "your academy is ready".
   */
  async complete(
    organizationId: string,
    actorUserId: string,
    mode: OnboardingCompletionMode,
  ): Promise<OnboardingStatusResponse> {
    const trialPolicy = await this.trialPolicyRepository.findSingleton();
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        const current = await this.derive(
          tx,
          organizationId,
          actorUserId,
          trialPolicy.enabled,
        );
        if (mode === 'finish' && !current.requiredComplete) {
          throw new ConflictException({
            messageKey: 'errors.onboarding.requiredIncomplete',
          });
        }
        if (current.completedAt !== null) return current;

        // `organizations` has no UPDATE policy: the one permitted write goes
        // through the SECURITY DEFINER `complete_organization_onboarding`,
        // which re-checks the session's owner membership and can only move
        // NULL → now() (migration 20261017000000).
        const [{ changed }] = await tx.$queryRaw<{ changed: number }[]>`
          SELECT complete_organization_onboarding(${organizationId}) AS changed
        `;
        if (changed === 1) {
          await this.auditLogWriterService.write(tx, {
            actorUserId,
            organizationId,
            action: 'organization.onboarding.completed',
            targetType: 'organization',
            targetId: organizationId,
            context: { mode, requiredComplete: current.requiredComplete },
          });
          recordOnboardingCompleted(mode === 'finish' ? 'finished' : 'deferred');
        }
        return this.derive(tx, organizationId, actorUserId, trialPolicy.enabled);
      },
    );
  }

  private async derive(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorUserId: string,
    trialsEnabled: boolean,
  ): Promise<OnboardingStatusResponse> {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, onboardingCompletedAt: true },
    });
    if (!organization) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const [subscription, latestPayment, academy, provisioning, actor] = await Promise.all(
      [
        tx.tenantSubscription.findUnique({
          where: { organizationId },
          select: { status: true, trialEndsAt: true, plan: { select: { key: true } } },
        }),
        tx.payment.findFirst({
          where: { organizationId, checkout: { targetType: 'plan_subscription' } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            reviewStatus: true,
            failureReason: true,
            reviewNotes: true,
            checkout: { select: { targetKey: true } },
          },
        }),
        tx.academy.findFirst({
          where: { organizationId, archivedAt: null, status: { not: 'archived' } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            subdomainAllocation: { select: { subdomain: true, fullHost: true } },
            websiteConfiguration: { select: { status: true } },
          },
        }),
        tx.provisioningRequest.findFirst({
          where: { organizationId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, currentStepKey: true, academyId: true },
        }),
        tx.user.findUnique({ where: { id: actorUserId }, select: { email: true } }),
      ],
    );

    const courseExists = academy
      ? (await tx.course.findFirst({
          where: { academyId: academy.id, status: { not: 'archived' } },
          select: { id: true },
        })) !== null
      : false;

    // --- plan (prerequisite) -------------------------------------------
    const subscriptionStatus = subscription?.status ?? 'no_plan';
    const entitled = ENTITLED_SUBSCRIPTION_STATUSES.has(subscriptionStatus);
    const paymentAwaiting =
      latestPayment !== null && NON_TERMINAL_PAYMENT_STATUSES.has(latestPayment.status);
    const planStatus = entitled
      ? 'complete'
      : paymentAwaiting
        ? 'awaiting_confirmation'
        : 'incomplete';

    // Only a never-trialed `no_plan` subscription, and only while this
    // mailbox has never redeemed one — the same two facts `startTrial`
    // enforces. Display only: `startTrial` re-checks both.
    const trialAvailable =
      trialsEnabled &&
      subscription !== null &&
      subscription.status === 'no_plan' &&
      subscription.trialEndsAt === null &&
      actor !== null &&
      (await this.trialEligibilityService.describeEligibility(tx, actor.email)).eligible;

    // --- academy (required) --------------------------------------------
    const provisioningInFlight =
      provisioning !== null && !TERMINAL_PROVISIONING_STATUSES.has(provisioning.status);
    const provisioningFailed = provisioning?.status === 'failed';
    const academyStatus =
      !entitled && !academy
        ? 'blocked'
        : academy && !(provisioningInFlight && provisioning?.academyId === academy.id)
          ? 'complete'
          : provisioningInFlight
            ? 'in_progress'
            : 'incomplete';
    const academyReady = academyStatus === 'complete';

    // --- steps that need the academy -------------------------------------
    const needsAcademy = (complete: boolean) =>
      !academyReady
        ? ('blocked' as const)
        : complete
          ? ('complete' as const)
          : ('incomplete' as const);

    const steps: OnboardingStep[] = [
      { key: 'plan', requirement: 'prerequisite', status: planStatus },
      { key: 'academy', requirement: 'required', status: academyStatus },
      {
        key: 'branding',
        requirement: 'recommended',
        status: needsAcademy(!!academy?.logoUrl),
      },
      {
        key: 'website',
        requirement: 'required',
        status: needsAcademy(academy?.websiteConfiguration?.status === 'published'),
      },
      { key: 'course', requirement: 'recommended', status: needsAcademy(courseExists) },
    ];

    const byKey = new Map(steps.map((step) => [step.key, step.status]));
    const requiredComplete =
      byKey.get('academy') === 'complete' && byKey.get('website') === 'complete';
    const nextStep =
      RESUME_ORDER.find((key) => byKey.get(key) !== 'complete') ?? 'summary';

    const baseDomain =
      this.configService.get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain;
    const host = academy?.subdomainAllocation
      ? (resolveCanonicalHost({
          connectedCustomHostname: null,
          subdomainFullHost: academy.subdomainAllocation.fullHost,
          subdomainLabel: academy.subdomainAllocation.subdomain,
          baseDomain,
        })?.host ?? null)
      : null;

    return {
      organizationId,
      completedAt: organization.onboardingCompletedAt?.toISOString() ?? null,
      pending: organization.onboardingCompletedAt === null,
      requiredComplete,
      readyLabelAllowed: requiredComplete,
      subscription: {
        status: subscriptionStatus,
        planKey:
          subscription && subscriptionStatus !== 'no_plan' ? subscription.plan.key : null,
        trialEndsAt: subscription?.trialEndsAt?.toISOString() ?? null,
        trialAvailable,
      },
      latestSubscriptionPayment: latestPayment
        ? {
            id: latestPayment.id,
            status: latestPayment.status,
            reviewStatus: latestPayment.reviewStatus,
            // A message key (e.g. `errors.payment.rejectedByReviewer`) plus
            // the reviewer's own words, when a Platform Owner rejected it.
            failureReason: latestPayment.failureReason,
            reviewNotes: latestPayment.reviewNotes,
            planKey: latestPayment.checkout?.targetKey ?? '',
          }
        : null,
      academy: academy
        ? {
            id: academy.id,
            name: academy.name,
            slug: academy.slug,
            host,
            logoUrl: academy.logoUrl,
          }
        : null,
      provisioning: provisioning
        ? {
            requestId: provisioning.id,
            status: provisioning.status,
            currentStepKey: provisioning.currentStepKey,
            failed: provisioningFailed,
          }
        : null,
      steps,
      nextStep,
    };
  }
}
