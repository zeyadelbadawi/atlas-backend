/**
 * `GET /public/signup-options` — what the one-page signup may offer
 * (docs/NEW_CUSTOMER_ONBOARDING.md §3.1). No auth, like `GET /public/plans`:
 * everything here is already-public catalog data plus two booleans.
 *
 * Server-driven on purpose: the frontend's own flags are fixed at build
 * time, so reading the rollout switch from here is what lets
 * `FLAG_SIGNUP_ORGANIZATION_MODE=off` roll the signup back without a
 * frontend redeploy.
 */
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlansRepository } from '../../plans/repositories/plans.repository';
import { TrialPolicyRepository } from '../../plans/repositories/trial-policy.repository';
import { toPlanResponse } from '../../plans/dto/plan.contract';
import type { IdentityConfig } from '../../config/configuration';
import type { SignupOptionsResponse } from '../dto/onboarding.contract';

@Controller('public/signup-options')
export class PublicSignupOptionsController {
  constructor(
    private readonly configService: ConfigService,
    private readonly plansRepository: PlansRepository,
    private readonly trialPolicyRepository: TrialPolicyRepository,
  ) {}

  @Get()
  async get(): Promise<SignupOptionsResponse> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const [plans, policy] = await Promise.all([
      // Active + customer-facing (`displayOrder > 0`) — the same set
      // `GET /public/plans` shows; `resolveSignupTrialPlan` enforces the
      // same floor on submit.
      this.plansRepository.findAll(),
      this.trialPolicyRepository.findSingleton(),
    ]);
    return {
      organizationSignup: identity.signupOrganizationMode === 'on',
      trialsEnabled: policy.enabled,
      trialPlans: policy.enabled
        ? plans
            .filter((plan) => plan.trialEligible)
            .map((plan) => toPlanResponse(plan, policy.durationDays))
        : [],
    };
  }
}
