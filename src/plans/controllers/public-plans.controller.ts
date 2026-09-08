/**
 * PublicPlansController — `/public/plans`. Deliberately separate from
 * `PlansController` (`/plans`, `JwtAuthGuard` + `SaasLevelCallerGuard`):
 * this one has NO auth guard at all, by design — it exists so the
 * unauthenticated platform marketing site can render real pricing
 * without asking a visitor to sign in first.
 *
 * Reuses `PlansRepository.findAll()` verbatim — the exact same
 * customer-facing catalog query (`status: 'active'`, `displayOrder: {gt:
 * 0}`, already excludes e2e-test-fixture plans) `PlansController` itself
 * relies on — and the exact same `toPlanResponse` mapper, so the
 * marketing site and the authenticated dashboard can never see two
 * different shapes of the same data. No new query, no new DTO, no
 * duplicated business logic — matches this codebase's own established
 * "public-safe, read-only, lightweight" pattern already used for the
 * academy public-website statistics endpoint (master plan §2.1): never
 * anything sensitive (no revenue, no another org's data), same principle
 * applied to the platform's own plan catalog instead of an academy's.
 */
import { Controller, Get } from '@nestjs/common';
import { PlansRepository } from '../repositories/plans.repository';
import { toPlanResponse } from '../dto/plan.contract';
import type { PlanResponse } from '../dto/plan.contract';

@Controller('public/plans')
export class PublicPlansController {
  constructor(private readonly plansRepository: PlansRepository) {}

  @Get()
  async list(): Promise<PlanResponse[]> {
    const plans = await this.plansRepository.findAll();
    return plans.map(toPlanResponse);
  }
}
