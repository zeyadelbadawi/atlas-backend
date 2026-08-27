/**
 * PlanCommissionSettingsRepository — `plan_commission_settings` (Phase
 * P13, master plan §4.2's plan-tier extension). Platform-owned,
 * catalog-adjacent, no RLS — mirrors `AtlasCommissionConfigRepository`'s
 * exact "no tenant context needed" shape, not `OrganizationCommissionSettingsRepository`'s
 * (which needs a tenant/user RLS context because Organizations may read
 * their own row). Nothing here is Organization-readable directly; a
 * Plan's resolved commission is surfaced only through
 * `CommissionService`'s effective-resolution response, never this raw row.
 */
import { Injectable } from '@nestjs/common';
import type { PlanCommissionSettings } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class PlanCommissionSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByPlanId(planId: string): Promise<PlanCommissionSettings | null> {
    return this.prisma.planCommissionSettings.findUnique({ where: { planId } });
  }

  /** Row absence IS "not configured" (see schema.prisma's own doc comment) — this repository has no delete/unset path, matching `AtlasCommissionConfigRepository.setDefault`'s identical "settable to a real integer only" precedent. A future "clear the plan override" capability would be a real, separate, explicit delete method, not implied by this one. */
  upsert(
    planId: string,
    commissionBasisPoints: number,
    updatedBy: string,
  ): Promise<PlanCommissionSettings> {
    return this.prisma.planCommissionSettings.upsert({
      where: { planId },
      create: { planId, commissionBasisPoints, updatedBy },
      update: { commissionBasisPoints, updatedBy },
    });
  }
}
