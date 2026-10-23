/**
 * FoundingMembershipsService — B2: the Platform Owner's management of the
 * Founding Academies programme (the first 20 paying academies, annual
 * price locked for 24 months).
 *
 * CONTEXT. Every read and write runs in the Platform Owner's user context
 * (`runInUserContext`): `founding_memberships` RLS admits Platform Owners
 * only for writes, and the organizations, subscriptions and contact
 * requests it joins are read through their existing `_platform_select`
 * policies — never with RLS switched off. Who may call is decided by
 * `PlatformOwnerGuard` on the controller.
 *
 * SEATS. A create takes a transaction-scoped advisory lock first, so two
 * concurrent creates queue: the second sees the first's seat, and the 21st
 * is refused. The partial unique index on `seat_number` (non-revoked) and
 * the 1..20 CHECK are the database backstop.
 *
 * PRICE. The locked price is always the plan's live annual catalog price
 * at the moment of the action (create, or a plan change), read here —
 * never accepted from the client. Checkout applies it (`founding-lock.ts`).
 *
 * AUDIT. Every mutation writes its audit row in the same transaction;
 * an email send writes one per recipient.
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Plan } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { EmailProviderRegistry } from '../../communications/providers/email-provider.registry';
import {
  EmailQuotaService,
  categoryLine,
} from '../../communications/services/email-quota.service';
import { readOptedInOrganizationOwnerPhones } from '../../identity/phone/user-phone.service';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import {
  FOUNDING_CONCIERGE_HOURS_CAP,
  FOUNDING_SEAT_CAP,
  FOUNDING_WEEKLY_ONBOARDING_TARGET,
  catalogAnnualPrice,
  expectedPurchasePeriodStart,
  foundingPriceFor,
  lockEndFor,
  toFoundingLock,
} from '../founding-lock';
import type {
  CreateFoundingMembershipDto,
  FoundingEmailAudienceDto,
  ListFoundingMembershipsQueryDto,
  RevokeFoundingMembershipDto,
  SendFoundingEmailDto,
  UpdateFoundingMembershipDto,
} from '../dto/founding.dto';
import type {
  FoundingCandidate,
  FoundingEligiblePlan,
  FoundingEmailPreview,
  FoundingEmailSendResult,
  FoundingMembershipDetail,
  FoundingMembershipSummary,
  FoundingMoney,
  FoundingNextRenewal,
  FoundingPlanRef,
  FoundingQuote,
  FoundingSeatSummary,
  FoundingSubscriptionRef,
  FoundingTimelineEntry,
} from '../dto/founding.contract';

const TARGET_TYPE = 'founding_membership';
const SEAT_LOCK_KEY = 'founding_memberships:seats';
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_START_WINDOW_MS = 366 * DAY_MS;
const ROLE = 'platform_owner';

export const FOUNDING_AUDIT = {
  created: 'platform.founding.created',
  updated: 'platform.founding.updated',
  planChanged: 'platform.founding.plan_changed',
  revoked: 'platform.founding.revoked',
  ended: 'platform.founding.ended',
  emailed: 'platform.founding.emailed',
  noticeSent: 'platform.founding.renewal_price_notice_sent',
} as const;

const MEMBERSHIP_INCLUDE = {
  plan: true,
  organization: {
    select: {
      id: true,
      name: true,
      owner: { select: { name: true, email: true } },
      subscription: {
        select: {
          status: true,
          billingCycle: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          plan: { select: { key: true, name: true } },
        },
      },
    },
  },
} satisfies Prisma.FoundingMembershipInclude;

type MembershipRow = Prisma.FoundingMembershipGetPayload<{
  include: typeof MEMBERSHIP_INCLUDE;
}>;

type SubscriptionSelect = NonNullable<MembershipRow['organization']['subscription']>;

/** Monday 00:00 in Africa/Cairo, as an instant. */
export function cairoWeekStart(now: Date): Date {
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  const offset = local.getTime() - now.getTime();
  const start = new Date(local);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return new Date(start.getTime() - offset);
}

