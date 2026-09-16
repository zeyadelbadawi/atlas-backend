/**
 * PlatformPlansService — Platform-Owner administration of the plan catalog
 * (P57). Create, edit and archive; deliberately NO hard delete.
 *
 * WHY NO DELETE. `TenantSubscription.planId` is a foreign key with no
 * `onDelete`, so Postgres applies RESTRICT: a plan any organization has
 * ever subscribed to genuinely cannot be deleted, and asking the database
 * to try would surface as a raw constraint error. `PlanCommissionSettings`
 * meanwhile cascades, so a "successful" delete of an unused plan would
 * silently take its commission configuration with it. Atlas already has a
 * deactivation idiom that is safe in both cases — `status` plus the
 * `displayOrder > 0` half of `PlansRepository.CUSTOMER_FACING_WHERE` — so
 * archiving is what this service exposes.
 *
 * PRICE HISTORY IS THE AUDIT LOG, not a second table. Two facts settle it:
 * completed money already snapshots itself (`Payment.amountMinorUnits`/
 * `currency`, `Checkout.snapshot`, `CourseOrder.snapshot`), so historical
 * billing can never be made ambiguous by editing catalog pricing; and a
 * price history IS a change log, which is precisely what
 * `audit_log_entries` is. Every mutation here writes one entry carrying a
 * structured `{field: {from, to}}` diff, inside the caller's own
 * transaction, indexed by the existing `@@index([targetType, targetId])`.
 * A dedicated `plan_price_history` table would duplicate that store.
 *
 * CONCURRENCY. `version` goes into the UPDATE's WHERE clause so the
 * DATABASE decides the race, and a miss raises
 * `StaleResourceVersionException` (409, `stale_resource_version`) — the
 * same contract `add_ons` (P51) and the website page editor already use.
 *
 * NO RLS ON `plans`. Deliberate and pre-existing: the plan catalog is
 * platform-owned rather than tenant-owned, exactly like `add_ons`,
 * `trial_policy` and `platform_settings`, none of which carry RLS.
 * `PlatformOwnerGuard` is the real boundary, re-reading the user's
 * `is_platform_owner` column on every request.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { AuditFieldChange } from '../../audit-log/services/audit-log-writer.service';
import { StaleResourceVersionException } from '../../concurrency/errors/stale-resource-version.exception';
import { toPlanResponse } from '../../plans/dto/plan.contract';
import type { PlanResponse } from '../../plans/dto/plan.contract';
import {
  assertValidFeatures,
  assertValidLimits,
} from '../dto/update-plan.dto';
import type {
  ArchivePlanDto,
  CreatePlanDto,
  UpdatePlanDto,
} from '../dto/update-plan.dto';
import { PLAN_LIMIT_KEYS } from '../../plans/dto/entitlement.types';
import type { PlanLimitKey } from '../../plans/dto/entitlement.types';

/**
 * Organizations whose CURRENT usage already exceeds a proposed limit.
 *
 * Read from `tenant_usage`, which is a worker-recomputed SNAPSHOT rather
 * than a live count — so this is reported with the snapshot's own
 * timestamp rather than presented as real-time truth. `recordedSessions`
 * is deliberately absent from `tenant_usage` (it is not a counter; see
 * that model's own note), so it can never be impact-checked and is
 * reported as such instead of as a misleading zero.
 */
export interface PlanLimitImpactRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly limitKey: string;
  readonly currentUsage: number;
  readonly proposedLimit: number;
}

export interface PlanLimitImpactResponse {
  readonly affected: readonly PlanLimitImpactRow[];
  /** Limit keys this check genuinely cannot measure. */
  readonly unmeasurableLimitKeys: readonly string[];
  /** Oldest usage-snapshot timestamp involved, so the UI can say how fresh this is. */
  readonly usageAsOf?: string;
  /**
   * P61 — subscribers whose entitlement was captured at purchase and is
   * therefore NOT changed by this edit at all. Reported so the editor can
   * say plainly how many customers this edit does not reach, instead of
   * leaving the Platform Owner to assume it reaches everyone.
   */
  readonly protectedSubscriptions: number;
  /** Subscribers still following the live catalog — the ones this edit does reach. */
  readonly catalogFollowingSubscriptions: number;
}

