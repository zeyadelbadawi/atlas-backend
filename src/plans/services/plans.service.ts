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
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../../common/dto/collection-query.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Injectable()
export class PlansService {
  constructor(
    private readonly plansRepository: PlansRepository,
    private readonly addOnsRepository: AddOnsRepository,
    private readonly trialPolicyRepository: TrialPolicyRepository,
  ) {}

  /** Phase 4.5.3 (Change 4) — paginated; see `PlansRepository.findManyPaginated`'s own doc comment for why. */
  async getPlans(query: CollectionQueryDto): Promise<PaginatedResult<PlanResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, totalItems } = await this.plansRepository.findManyPaginated(
      (page - 1) * pageSize,
      pageSize,
    );
    return {
      items: items.map(toPlanResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
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
