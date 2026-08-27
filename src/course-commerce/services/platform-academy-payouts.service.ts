/**
 * PlatformAcademyPayoutsService — `/platform-academy-payouts`,
 * `PlatformOwnerGuard`-gated (master plan §10, §4's own recommendation:
 * "payout is a manually-triggered or simply-scheduled batch job against a
 * ledger" for the Model-A interim bridge — this is that manually-triggered
 * path). `createPayout` computes the unsettled ledger balance for one
 * Academy over one period, splits it by currency, creates one
 * `AcademyPayout` row per currency with a real, positive balance, and
 * links every settled `RevenueLedgerEntry` via `AcademyPayoutItem` inside
 * ONE transaction — so an entry can never end up counted into two
 * payouts, and a payout row can never exist without its item links.
 *
 * Runs under `TenancyContextService.runInUserContext` (the
 * `is_platform_owner` RLS policy) for the whole operation — matches every
 * other Platform-Owner-only write path in this codebase
 * (`organization_commission_settings`, P12.5) which is asymmetric:
 * Academy staff may READ their own payouts (`AcademyPayoutsService`,
 * tenant-scoped), but only a Platform Owner may WRITE one.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import {
  AcademyPayoutItemsRepository,
  AcademyPayoutsRepository,
} from '../repositories/academy-payouts.repository';
import { RevenueLedgerEntriesRepository } from '../repositories/revenue-ledger-entries.repository';
import {
  toAcademyPayoutResponse,
  type AcademyPayoutResponse,
} from '../dto/academy-payout.contract';
import type { CreateAcademyPayoutDto } from '../dto/create-academy-payout.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

@Injectable()
export class PlatformAcademyPayoutsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyPayoutsRepository: AcademyPayoutsRepository,
    private readonly academyPayoutItemsRepository: AcademyPayoutItemsRepository,
    private readonly revenueLedgerEntriesRepository: RevenueLedgerEntriesRepository,
  ) {}

  async listAll(
    platformOwnerUserId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyPayoutResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      (tx) =>
        this.academyPayoutsRepository.findManyAnyAcademy(tx, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toAcademyPayoutResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /**
   * Computes and creates one `AcademyPayout` per currency with a real
   * unsettled balance for the given Academy/period. Returns an EMPTY array
   * (not an error) when there is nothing to pay out — an honest "nothing
   * owed" outcome, never a fabricated zero-amount payout row.
   */
  async createPayout(
    platformOwnerUserId: string,
    payload: CreateAcademyPayoutDto,
  ): Promise<readonly AcademyPayoutResponse[]> {
    const periodStart = new Date(payload.periodStart);
    const periodEnd = new Date(payload.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new ConflictException({ messageKey: 'errors.academyPayout.invalidPeriod' });
    }
    if (periodEnd.getTime() <= periodStart.getTime()) {
      throw new ConflictException({ messageKey: 'errors.academyPayout.invalidPeriod' });
    }

    // A Platform Owner is never an organization/academy member of the
    // Academy being paid out — `AcademiesRepository.findById` is
    // membership-RLS-gated and would be invisible here (the same shape
    // `CourseOrdersService.createOrder` hit for a buying student).
    // `resolveOrganizationId` reuses the existing, context-free P11
    // `resolve_academy_organization` function purely as a real existence
    // check; this service otherwise scopes every ledger/payout query by
    // `academyId` directly, never needing the Academy row itself.
    const organizationId = await this.academiesRepository.resolveOrganizationId(
      payload.academyId,
    );
    if (!organizationId) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      async (tx) => {
        const unsettled =
          await this.revenueLedgerEntriesRepository.findUnsettledForAcademy(
            tx,
            payload.academyId,
            periodEnd,
          );
        const eligible = unsettled.filter((entry) => entry.occurredAt >= periodStart);

        const byCurrency = new Map<string, typeof eligible>();
        for (const entry of eligible) {
          const bucket = byCurrency.get(entry.currency) ?? [];
          bucket.push(entry);
          byCurrency.set(entry.currency, bucket);
        }

        const created: AcademyPayoutResponse[] = [];
        for (const [currency, entries] of byCurrency) {
          const total = entries.reduce((sum, e) => sum + e.amountMinorUnits, 0n);
          // A zero or negative balance (e.g. a refund fully offsetting an
          // unsettled sale within the same period) is not a real payout —
          // skip it rather than create a meaningless/negative-amount row.
          if (total <= 0n) continue;

          const payout = await this.academyPayoutsRepository.create(tx, {
            academyId: payload.academyId,
            status: 'pending',
            amountMinorUnits: total,
            currency,
            periodStart,
            periodEnd,
          });
          await this.academyPayoutItemsRepository.createMany(
            tx,
            entries.map((entry) => ({
              payoutId: payout.id,
              revenueLedgerEntryId: entry.id,
            })),
          );
          const withItems = await this.academyPayoutsRepository.findById(tx, payout.id);
          created.push(toAcademyPayoutResponse(withItems!));
        }

        return created;
      },
    );
  }

  async markPaid(
    platformOwnerUserId: string,
    payoutId: string,
    providerReference?: string,
  ): Promise<AcademyPayoutResponse> {
    return this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      async (tx) => {
        const payout = await this.academyPayoutsRepository.findById(tx, payoutId);
        if (!payout) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (payout.status === 'paid') return toAcademyPayoutResponse(payout);
        if (payout.status === 'failed') {
          throw new ConflictException({ messageKey: 'errors.academyPayout.notPending' });
        }

        const updated = await this.academyPayoutsRepository.update(tx, payoutId, {
          status: 'paid',
          paidAt: new Date(),
          providerReference,
        });
        const withItems = await this.academyPayoutsRepository.findById(tx, updated.id);
        return toAcademyPayoutResponse(withItems!);
      },
    );
  }
}
