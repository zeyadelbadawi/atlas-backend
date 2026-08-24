/**
 * PlansService — the catalog + trial-policy read/write surface, mirroring
 * `PlanService` (atlas frontend). Houses Add-on catalog reads and
 * Trial Policy read/write for the same reason the frontend service does:
 * platform-catalog-scoped, not tenant-scoped, and a standalone service for
 * either would only ever hold one or two methods (see `PlanService.ts`'s
 * own doc comment).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PlansRepository } from '../repositories/plans.repository';
import { AddOnsRepository } from '../repositories/add-ons.repository';
import { TrialPolicyRepository } from '../repositories/trial-policy.repository';
import { toPlanResponse } from '../dto/plan.contract';
import type { PlanResponse } from '../dto/plan.contract';
import { toAddOnResponse } from '../dto/add-on.contract';
import type { AddOnResponse } from '../dto/add-on.contract';
import { toTrialPolicyResponse } from '../dto/trial-policy.contract';
import type { TrialPolicyResponse } from '../dto/trial-policy.contract';

@Injectable()
export class PlansService {
  constructor(
    private readonly plansRepository: PlansRepository,
    private readonly addOnsRepository: AddOnsRepository,
    private readonly trialPolicyRepository: TrialPolicyRepository,
  ) {}

  async getPlans(): Promise<PlanResponse[]> {
    const plans = await this.plansRepository.findAll();
    return plans.map(toPlanResponse);
  }

  async getPlanByKey(key: string): Promise<PlanResponse> {
    const plan = await this.plansRepository.findByKey(key);
    if (!plan) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toPlanResponse(plan);
  }

  async getAddOns(): Promise<AddOnResponse[]> {
    const addOns = await this.addOnsRepository.findAll();
    return addOns.map(toAddOnResponse);
  }

  async getAddOnByKey(key: string): Promise<AddOnResponse> {
    const addOn = await this.addOnsRepository.findByKey(key);
    if (!addOn) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toAddOnResponse(addOn);
  }

  async getTrialPolicy(): Promise<TrialPolicyResponse> {
    const policy = await this.trialPolicyRepository.findSingleton();
    return toTrialPolicyResponse(policy);
  }

  async updateTrialPolicy(
    enabled: boolean,
    durationDays: number,
  ): Promise<TrialPolicyResponse> {
    const policy = await this.trialPolicyRepository.update(enabled, durationDays);
    return toTrialPolicyResponse(policy);
  }
}
