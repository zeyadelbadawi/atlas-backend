import type { PlanResponse } from '../../plans/dto/plan.contract';
import type { PlanSubscriberCounts } from '../services/plan-subscriber-counts.service';

/**
 * Item 9 (plan management) — one row of the Platform Owner plan list: the
 * plan as every other endpoint returns it, plus who is on it
 * (`PlanSubscriberCountsService`) and when it last changed.
 */
export interface PlatformPlanRow extends PlanResponse {
  readonly subscribers: PlanSubscriberCounts;
  readonly createdAt: string;
  readonly updatedAt: string;
}