/** One CSV cell: quoted, and a leading formula character neutralised. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function planRef(plan: Plan): FoundingPlanRef {
  const localized = plan.nameLocalized as { en?: string; ar?: string } | null;
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    ...(localized && (localized.en || localized.ar)
      ? { nameLocalized: { en: localized.en, ar: localized.ar } }
      : {}),
  };
}

function subscriptionRef(
  sub: SubscriptionSelect | null,
): FoundingSubscriptionRef | undefined {
  if (!sub) return undefined;
  return {
    status: sub.status,
    ...(sub.billingCycle ? { billingCycle: sub.billingCycle } : {}),
    planKey: sub.plan.key,
    planName: sub.plan.name,
    ...(sub.currentPeriodEnd
      ? { currentPeriodEnd: sub.currentPeriodEnd.toISOString() }
      : {}),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

/** Strips header-breaking characters from a subject line. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

@Injectable()
export class FoundingMembershipsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
    private readonly emailProviderRegistry: EmailProviderRegistry,
    private readonly emailQuotaService: EmailQuotaService,
  ) {}

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async list(
    platformOwnerId: string,
    query: ListFoundingMembershipsQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResult<FoundingMembershipSummary>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where = this.listWhere(query);
    const direction =
      query.sortDirection ?? (query.sortBy === 'createdAt' ? 'desc' : 'asc');
    const orderBy: Prisma.FoundingMembershipOrderByWithRelationInput[] =
      query.sortBy === 'organizationName'
        ? [{ organization: { name: direction } }]
        : query.sortBy === 'createdAt'
          ? [{ createdAt: direction }]
          : query.sortBy === 'lockEndsAt'
            ? [{ lockEndsAt: direction }]
            : [{ seatNumber: direction }];
    orderBy.push({ id: 'asc' });

    const { rows, total } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => ({
        rows: await tx.foundingMembership.findMany({
          where,
          include: MEMBERSHIP_INCLUDE,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        total: await tx.foundingMembership.count({ where }),
      }),
    );
    return {
      items: rows.map((row) => this.toSummary(row, now)),
      pagination: buildPaginationMeta(page, pageSize, total),
    };
  }

  async summary(
    platformOwnerId: string,
    now: Date = new Date(),
  ): Promise<FoundingSeatSummary> {
    const weekStartsAt = cairoWeekStart(now);
    const { grouped, thisWeek } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => ({
        grouped: await tx.foundingMembership.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        thisWeek: await tx.foundingMembership.count({
          where: { createdAt: { gte: weekStartsAt }, status: { not: 'revoked' } },
        }),
      }),
    );
    const count = (status: string) =>
      grouped.find((row) => row.status === status)?._count._all ?? 0;
    const taken = count('active') + count('ended');
    return {
      seatCap: FOUNDING_SEAT_CAP,
      seatsTaken: taken,
      seatsAvailable: Math.max(FOUNDING_SEAT_CAP - taken, 0),
      onboardedThisWeek: thisWeek,
      weeklyTarget: FOUNDING_WEEKLY_ONBOARDING_TARGET,
      weekStartsAt: weekStartsAt.toISOString(),
      counts: {
        active: count('active'),
        ended: count('ended'),
        revoked: count('revoked'),
      },
    };
  }

  async get(
    platformOwnerId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<FoundingMembershipDetail> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.loadDetail(tx, id, now),
    );
  }

  /** Catalog plans a membership can lock: self-serve family plans with an annual price. */
  async eligiblePlans(platformOwnerId: string): Promise<FoundingEligiblePlan[]> {
    const plans = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        tx.plan.findMany({
          where: { status: 'active', family: 'normal', displayOrder: { gt: 0 } },
          orderBy: { displayOrder: 'asc' },
        }),
    );
    return plans.flatMap((plan) => {
      const annualPrice = catalogAnnualPrice(plan.pricing);
      return annualPrice ? [{ ...planRef(plan), annualPrice }] : [];
    });
  }

  /** Organizations that could be added (no seat held), by name or owner. */
  async candidates(
    platformOwnerId: string,
    search?: string,
  ): Promise<FoundingCandidate[]> {
    const term = search?.trim();
    const rows = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        tx.organization.findMany({
          where: {
            status: 'active',
            foundingMemberships: { none: { status: { not: 'revoked' } } },
            ...(term
              ? {
                  OR: [
                    { name: { contains: term, mode: 'insensitive' } },
                    { owner: { name: { contains: term, mode: 'insensitive' } } },
                    { owner: { email: { contains: term, mode: 'insensitive' } } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            name: true,
            owner: { select: { name: true, email: true } },
            subscription: {
              select: MEMBERSHIP_INCLUDE.organization.select.subscription.select,
            },
          },
          orderBy: { name: 'asc' },
          take: 20,
        }),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerName: row.owner.name,
      ownerEmail: row.owner.email,
      ...(row.subscription ? { subscription: subscriptionRef(row.subscription) } : {}),
    }));
  }

  /** What a create would lock for this organization and plan, without writing anything. */
  async quote(
    platformOwnerId: string,
    organizationId: string,
    planKey: string,
  ): Promise<FoundingQuote> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const organization = await this.loadOrganizationOrThrow(tx, organizationId);
      const { plan, price } = await this.loadEligiblePlanOrThrow(tx, planKey);
      const held = await tx.foundingMembership.findMany({
        where: { status: { not: 'revoked' } },
        select: { seatNumber: true, organizationId: true },
      });
      return {
        organization: { id: organization.id, name: organization.name },
        owner: { name: organization.owner.name, email: organization.owner.email },
        plan: planRef(plan),
        lockedPrice: price,
        nextSeatNumber: this.lowestFreeSeat(held.map((row) => row.seatNumber)),
        alreadyMember: held.some((row) => row.organizationId === organizationId),
        ...(organization.subscription
          ? { subscription: subscriptionRef(organization.subscription) }
          : {}),
      };
    });
  }

  async exportCsv(platformOwnerId: string, now: Date = new Date()): Promise<string> {
    const rows = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        tx.foundingMembership.findMany({
          include: MEMBERSHIP_INCLUDE,
          orderBy: [{ status: 'asc' }, { seatNumber: 'asc' }],
        }),
    );
    const header = [
      'seat',
      'status',
      'academy',
      'owner_name',
      'owner_email',
      'plan',
      'locked_annual_price',
      'currency',
      'lock_starts_at',
      'lock_ends_at',
      'subscription_status',
      'current_period_end',
      'next_renewal_amount',
      'next_renewal_locked',
      'concierge_hours_used',
      'created_at',
    ];
    const lines = rows.map((row) => {
      const summary = this.toSummary(row, now);
      return [
        summary.seatNumber,
        summary.status,
        summary.organization.name,
        summary.owner.name,
        summary.owner.email,
        summary.plan.key,
        summary.lockedPrice.amount,
        summary.lockedPrice.currency,
        summary.lockStartsAt,
        summary.lockEndsAt,
        summary.subscription?.status ?? '',
        summary.subscription?.currentPeriodEnd ?? '',
        summary.nextRenewal?.amount ?? '',
        summary.nextRenewal ? String(summary.nextRenewal.locked) : '',
        summary.conciergeHoursUsed,
        summary.createdAt,
      ]
        .map(csvCell)
        .join(',');
    });
    return `${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async create(
    platformOwnerId: string,
    payload: CreateFoundingMembershipDto,
    now: Date = new Date(),
  ): Promise<FoundingMembershipDetail> {
    const lockStartsAt = payload.lockStartsAt ? new Date(payload.lockStartsAt) : now;
    if (Math.abs(lockStartsAt.getTime() - now.getTime()) > LOCK_START_WINDOW_MS) {
      throw new BadRequestException({
        messageKey: 'errors.founding.lockStartOutOfRange',
      });
    }

    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      // Serialise every seat assignment: a concurrent create waits here and
      // then sees this one's committed seat.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SEAT_LOCK_KEY}, 0))`;

      const organization = await this.loadOrganizationOrThrow(tx, payload.organizationId);
      const { plan, price } = await this.loadEligiblePlanOrThrow(tx, payload.planKey);

      const held = await tx.foundingMembership.findMany({
        where: { status: { not: 'revoked' } },
        select: { seatNumber: true, organizationId: true },
      });
      if (held.some((row) => row.organizationId === organization.id)) {
        throw new ConflictException({ messageKey: 'errors.founding.alreadyMember' });
      }
      const seatNumber = this.lowestFreeSeat(held.map((row) => row.seatNumber));
      if (seatNumber === null) {
        throw new ConflictException({ messageKey: 'errors.founding.seatsFull' });
      }

      if (payload.sourceContactSubmissionId) {
        await this.linkContactOrThrow(
          tx,
          platformOwnerId,
          payload.sourceContactSubmissionId,
          payload.markContactHandled === true,
          now,
        );
      }

      const lockEndsAt = lockEndFor(lockStartsAt);
      let created;
      try {
        created = await tx.foundingMembership.create({
          data: {
            organizationId: organization.id,
            seatNumber,
            planId: plan.id,
            lockedAmount: new Prisma.Decimal(price.amount),
            lockedCurrency: price.currency,
            lockStartsAt,
            lockEndsAt,
            sourceContactSubmissionId: payload.sourceContactSubmissionId ?? null,
            notes: payload.notes?.trim() || null,
            createdByUserId: platformOwnerId,
            updatedByUserId: platformOwnerId,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException({ messageKey: 'errors.founding.seatsFull' });
        }
        throw error;
      }

      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: ROLE,
        action: FOUNDING_AUDIT.created,
        targetType: TARGET_TYPE,
        targetId: created.id,
        targetLabel: organization.name,
        context: {
          organizationId: organization.id,
          seatNumber,
          planKey: plan.key,
          lockedAmount: price.amount,
          lockedCurrency: price.currency,
          lockStartsAt: lockStartsAt.toISOString(),
          lockEndsAt: lockEndsAt.toISOString(),
          ...(payload.sourceContactSubmissionId
            ? { sourceContactSubmissionId: payload.sourceContactSubmissionId }
            : {}),
        },
      });
      return this.loadDetail(tx, created.id, now);
    });
  }

  async update(
    platformOwnerId: string,
    id: string,
    payload: UpdateFoundingMembershipDto,
    now: Date = new Date(),
  ): Promise<FoundingMembershipDetail> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.lockRowOrThrow(tx, id);
      if (
        current.updatedAt.toISOString() !==
        new Date(payload.expectedUpdatedAt).toISOString()
      ) {
        throw new ConflictException({ messageKey: 'errors.founding.stale' });
      }
      const organizationName = await this.organizationName(tx, current.organizationId);
      const data: Prisma.FoundingMembershipUpdateInput = {
        updatedByUserId: platformOwnerId,
      };
      const changed: string[] = [];
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      if (payload.notes !== undefined) {
        const notes = payload.notes.trim() || null;
        if (notes !== current.notes) {
          data.notes = notes;
          changed.push('notes');
          // Never the note text itself in the audit trail: just that it changed.
          changes.notes = {
            from: current.notes ? 'set' : null,
            to: notes ? 'set' : null,
          };
        }
      }
      if (payload.conciergeHoursUsed !== undefined) {
        const hours = Math.round(payload.conciergeHoursUsed * 100) / 100;
        if (hours !== Number(current.conciergeHoursUsed)) {
          if (current.status === 'revoked') {
            throw new ConflictException({ messageKey: 'errors.founding.revoked' });
          }
          data.conciergeHoursUsed = new Prisma.Decimal(hours);
          changed.push('conciergeHoursUsed');
          changes.conciergeHoursUsed = {
            from: Number(current.conciergeHoursUsed),
            to: hours,
          };
        }
      }

      let planChange: {
        fromKey: string;
        toKey: string;
        previous: number;
        price: FoundingMoney;
      } | null = null;
      if (payload.planKey !== undefined) {
        const currentPlan = await tx.plan.findUniqueOrThrow({
          where: { id: current.planId },
        });
        if (payload.planKey !== currentPlan.key) {
          if (current.status !== 'active') {
            throw new ConflictException({ messageKey: 'errors.founding.notActive' });
          }
          const { plan, price } = await this.loadEligiblePlanOrThrow(tx, payload.planKey);
          // Re-locked at THAT plan's annual catalog price today; the lock
          // window (start, end) is unchanged.
          data.plan = { connect: { id: plan.id } };
          data.lockedAmount = new Prisma.Decimal(price.amount);
          data.lockedCurrency = price.currency;
          planChange = {
            fromKey: currentPlan.key,
            toKey: plan.key,
            previous: Number(current.lockedAmount),
            price,
          };
        }
      }

      if (changed.length === 0 && !planChange) {
        return this.loadDetail(tx, id, now);
      }
      await tx.foundingMembership.update({ where: { id }, data });

      if (changed.length > 0) {
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          role: ROLE,
          action: FOUNDING_AUDIT.updated,
          targetType: TARGET_TYPE,
          targetId: id,
          targetLabel: organizationName,
          context: {
            organizationId: current.organizationId,
            changedFields: changed.join(','),
            ...(changes.conciergeHoursUsed
              ? { conciergeHoursUsed: Number(changes.conciergeHoursUsed.to) }
              : {}),
          },
          changes,
        });
      }
      if (planChange) {
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          role: ROLE,
          action: FOUNDING_AUDIT.planChanged,
          targetType: TARGET_TYPE,
          targetId: id,
          targetLabel: organizationName,
          context: {
            organizationId: current.organizationId,
            fromPlanKey: planChange.fromKey,
            toPlanKey: planChange.toKey,
            previousAmount: planChange.previous,
            lockedAmount: planChange.price.amount,
            lockedCurrency: planChange.price.currency,
          },
        });
      }
      return this.loadDetail(tx, id, now);
    });
  }

  /**
   * Revoking ends the lock at the next renewal: the paid period already
   * running is untouched, and the next checkout is priced from the catalog.
   * The seat is released.
   */
  async revoke(
    platformOwnerId: string,
    id: string,
    payload: RevokeFoundingMembershipDto,
    now: Date = new Date(),
  ): Promise<FoundingMembershipDetail> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.lockRowOrThrow(tx, id);
      if (current.status === 'revoked') {
        throw new ConflictException({ messageKey: 'errors.founding.revoked' });
      }
      const reason = payload.reason.trim();
      await tx.foundingMembership.update({
        where: { id },
        data: {
          status: 'revoked',
          revokedAt: now,
          revokedReason: reason,
          updatedByUserId: platformOwnerId,
        },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: ROLE,
        action: FOUNDING_AUDIT.revoked,
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: await this.organizationName(tx, current.organizationId),
        context: {
          organizationId: current.organizationId,
          seatNumber: current.seatNumber,
          reason,
        },
      });
      return this.loadDetail(tx, id, now);
    });
  }

  // ---------------------------------------------------------------------
  // Email founders
  // ---------------------------------------------------------------------

  async previewEmail(
    platformOwnerId: string,
    payload: FoundingEmailAudienceDto,
    now: Date = new Date(),
  ): Promise<FoundingEmailPreview> {
    const recipients = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.resolveRecipients(tx, payload),
    );
    return {
      recipientCount: recipients.length,
      recipients: recipients.map((row) => ({
        membershipId: row.id,
        seatNumber: row.seatNumber,
        organizationName: row.organization.name,
        ownerName: row.organization.owner.name,
      })),
      quota: await this.lifecycleQuota(now),
    };
  }

  async sendEmail(
    platformOwnerId: string,
    payload: SendFoundingEmailDto,
  ): Promise<FoundingEmailSendResult> {
    const sendId = randomUUID();
    const values = {
      sendId,
      subjectEn: oneLine(payload.subjectEn),
      bodyEn: payload.bodyEn.trim(),
      subjectAr: oneLine(payload.subjectAr),
      bodyAr: payload.bodyAr.trim(),
    };
    if (!values.subjectEn || !values.bodyEn || !values.subjectAr || !values.bodyAr) {
      throw new BadRequestException({ messageKey: 'errors.founding.emailIncomplete' });
    }

    const outboxIds = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const recipients = await this.resolveRecipients(tx, payload);
        if (recipients.length !== payload.confirmRecipientCount) {
          throw new ConflictException({
            messageKey: 'errors.founding.recipientCountChanged',
          });
        }
        const ids: (string | null)[] = [];
        for (const row of recipients) {
          const emitted = await this.communicationService.emit(tx, {
            key: 'platform.founding.message',
            recipientUserId: row.organization.ownerUserId,
            organizationId: row.organizationId,
            entity: { type: TARGET_TYPE, id: row.id },
            values,
          });
          ids.push(emitted.outboxId);
          await this.auditLogWriterService.write(tx, {
            actorUserId: platformOwnerId,
            role: ROLE,
            action: FOUNDING_AUDIT.emailed,
            targetType: TARGET_TYPE,
            targetId: row.id,
            targetLabel: row.organization.name,
            context: {
              organizationId: row.organizationId,
              sendId,
              audience: payload.audience,
              recipientCount: recipients.length,
            },
          });
        }
        return ids;
      },
    );
    for (const outboxId of outboxIds) {
      await this.communicationService.enqueueAfterCommit(outboxId);
    }
    return { sendId, queued: outboxIds.length };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private listWhere(
    query: ListFoundingMembershipsQueryDto,
  ): Prisma.FoundingMembershipWhereInput {
    const term = query.search?.trim();
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(term
        ? {
            organization: {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { owner: { name: { contains: term, mode: 'insensitive' } } },
                { owner: { email: { contains: term, mode: 'insensitive' } } },
              ],
            },
          }
        : {}),
    };
  }

  private lowestFreeSeat(taken: readonly number[]): number | null {
    const used = new Set(taken);
    for (let seat = 1; seat <= FOUNDING_SEAT_CAP; seat++) {
      if (!used.has(seat)) return seat;
    }
    return null;
  }

  private async loadOrganizationOrThrow(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ) {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        status: true,
        owner: { select: { name: true, email: true } },
        subscription: {
          select: MEMBERSHIP_INCLUDE.organization.select.subscription.select,
        },
      },
    });
    if (!organization) {
      throw new NotFoundException({ messageKey: 'errors.founding.organizationNotFound' });
    }
    return organization;
  }

  /** A self-serve catalog plan with an annual price; anything else is refused alike. */
  private async loadEligiblePlanOrThrow(
    tx: Prisma.TransactionClient,
    planKey: string,
  ): Promise<{ plan: Plan; price: FoundingMoney }> {
    const plan = await tx.plan.findUnique({ where: { key: planKey } });
    const price = plan ? catalogAnnualPrice(plan.pricing) : null;
    if (
      !plan ||
      !price ||
      plan.status !== 'active' ||
      plan.family !== 'normal' ||
      plan.displayOrder <= 0
    ) {
      throw new BadRequestException({ messageKey: 'errors.founding.planNotEligible' });
    }
    return { plan, price };
  }

  private async linkContactOrThrow(
    tx: Prisma.TransactionClient,
    platformOwnerId: string,
    contactId: string,
    markHandled: boolean,
    now: Date,
  ): Promise<void> {
    const contact = await tx.platformContactSubmission.findUnique({
      where: { id: contactId },
    });
    if (!contact || contact.topic !== 'founding') {
      throw new BadRequestException({ messageKey: 'errors.founding.contactNotFound' });
    }
    if (markHandled && contact.status !== 'archived') {
      await tx.platformContactSubmission.update({
        where: { id: contactId },
        data: { status: 'archived', readAt: contact.readAt ?? now },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: ROLE,
        action: 'platform.contact_submission.status_changed',
        targetType: 'platform_contact_submission',
        targetId: contactId,
        context: { status: 'archived', previousStatus: contact.status },
        changes: { status: { from: contact.status, to: 'archived' } },
      });
    }
  }

  private async lockRowOrThrow(tx: Prisma.TransactionClient, id: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM founding_memberships WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) {
      throw new NotFoundException({ messageKey: 'errors.founding.notFound' });
    }
    return tx.foundingMembership.findUniqueOrThrow({ where: { id } });
  }

  private async organizationName(tx: Prisma.TransactionClient, organizationId: string) {
    const row = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    return row?.name;
  }

  private async resolveRecipients(
    tx: Prisma.TransactionClient,
    payload: FoundingEmailAudienceDto,
  ) {
    const ids = payload.audience === 'selected' ? (payload.membershipIds ?? []) : null;
    if (ids !== null && ids.length === 0) {
      throw new BadRequestException({ messageKey: 'errors.founding.recipientsInvalid' });
    }
    const rows = await tx.foundingMembership.findMany({
      where: { status: 'active', ...(ids ? { id: { in: ids } } : {}) },
      include: {
        organization: {
          select: { name: true, ownerUserId: true, owner: { select: { name: true } } },
        },
      },
      orderBy: { seatNumber: 'asc' },
    });
    if (ids && rows.length !== ids.length) {
      // A selected membership is unknown, revoked or ended.
      throw new BadRequestException({ messageKey: 'errors.founding.recipientsInvalid' });
    }
    return rows;
  }

  /** The primary provider's remaining daily budget for a lifecycle email. */
  private async lifecycleQuota(now: Date): Promise<FoundingEmailPreview['quota']> {
    const name = this.emailProviderRegistry.providerNames()[0];
    const adapter = name ? this.emailProviderRegistry.find(name) : undefined;
    if (!name || !adapter) return null;
    const capabilities = adapter.capabilities();
    if (capabilities.dailyLimit === undefined) return null;
    try {
      const usage = await this.emailQuotaService.usage(name, capabilities, now);
      const line = Math.floor(capabilities.dailyLimit * categoryLine('lifecycle'));
      return {
        provider: name,
        dailyLimit: line,
        dailyUsed: usage.daily.used,
        remainingToday: Math.max(line - usage.daily.used, 0),
      };
    } catch {
      return null;
    }
  }

  private nextRenewal(row: MembershipRow, now: Date): FoundingNextRenewal | undefined {
    const sub = row.organization.subscription;
    if (!sub || !['active', 'grace_period', 'trialing'].includes(sub.status))
      return undefined;
    const lock = toFoundingLock(row);
    const periodStart = expectedPurchasePeriodStart(sub, now);
    const locked = foundingPriceFor(lock, {
      planId: row.planId,
      billingCycle: 'yearly',
      periodStart,
      catalog: catalogAnnualPrice(row.plan.pricing),
    });
    const price = locked ?? catalogAnnualPrice(row.plan.pricing);
    if (!price) return undefined;
    return {
      amount: price.amount,
      currency: price.currency,
      locked: locked !== null,
      periodStartsAt: periodStart.toISOString(),
    };
  }

  private toSummary(row: MembershipRow, now: Date): FoundingMembershipSummary {
    const subscription = subscriptionRef(row.organization.subscription);
    const nextRenewal = this.nextRenewal(row, now);
    return {
      id: row.id,
      seatNumber: row.seatNumber,
      status: row.status,
      organization: { id: row.organization.id, name: row.organization.name },
      owner: { name: row.organization.owner.name, email: row.organization.owner.email },
      plan: planRef(row.plan),
      lockedPrice: { amount: Number(row.lockedAmount), currency: row.lockedCurrency },
      lockStartsAt: row.lockStartsAt.toISOString(),
      lockEndsAt: row.lockEndsAt.toISOString(),
      ...(subscription ? { subscription } : {}),
      ...(nextRenewal ? { nextRenewal } : {}),
      conciergeHoursUsed: Number(row.conciergeHoursUsed),
      conciergeHoursCap: FOUNDING_CONCIERGE_HOURS_CAP,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async loadDetail(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<FoundingMembershipDetail> {
    const row = await tx.foundingMembership.findUnique({
      where: { id },
      include: {
        ...MEMBERSHIP_INCLUDE,
        sourceContactSubmission: {
          select: {
            id: true,
            name: true,
            email: true,
            organizationName: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException({ messageKey: 'errors.founding.notFound' });

    const [phones, audit] = await Promise.all([
      readOptedInOrganizationOwnerPhones(tx, [row.organizationId]),
      tx.auditLogEntry.findMany({
        where: { targetType: TARGET_TYPE, targetId: id },
        orderBy: { occurredAt: 'desc' },
        take: 100,
        select: {
          id: true,
          action: true,
          occurredAt: true,
          context: true,
          actor: { select: { name: true } },
        },
      }),
    ]);
    const phone = phones.get(row.organizationId);
    const summary = this.toSummary(row, now);
    const contact = row.sourceContactSubmission;
    const timeline: FoundingTimelineEntry[] = audit.map((entry) => ({
      id: entry.id,
      action: entry.action,
      occurredAt: entry.occurredAt.toISOString(),
      ...(entry.actor?.name ? { actorName: entry.actor.name } : {}),
      context:
        entry.context &&
        typeof entry.context === 'object' &&
        !Array.isArray(entry.context)
          ? (entry.context as Record<string, unknown>)
          : {},
    }));
    return {
      ...summary,
      owner: { ...summary.owner, ...(phone ? { phone: phone.e164 } : {}) },
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
      ...(row.revokedReason ? { revokedReason: row.revokedReason } : {}),
      ...(contact
        ? {
            sourceContact: {
              id: contact.id,
              name: contact.name,
              email: contact.email,
              ...(contact.organizationName
                ? { organizationName: contact.organizationName }
                : {}),
              status: contact.status,
              createdAt: contact.createdAt.toISOString(),
            },
          }
        : {}),
      timeline,
    };
  }
}
