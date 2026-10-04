/**
 * SignupOrganizationService — provides `SIGNUP_ORGANIZATION_PORT`: the
 * Organization, owner membership, subscription and Free Trial created inside
 * the signup's own transaction (docs/NEW_CUSTOMER_ONBOARDING.md §3.2).
 *
 * Nothing here is new domain logic. Each step is the existing service's own
 * code, run in the caller's transaction:
 *   - `OrganizationsService.createInTransaction` — organization, owner
 *     membership, `organization.created` audit — with
 *     `onboarding_completed_at = NULL`, the one thing that distinguishes a
 *     signup organization;
 *   - `OrganizationSubscriptionBootstrapService.bootstrapSubscription` — the
 *     `no_plan` subscription row every organization gets;
 *   - `TrialRedemptionService.grantSignupTrialInTransaction` — both
 *     trial-abuse guards, claim first.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OrganizationsService } from '../../tenancy/services/organizations.service';
import { OrganizationSubscriptionBootstrapService } from '../../plans/services/organization-subscription-bootstrap.service';
import { TrialRedemptionService } from '../../plans/services/trial-redemption.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import type {
  PreparedSignupOrganization,
  SignupOrganizationPort,
  SignupOrganizationResult,
} from '../../identity/services/signup-organization.port';

@Injectable()
export class SignupOrganizationService implements SignupOrganizationPort {
  private readonly logger = new Logger(SignupOrganizationService.name);

  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly subscriptionBootstrapService: OrganizationSubscriptionBootstrapService,
    private readonly trialRedemptionService: TrialRedemptionService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
  ) {}

  async prepare(input: {
    readonly organizationName: string;
    readonly planId?: string;
  }): Promise<PreparedSignupOrganization> {
    if (input.planId !== undefined) {
      // Throws the signup-specific 400s. The id the browser sent is only a
      // lookup key — eligibility is re-read from the live catalog here.
      await this.trialRedemptionService.resolveSignupTrialPlan(input.planId);
    }
    return {
      organizationName: input.organizationName,
      trialPlanId: input.planId ?? null,
    };
  }

  async createInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly owner: { readonly id: string; readonly email: string };
      readonly prepared: PreparedSignupOrganization;
      readonly context?: { readonly ipAddress?: string; readonly userAgent?: string };
    },
  ): Promise<SignupOrganizationResult> {
    await this.organizationsService.createInTransaction(
      tx,
      {
        organizationId: input.organizationId,
        userId: input.owner.id,
        name: input.prepared.organizationName,
        onboardingCompletedAt: null,
        // W4 — a name conflict is reported on the signup form's field.
        nameField: 'organizationName',
      },
      (innerTx, created) =>
        this.subscriptionBootstrapService.bootstrapSubscription(innerTx, created.id),
    );

    if (input.prepared.trialPlanId === null) {
      return { organizationId: input.organizationId, trialStarted: false, outboxIds: [] };
    }

    // Re-resolved INSIDE the transaction's lifetime: a plan archived between
    // `prepare` and here is refused, and the whole signup rolls back.
    const resolved = await this.trialRedemptionService.resolveSignupTrialPlan(
      input.prepared.trialPlanId,
    );
    const trial = await this.trialRedemptionService.grantSignupTrialInTransaction(tx, {
      organizationId: input.organizationId,
      owner: input.owner,
      resolved,
      context: input.context,
    });
    return {
      organizationId: input.organizationId,
      trialStarted: trial.started,
      outboxIds: trial.outboxId ? [trial.outboxId] : [],
    };
  }

  async afterCommit(result: SignupOrganizationResult): Promise<void> {
    try {
      await this.tenantUsageRecomputeProducer.enqueueOne(result.organizationId);
    } catch (error) {
      this.logger.warn(
        {
          organizationId: result.organizationId,
          error: error instanceof Error ? error.message : error,
        },
        'Could not enqueue the usage recompute for a signup organization; the periodic sweep will cover it.',
      );
    }
  }
}
