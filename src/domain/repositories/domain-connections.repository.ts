/**
 * DomainConnectionsRepository — the one writer/reader of
 * `domain_connections` (P11; extended P63).
 *
 * Every method takes the caller's `Prisma.TransactionClient` so RLS
 * context is whatever the caller established (`runInTenantAndUserContext`
 * for a customer, `runInUserContext(<platform owner>)` for the sweep and
 * the Platform Owner console).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Academy,
  DomainConnection,
  DomainStatus,
  Organization,
  SubdomainAllocation,
} from '@prisma/client';

/** Statuses the provider can still move forward on its own — the sweep re-checks these. */
export const DOMAIN_STATUSES_AWAITING_PROVIDER: readonly DomainStatus[] = [
  'pending',
  'verification_required',
  'verifying',
];

/** Statuses that mean "the customer must do something" or "something went wrong". */
export const DOMAIN_STATUSES_NEEDING_ATTENTION: readonly DomainStatus[] = [
  'verification_required',
  'failed',
];

export type AcademyDomainRow = Pick<
  Academy,
  'id' | 'name' | 'slug' | 'status' | 'organizationId' | 'createdAt'
> & {
  readonly organization: Pick<Organization, 'id' | 'name'>;
  readonly subdomainAllocation: SubdomainAllocation | null;
  readonly domainConnection: DomainConnection | null;
};

export interface DomainOperationsFilter {
  readonly search?: string;
  /** `custom` = has a custom domain row past `not_configured`; `subdomain` = none. */
  readonly kind?: 'custom' | 'subdomain';
  readonly status?: DomainStatus;
  readonly attention?: boolean;
  readonly sortBy?: 'name' | 'createdAt' | 'hostname' | 'lastCheckedAt' | 'organization';
  readonly sortDirection?: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
}

export interface DomainOperationsOverview {
  readonly academies: number;
  readonly withSubdomain: number;
  readonly withCustomDomain: number;
  readonly customConnected: number;
  /** P63d — connected AND certificate active AND probe succeeded: the ones actually serving a website. */
  readonly customLive: number;
  readonly customAwaitingProvider: number;
  readonly customFailed: number;
  readonly needingAttention: number;
}

@Injectable()
export class DomainConnectionsRepository {
  findByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<DomainConnection | null> {
    return tx.domainConnection.findUnique({ where: { academyId } });
  }

  findByHostname(
    tx: Prisma.TransactionClient,
    hostname: string,
  ): Promise<DomainConnection | null> {
    return tx.domainConnection.findUnique({ where: { hostname } });
  }

  /**
   * P63 — serializes every check/add/remove for ONE academy inside the
   * caller's transaction: two overlapping "check now" clicks, a sweep tick
   * racing a customer's click, or a disconnect racing a check, all queue
   * on this row lock and each sees the previous one's committed result.
   * `SELECT … FOR UPDATE` must satisfy the UPDATE policy, which is exactly
   * what both the tenant path and the platform path hold. Returns `null`
   * (nothing to lock) when no row exists yet.
   */
  async lockByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<DomainConnection | null> {
    // A transaction-scoped advisory lock first: it serializes even when
    // no `domain_connections` row exists yet (two first-time adds for the
    // same Academy), which a row lock cannot. Released at commit/rollback.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain_connections:${academyId}`}))`;
    await tx.$executeRaw`SELECT 1 FROM "domain_connections" WHERE "academy_id" = ${academyId} FOR UPDATE`;
    return this.findByAcademyId(tx, academyId);
  }