/** `tenant_usage` column per measurable limit key. `recordedSessions` has none, on purpose. */
const USAGE_COLUMN: Partial<Record<PlanLimitKey, keyof UsageRow>> = {
  academies: 'academies',
  students: 'students',
  instructors: 'instructors',
  staff: 'staff',
  courses: 'courses',
  generalStorage: 'generalStorageGb',
  videoStorage: 'videoStorageGb',
};

interface UsageRow {
  organizationId: string;
  academies: number;
  students: number;
  instructors: number;
  staff: number;
  courses: number;
  generalStorageGb: number;
  videoStorageGb: number;
  updatedAt: Date;
}

@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  private assertCatalogShape(
    limits?: Record<string, unknown>,
    features?: Record<string, unknown>,
  ): void {
    const errors = [
      ...(limits ? assertValidLimits(limits) : []),
      ...(features ? assertValidFeatures(features) : []),
    ];
    if (errors.length > 0) {
      throw new BadRequestException({
        messageKey: 'errors.validation.failed',
        details: errors,
      });
    }
  }

  async create(platformOwnerId: string, payload: CreatePlanDto): Promise<PlanResponse> {
    this.assertCatalogShape(payload.limits, payload.features);

    const existing = await this.prisma.plan.findUnique({
      where: { key: payload.key },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({ messageKey: 'errors.plan.keyTaken' });
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.plan.create({
        data: {
          key: payload.key,
          name: payload.name,
          description: payload.description,
          nameLocalized: payload.nameLocalized as unknown as Prisma.InputJsonValue,
          descriptionLocalized:
            payload.descriptionLocalized as unknown as Prisma.InputJsonValue,
          displayOrder: payload.displayOrder,
          limits: payload.limits as unknown as Prisma.InputJsonValue,
          features: payload.features as unknown as Prisma.InputJsonValue,
          pricing: payload.pricing as unknown as Prisma.InputJsonValue,
          trialEligible: payload.trialEligible ?? false,
          trialDurationDays: payload.trialDurationDays ?? null,
        },
      });

      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        action: 'plan.created',
        targetType: 'plan',
        targetId: created.id,
        targetLabel: created.name,
        context: { key: created.key },
      });

      return toPlanResponse(created);
    });
  }

  /**
   * One PATCH for every editable facet, emitting a SEPARATE audit action per
   * facet that changed.
   *
   * Pricing gets its own `plan.pricing_changed` action rather than being
   * folded into a generic `plan.updated`, because that is what makes price
   * history queryable: the Plan Management UI filters the audit log by
   * `action`, and a single blended action would force it to parse every
   * plan edit to find the price ones.
   */
  async update(
    platformOwnerId: string,
    key: string,
    payload: UpdatePlanDto,
  ): Promise<PlanResponse> {
    this.assertCatalogShape(payload.limits, payload.features);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.plan.findUnique({ where: { key } });
      if (!existing) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }

      const data: Prisma.PlanUpdateInput = {};
      const generalChanges: Record<string, AuditFieldChange> = {};
      const pricingChanges: Record<string, AuditFieldChange> = {};
      const trialChanges: Record<string, AuditFieldChange> = {};

      const track = (
        bucket: Record<string, AuditFieldChange>,
        field: string,
        from: unknown,
        to: unknown,
      ): void => {
        if (JSON.stringify(from) === JSON.stringify(to)) return;
        bucket[field] = { from: from ?? null, to: to ?? null };
      };

      if (payload.name !== undefined) {
        track(generalChanges, 'name', existing.name, payload.name);
        data.name = payload.name;
      }
      if (payload.description !== undefined) {
        track(generalChanges, 'description', existing.description, payload.description);
        data.description = payload.description;
      }
      if (payload.nameLocalized !== undefined) {
        track(generalChanges, 'nameLocalized', existing.nameLocalized, payload.nameLocalized);
        data.nameLocalized = payload.nameLocalized as unknown as Prisma.InputJsonValue;
      }
      if (payload.descriptionLocalized !== undefined) {
        track(
          generalChanges,
          'descriptionLocalized',
          existing.descriptionLocalized,
          payload.descriptionLocalized,
        );
        data.descriptionLocalized =
          payload.descriptionLocalized as unknown as Prisma.InputJsonValue;
      }
      if (payload.displayOrder !== undefined) {
        track(generalChanges, 'displayOrder', existing.displayOrder, payload.displayOrder);
        data.displayOrder = payload.displayOrder;
      }
      if (payload.limits !== undefined) {
        track(generalChanges, 'limits', existing.limits, payload.limits);
        data.limits = payload.limits as unknown as Prisma.InputJsonValue;
      }
      if (payload.features !== undefined) {
        track(generalChanges, 'features', existing.features, payload.features);
        data.features = payload.features as unknown as Prisma.InputJsonValue;
      }
      if (payload.pricing !== undefined) {
        track(pricingChanges, 'pricing', existing.pricing, payload.pricing);
        data.pricing = payload.pricing as unknown as Prisma.InputJsonValue;
      }
      if (payload.trialEligible !== undefined) {
        track(trialChanges, 'trialEligible', existing.trialEligible, payload.trialEligible);
        data.trialEligible = payload.trialEligible;
      }
      if (payload.trialDurationDays !== undefined) {
        track(
          trialChanges,
          'trialDurationDays',
          existing.trialDurationDays,
          payload.trialDurationDays,
        );
        data.trialDurationDays = payload.trialDurationDays;
      }

      const changedCount =
        Object.keys(generalChanges).length +
        Object.keys(pricingChanges).length +
        Object.keys(trialChanges).length;

      // A no-op edit still validates the version, so a stale client is told
      // it is stale rather than being silently told "saved".
      const result = await tx.plan.updateMany({
        where: { id: existing.id, version: payload.expectedVersion },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count === 0) {
        const current = await tx.plan.findUnique({
          where: { id: existing.id },
          select: { version: true },
        });
        throw new StaleResourceVersionException({
          submittedVersion: payload.expectedVersion,
          currentVersion: current?.version ?? payload.expectedVersion,
        });
      }

      // One entry per facet, in the same transaction as the write: if the
      // update rolls back, so does its history.
      if (Object.keys(pricingChanges).length > 0) {
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          action: 'plan.pricing_changed',
          targetType: 'plan',
          targetId: existing.id,
          targetLabel: existing.name,
          context: { key: existing.key },
          changes: pricingChanges,
        });
      }
      if (Object.keys(trialChanges).length > 0) {
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          action: 'plan.trial_config_changed',
          targetType: 'plan',
          targetId: existing.id,
          targetLabel: existing.name,
          context: { key: existing.key },
          changes: trialChanges,
        });
      }
      if (Object.keys(generalChanges).length > 0) {
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          action: 'plan.updated',
          targetType: 'plan',
          targetId: existing.id,
          targetLabel: existing.name,
          context: { key: existing.key },
          changes: generalChanges,
        });
      }

      const updated = await tx.plan.findUniqueOrThrow({ where: { id: existing.id } });
      void changedCount;
      return toPlanResponse(updated);
    });
  }

  /**
   * Archive — the safe counterpart of deletion.
   *
   * Sets `status: 'archived'` AND `displayOrder: 0`, because
   * `CUSTOMER_FACING_WHERE` filters on both; setting only one would leave
   * the plan reachable through the other half of the predicate. Existing
   * subscriptions are untouched: an organization already on the plan keeps
   * its entitlements, which is the whole reason archiving exists instead of
   * deleting.
   */
  async archive(
    platformOwnerId: string,
    key: string,
    payload: ArchivePlanDto,
  ): Promise<PlanResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.plan.findUnique({ where: { key } });
      if (!existing) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      if (existing.status === 'archived') {
        throw new ConflictException({ messageKey: 'errors.plan.alreadyArchived' });
      }

      const result = await tx.plan.updateMany({
        where: { id: existing.id, version: payload.expectedVersion },
        data: { status: 'archived', displayOrder: 0, version: { increment: 1 } },
      });
      if (result.count === 0) {
        const current = await tx.plan.findUnique({
          where: { id: existing.id },
          select: { version: true },
        });
        throw new StaleResourceVersionException({
          submittedVersion: payload.expectedVersion,
          currentVersion: current?.version ?? payload.expectedVersion,
        });
      }

      const subscriptions = await tx.tenantSubscription.count({
        where: { planId: existing.id },
      });

      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        action: 'plan.archived',
        targetType: 'plan',
        targetId: existing.id,
        targetLabel: existing.name,
        context: {
          key: existing.key,
          // Recorded because it is the fact that matters when reading this
          // entry later: archiving a plan someone is still on is legitimate
          // but consequential.
          subscriptionsAtArchive: subscriptions,
        },
        changes: {
          status: { from: existing.status, to: 'archived' },
          displayOrder: { from: existing.displayOrder, to: 0 },
        },
      });

      const updated = await tx.plan.findUniqueOrThrow({ where: { id: existing.id } });
      return toPlanResponse(updated);
    });
  }

  /**
   * Which organizations already exceed a proposed limit set.
   *
   * WARN, NEVER ENFORCE. Nothing here changes data or blocks the edit — the
   * Platform Owner may still proceed. Atlas's entitlement enforcement is
   * create-path-only (`assertWithinLimit`/`assertStorageWithinLimit` throw
   * `409 errors.entitlement.limitReached` on new courses, enrollments,
   * academies and uploads) and never deletes or disables anything, so an
   * organization that ends up over a reduced limit keeps everything it has
   * and is simply refused the NEXT create. This endpoint exists so that
   * consequence is visible before saving instead of discovered afterwards.
   *
   * NARROWED BY P61, AND THIS IS THE HONEST PART. A subscription that
   * recorded what it was granted is not affected by a catalog edit at all —
   * its limits come from `granted_limits`, not from this plan row. Counting
   * those customers as "affected" would have made the warning say something
   * untrue: that the edit restricts people it cannot reach. Only
   * subscribers still following the live catalog (no recorded grant) can be
   * affected, so only they are inspected, and the protected count is
   * reported alongside so the number is explainable rather than merely
   * smaller.
   */
  async previewLimitImpact(
    platformOwnerId: string,
    key: string,
    proposedLimits: Record<string, number | 'unlimited'>,
  ): Promise<PlanLimitImpactResponse> {
    const errors = assertValidLimits(proposedLimits);
    if (errors.length > 0) {
      throw new BadRequestException({
        messageKey: 'errors.validation.failed',
        details: errors,
      });
    }

    const plan = await this.prisma.plan.findUnique({
      where: { key },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const allSubscriptions = await tx.tenantSubscription.findMany({
        where: { planId: plan.id },
        select: {
          organizationId: true,
          grantedLimits: true,
          organization: { select: { name: true } },
        },
      });

      // A recorded grant means this edit cannot change that customer's
      // entitlement, so they are counted and then set aside — never
      // inspected for "impact" they are structurally immune to.
      const subscriptions = allSubscriptions.filter((s) => s.grantedLimits === null);
      const protectedSubscriptions = allSubscriptions.length - subscriptions.length;

      if (subscriptions.length === 0) {
        return {
          affected: [],
          unmeasurableLimitKeys: this.unmeasurableKeys(proposedLimits),
          protectedSubscriptions,
          catalogFollowingSubscriptions: 0,
        };
      }

      const usageRows = (await tx.tenantUsage.findMany({
        where: { organizationId: { in: subscriptions.map((s) => s.organizationId) } },
      })) as unknown as UsageRow[];
      const usageById = new Map(usageRows.map((row) => [row.organizationId, row]));

      const affected: PlanLimitImpactRow[] = [];
      for (const subscription of subscriptions) {
        const usage = usageById.get(subscription.organizationId);
        if (!usage) continue;
        for (const limitKey of PLAN_LIMIT_KEYS) {
          const column = USAGE_COLUMN[limitKey];
          if (!column) continue;
          const proposed = proposedLimits[limitKey];
          if (proposed === undefined || proposed === 'unlimited') continue;
          const current = usage[column] as number;
          if (typeof current === 'number' && current > proposed) {
            affected.push({
              organizationId: subscription.organizationId,
              organizationName: subscription.organization?.name ?? '',
              limitKey,
              currentUsage: current,
              proposedLimit: proposed,
            });
          }
        }
      }

      const oldest = usageRows
        .map((row) => row.updatedAt)
        .sort((a, b) => a.getTime() - b.getTime())[0];

      return {
        affected,
        unmeasurableLimitKeys: this.unmeasurableKeys(proposedLimits),
        usageAsOf: oldest ? oldest.toISOString() : undefined,
        protectedSubscriptions,
        catalogFollowingSubscriptions: subscriptions.length,
      };
    });
  }

  /** Limit keys with no `tenant_usage` counterpart — reported honestly rather than shown as zero impact. */
  private unmeasurableKeys(
    proposedLimits: Record<string, number | 'unlimited'>,
  ): readonly string[] {
    return PLAN_LIMIT_KEYS.filter(
      (limitKey) =>
        !USAGE_COLUMN[limitKey] &&
        proposedLimits[limitKey] !== undefined &&
        proposedLimits[limitKey] !== 'unlimited',
    );
  }
}