  /**
   * P63 — for rows that already exist (every check runs on a locked,
   * existing row). Deliberately NOT `upsert`: Prisma emits
   * `INSERT … ON CONFLICT DO UPDATE` for it, and PostgreSQL evaluates the
   * INSERT policy first — which the platform context (sweep, operator
   * check) rightly does not have. A plain UPDATE is what the
   * `_platform_update` / `_tenant_update` policies authorise.
   */
  updateByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
    data: Prisma.DomainConnectionUncheckedUpdateInput,
  ): Promise<DomainConnection> {
    return tx.domainConnection.update({ where: { academyId }, data });
  }

  upsert(
    tx: Prisma.TransactionClient,
    academyId: string,
    data: Omit<Prisma.DomainConnectionUncheckedCreateInput, 'academyId'>,
  ): Promise<DomainConnection> {
    return tx.domainConnection.upsert({
      where: { academyId },
      create: { academyId, ...data },
      update: data,
    });
  }

  /**
   * P63 — rows the verification sweep should re-ask the provider about:
   * still waiting on the provider and not checked since `awaitingBefore`;
   * connected but NOT YET LIVE (certificate pending, or the last probe
   * failed — P63d) on that same fast cadence, because the provider or the
   * origin can still move them forward and a customer is waiting; or live
   * and not checked since `connectedBefore` (a slower cadence that catches
   * DNS that broke after connection). Never checked sorts first. Bounded.
   */
  findManyDueForVerificationSweep(
    tx: Prisma.TransactionClient,
    awaitingBefore: Date,
    connectedBefore: Date,
    take: number,
  ): Promise<DomainConnection[]> {
    return tx.domainConnection.findMany({
      where: {
        hostname: { not: null },
        OR: [
          {
            status: { in: [...DOMAIN_STATUSES_AWAITING_PROVIDER] },
            OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: awaitingBefore } }],
          },
          {
            status: 'connected',
            OR: [{ sslStatus: { not: 'active' } }, { httpsReachable: { not: true } }],
            AND: [
              {
                OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: awaitingBefore } }],
              },
            ],
          },
          {
            status: 'connected',
            OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: connectedBefore } }],
          },
        ],
      },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
      take,
    });
  }

  private buildOperationsWhere(filter: DomainOperationsFilter): Prisma.AcademyWhereInput {
    const clauses: Prisma.AcademyWhereInput[] = [];

    if (filter.search) {
      const contains = { contains: filter.search, mode: 'insensitive' as const };
      clauses.push({
        OR: [
          { name: contains },
          { slug: contains },
          { organization: { name: contains } },
          { domainConnection: { hostname: contains } },
          { subdomainAllocation: { fullHost: contains } },
        ],
      });
    }

    const hasCustom: Prisma.DomainConnectionWhereInput = {
      hostname: { not: null },
      status: { not: 'not_configured' },
    };
    if (filter.kind === 'custom') clauses.push({ domainConnection: { is: hasCustom } });
    if (filter.kind === 'subdomain') {
      clauses.push({
        OR: [{ domainConnection: null }, { domainConnection: { isNot: hasCustom } }],
      });
    }
    if (filter.status)
      clauses.push({ domainConnection: { is: { status: filter.status } } });
    if (filter.attention) {
      clauses.push({
        domainConnection: {
          is: {
            hostname: { not: null },
            OR: [
              { status: { in: [...DOMAIN_STATUSES_NEEDING_ATTENTION] } },
              { lastCheckError: { not: null } },
              { httpsReachable: false },
            ],
          },
        },
      });
    }

    return clauses.length ? { AND: clauses } : {};
  }

  private buildOperationsOrderBy(
    filter: DomainOperationsFilter,
  ): Prisma.AcademyOrderByWithRelationInput[] {
    const direction = filter.sortDirection ?? 'desc';
    switch (filter.sortBy) {
      case 'name':
        return [{ name: direction }];
      case 'organization':
        return [{ organization: { name: direction } }];
      case 'hostname':
        return [{ domainConnection: { hostname: { sort: direction, nulls: 'last' } } }];
      case 'lastCheckedAt':
        return [
          { domainConnection: { lastCheckedAt: { sort: direction, nulls: 'last' } } },
        ];
      case 'createdAt':
      default:
        return [{ createdAt: direction }];
    }
  }

  /** P63 — the Platform Owner's cross-tenant domain list. Runs under `runInUserContext(<platform owner>)`; the `_platform_select` policies on academies, organizations, subdomain_allocations and domain_connections are what make the rows visible. */
  async findManyAcademiesWithDomains(
    tx: Prisma.TransactionClient,
    filter: DomainOperationsFilter,
  ): Promise<{ items: AcademyDomainRow[]; totalItems: number }> {
    const where = this.buildOperationsWhere(filter);
    const [items, totalItems] = await Promise.all([
      tx.academy.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          organizationId: true,
          createdAt: true,
          organization: { select: { id: true, name: true } },
          subdomainAllocation: true,
          domainConnection: true,
        },
        orderBy: this.buildOperationsOrderBy(filter),
        skip: filter.skip,
        take: filter.take,
      }),
      tx.academy.count({ where }),
    ]);
    return { items, totalItems };
  }

  findAcademyWithDomainsAnyOrganization(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<AcademyDomainRow | null> {
    return tx.academy.findUnique({
      where: { id: academyId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        organizationId: true,
        createdAt: true,
        organization: { select: { id: true, name: true } },
        subdomainAllocation: true,
        domainConnection: true,
      },
    });
  }

  /** P63 — real counts for the Platform Owner overview; nothing estimated. */
  async countOperationsOverview(
    tx: Prisma.TransactionClient,
  ): Promise<DomainOperationsOverview> {
    const hasCustom: Prisma.DomainConnectionWhereInput = {
      hostname: { not: null },
      status: { not: 'not_configured' },
    };
    const [
      academies,
      withSubdomain,
      withCustomDomain,
      customConnected,
      customLive,
      customAwaitingProvider,
      customFailed,
      needingAttention,
    ] = await Promise.all([
      tx.academy.count(),
      tx.subdomainAllocation.count({ where: { status: 'assigned' } }),
      tx.domainConnection.count({ where: hasCustom }),
      tx.domainConnection.count({ where: { ...hasCustom, status: 'connected' } }),
      tx.domainConnection.count({
        where: {
          ...hasCustom,
          status: 'connected',
          sslStatus: 'active',
          httpsReachable: true,
        },
      }),
      tx.domainConnection.count({
        where: { ...hasCustom, status: { in: [...DOMAIN_STATUSES_AWAITING_PROVIDER] } },
      }),
      tx.domainConnection.count({ where: { ...hasCustom, status: 'failed' } }),
      tx.domainConnection.count({
        where: {
          hostname: { not: null },
          OR: [
            { status: { in: [...DOMAIN_STATUSES_NEEDING_ATTENTION] } },
            { lastCheckError: { not: null } },
            { httpsReachable: false },
          ],
        },
      }),
    ]);
    return {
      academies,
      withSubdomain,
      withCustomDomain,
      customConnected,
      customLive,
      customAwaitingProvider,
      customFailed,
      needingAttention,
    };
  }
}
