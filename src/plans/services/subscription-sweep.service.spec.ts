/**
 * SubscriptionSweepService — mocked unit tests for the Phase 4.6 cursor-
 * persistence fix's CONTROL FLOW specifically (empty-page wrap, partial-
 * page wrap, ceiling-hit-without-wrap, multi-page progression, no-
 * platform-owner skip). Deliberately mocked, not run against a real
 * database: this logic's branches depend entirely on the SEQUENCE of
 * page results `findStaleUsageOrganizationIds` returns across repeated
 * calls within one tick, which is trivial and fast to control precisely
 * with mocks and awkward/slow to force reliably with real data — and this
 * dev database currently also holds the large synthetic dataset Phase
 * 4.6's dedicated 100K-scale re-validation depends on staying genuinely
 * stale (no `tenant_usage` row) until that dedicated benchmark runs;
 * running the real sweep here would prematurely recompute some of it.
 * `tenant-usage-sweep-cursor.e2e-spec.ts` covers the PERSISTENCE PRIMITIVE
 * this control flow relies on against the real database instead — the two
 * files together prove the fix; the full real, integrated, at-scale
 * behavior is what Phase 4.6's dedicated 100K-scale re-validation proves.
 */
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { SubscriptionSweepService } from './subscription-sweep.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { SubscriptionExpiryService } from './subscription-expiry.service';
import { TenantUsageRecomputeProducer } from '../queue/tenant-usage-recompute.producer';
import { TenantUsageSweepCursorRepository } from '../repositories/tenant-usage-sweep-cursor.repository';
import { AnnouncementsRepository } from '../../community/repositories/announcements.repository';
import { BlogPostsRepository } from '../../community/repositories/blog-posts.repository';
import { SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE } from '../queue/subscription-sweep.types';

type OrgIdRow = { id: string };

function page(ids: string[]): OrgIdRow[] {
  return ids.map((id) => ({ id }));
}

/** A full page — exactly `SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE` rows — so the loop's own "reached the real end of the table" test (`page.length < pageSize`) evaluates false and it keeps paginating. */
function fullPage(prefix: string): OrgIdRow[] {
  return Array.from({ length: SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE }, (_, i) => ({
    id: `${prefix}-${i}`,
  }));
}

describe('SubscriptionSweepService — Phase 4.6 cursor persistence', () => {
  let service: SubscriptionSweepService;
  let organizationsRepository: { findStaleUsageOrganizationIds: jest.Mock };
  let sweepCursorRepository: { read: jest.Mock; write: jest.Mock };
  let tenantUsageRecomputeProducer: { enqueueOne: jest.Mock };
  let usersRepository: { findFirstPlatformOwnerId: jest.Mock };
  let subscriptionExpiryService: { expireDueTrials: jest.Mock };
  let announcementsRepository: { publishDueScheduled: jest.Mock };
  let blogPostsRepository: { publishDueScheduled: jest.Mock };

  beforeEach(async () => {
    organizationsRepository = { findStaleUsageOrganizationIds: jest.fn() };
    sweepCursorRepository = { read: jest.fn(), write: jest.fn() };
    tenantUsageRecomputeProducer = { enqueueOne: jest.fn().mockResolvedValue(undefined) };
    usersRepository = {
      findFirstPlatformOwnerId: jest.fn().mockResolvedValue({ id: 'platform-owner-1' }),
    };
    subscriptionExpiryService = { expireDueTrials: jest.fn().mockResolvedValue(0) };
    // Phase 6 added scheduled-content publishing as the sweep's third
    // responsibility (`run()` calls both of these alongside the usage
    // scan). They are stubbed rather than asserted on because this file
    // covers the CURSOR control flow only — but they must be PROVIDED,
    // and returning a real count keeps the stub faithful to
    // `publishDueScheduled`'s actual `Promise<number>` contract rather
    // than handing the service back an `undefined` it never expects.
    announcementsRepository = { publishDueScheduled: jest.fn().mockResolvedValue(0) };
    blogPostsRepository = { publishDueScheduled: jest.fn().mockResolvedValue(0) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionSweepService,
        {
          provide: TenancyContextService,
          // Real `runInUserContext` opens a transaction and sets a session
          // variable, neither of which any of these tests need — just
          // invoke the passed callback directly with a placeholder `tx`.
          useValue: {
            runInUserContext: (_userId: string, work: (tx: unknown) => unknown) =>
              work(undefined),
          },
        },
        { provide: UsersRepository, useValue: usersRepository },
        { provide: OrganizationsRepository, useValue: organizationsRepository },
        { provide: SubscriptionExpiryService, useValue: subscriptionExpiryService },
        { provide: TenantUsageRecomputeProducer, useValue: tenantUsageRecomputeProducer },
        { provide: TenantUsageSweepCursorRepository, useValue: sweepCursorRepository },
        { provide: AnnouncementsRepository, useValue: announcementsRepository },
        { provide: BlogPostsRepository, useValue: blogPostsRepository },
      ],
    }).compile();

    service = moduleRef.get(SubscriptionSweepService);
  });

  it("reads the persisted cursor at the start of the tick and passes it as the scan's starting point — the exact behavior Failure 1 lacked", async () => {
    sweepCursorRepository.read.mockResolvedValue('previously-persisted-cursor');
    organizationsRepository.findStaleUsageOrganizationIds.mockResolvedValueOnce(page([]));

    await service.run();

    expect(sweepCursorRepository.read).toHaveBeenCalledTimes(1);
    expect(organizationsRepository.findStaleUsageOrganizationIds).toHaveBeenCalledWith(
      undefined,
      expect.any(Date),
      'previously-persisted-cursor',
      expect.any(Number),
    );
  });

  it('an empty first page means the real end of the table was already reached — enqueues nothing and wraps the cursor to null', async () => {
    sweepCursorRepository.read.mockResolvedValue('some-cursor');
    organizationsRepository.findStaleUsageOrganizationIds.mockResolvedValueOnce(page([]));

    await service.run();

    expect(tenantUsageRecomputeProducer.enqueueOne).not.toHaveBeenCalled();
    expect(sweepCursorRepository.write).toHaveBeenCalledTimes(1);
    expect(sweepCursorRepository.write).toHaveBeenCalledWith(null);
  });

  it('a partial last page (fewer rows than the page size) enqueues them, then wraps the cursor to null — not to the last processed id', async () => {
    sweepCursorRepository.read.mockResolvedValue(undefined);
    organizationsRepository.findStaleUsageOrganizationIds.mockResolvedValueOnce(
      page(['org-a', 'org-b', 'org-c']),
    );

    await service.run();

    expect(tenantUsageRecomputeProducer.enqueueOne).toHaveBeenCalledTimes(3);
    expect(tenantUsageRecomputeProducer.enqueueOne).toHaveBeenNthCalledWith(1, 'org-a');
    expect(tenantUsageRecomputeProducer.enqueueOne).toHaveBeenNthCalledWith(3, 'org-c');
    // Exactly one write — straight to `null`, since this page already
    // proved it reached the real end of the table.
    expect(sweepCursorRepository.write).toHaveBeenCalledTimes(1);
    expect(sweepCursorRepository.write).toHaveBeenCalledWith(null);
  });

  it('multiple full pages within one tick persist progress after EVERY page, not only once at tick-end', async () => {
    sweepCursorRepository.read.mockResolvedValue(undefined);
    organizationsRepository.findStaleUsageOrganizationIds
      .mockResolvedValueOnce(fullPage('p1'))
      .mockResolvedValueOnce(fullPage('p2'))
      .mockResolvedValueOnce(page(['tail-1', 'tail-2']));

    await service.run();

    expect(organizationsRepository.findStaleUsageOrganizationIds).toHaveBeenCalledTimes(
      3,
    );
    // Progress persisted after page 1 (its own last id), after page 2
    // (its own last id), and finally `null` once the partial third page
    // proves the real end of the table was reached — three writes total,
    // never batched to just the last one.
    expect(sweepCursorRepository.write).toHaveBeenCalledTimes(3);
    expect(sweepCursorRepository.write).toHaveBeenNthCalledWith(
      1,
      `p1-${SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE - 1}`,
    );
    expect(sweepCursorRepository.write).toHaveBeenNthCalledWith(
      2,
      `p2-${SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE - 1}`,
    );
    expect(sweepCursorRepository.write).toHaveBeenNthCalledWith(3, null);

    // Each page's own cursor was passed on as the NEXT page's starting
    // point — this is the exact resumption behavior Failure 1 lacked.
    expect(organizationsRepository.findStaleUsageOrganizationIds).toHaveBeenNthCalledWith(
      2,
      undefined,
      expect.any(Date),
      `p1-${SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE - 1}`,
      expect.any(Number),
    );
    expect(organizationsRepository.findStaleUsageOrganizationIds).toHaveBeenNthCalledWith(
      3,
      undefined,
      expect.any(Date),
      `p2-${SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE - 1}`,
      expect.any(Number),
    );
  });

  it('hitting the per-tick ceiling stops the tick WITHOUT wrapping the cursor — the next tick resumes from exactly where this one stopped, not from the beginning', async () => {
    // A backlog several times the per-tick ceiling. `fullPage` calls
    // (each a full `SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE`) will exhaust the
    // ceiling before ever returning a short page, so the loop must stop
    // on the `remaining <= 0` ceiling check, never on "reached the end of
    // the table".
    organizationsRepository.findStaleUsageOrganizationIds.mockImplementation(
      async (_tx: unknown, _olderThan: Date, cursor: string | undefined) => {
        const start = cursor ? Number(cursor.split('-')[1]) + 1 : 0;
        return fullPage('org').map((_, i) => ({ id: `org-${start + i}` }));
      },
    );
    sweepCursorRepository.read.mockResolvedValue(undefined);

    await service.run();

    const writeCalls = sweepCursorRepository.write.mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    // Never wrapped to null — the ceiling was hit mid-backlog, not the
    // end of the table.
    expect(writeCalls.every(([value]: [unknown]) => value !== null)).toBe(true);
  });

  it('a transient P2028 on a page fetch is retried with the SAME cursor, never skipping or double-enqueuing an organization', async () => {
    jest.useFakeTimers();
    try {
      const p2028 = new Prisma.PrismaClientKnownRequestError(
        'Transaction already closed',
        {
          code: 'P2028',
          clientVersion: '5.22.0',
        },
      );
      sweepCursorRepository.read.mockResolvedValue(undefined);
      organizationsRepository.findStaleUsageOrganizationIds
        .mockRejectedValueOnce(p2028)
        .mockRejectedValueOnce(p2028)
        .mockResolvedValueOnce(page(['org-a', 'org-b']));

      const runPromise = service.run();
      await jest.runAllTimersAsync();
      await runPromise;

      expect(organizationsRepository.findStaleUsageOrganizationIds).toHaveBeenCalledTimes(
        3,
      );
      // Every retried attempt used the exact same (still-unadvanced) cursor.
      for (let i = 1; i <= 3; i++) {
        expect(
          organizationsRepository.findStaleUsageOrganizationIds,
        ).toHaveBeenNthCalledWith(
          i,
          undefined,
          expect.any(Date),
          undefined,
          expect.any(Number),
        );
      }
      // Each organization enqueued exactly once — the two failed attempts
      // enqueued nothing, only the eventually-successful one did.
      expect(tenantUsageRecomputeProducer.enqueueOne).toHaveBeenCalledTimes(2);
      expect(tenantUsageRecomputeProducer.enqueueOne).toHaveBeenNthCalledWith(1, 'org-a');
      expect(tenantUsageRecomputeProducer.enqueueOne).toHaveBeenNthCalledWith(2, 'org-b');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a non-transient error on a page fetch is never retried — it propagates on the very first attempt', async () => {
    const genuineError = new Error('a real, non-transient bug');
    sweepCursorRepository.read.mockResolvedValue(undefined);
    organizationsRepository.findStaleUsageOrganizationIds.mockRejectedValueOnce(
      genuineError,
    );

    await expect(service.run()).rejects.toThrow('a real, non-transient bug');
    expect(organizationsRepository.findStaleUsageOrganizationIds).toHaveBeenCalledTimes(
      1,
    );
    expect(tenantUsageRecomputeProducer.enqueueOne).not.toHaveBeenCalled();
  });

  it('exhausting all retry attempts on a persistent P2028 propagates the error rather than silently giving up', async () => {
    jest.useFakeTimers();
    try {
      const p2028 = new Prisma.PrismaClientKnownRequestError(
        'Transaction already closed',
        {
          code: 'P2028',
          clientVersion: '5.22.0',
        },
      );
      sweepCursorRepository.read.mockResolvedValue(undefined);
      organizationsRepository.findStaleUsageOrganizationIds.mockRejectedValue(p2028);

      const runPromise = service.run();
      // Swallow the rejection on this handle so Node's unhandled-rejection
      // detector doesn't fire while timers are still being advanced below.
      runPromise.catch(() => {});
      await jest.runAllTimersAsync();
      await expect(runPromise).rejects.toThrow('Transaction already closed');
      // Exactly 6 attempts (the bounded retry count) — never an unbounded/infinite retry loop.
      expect(organizationsRepository.findStaleUsageOrganizationIds).toHaveBeenCalledTimes(
        6,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('when no platform owner exists yet, the cursor is never read or written — the tick is skipped entirely', async () => {
    usersRepository.findFirstPlatformOwnerId.mockResolvedValue(null);

    await service.run();

    expect(sweepCursorRepository.read).not.toHaveBeenCalled();
    expect(sweepCursorRepository.write).not.toHaveBeenCalled();
    expect(organizationsRepository.findStaleUsageOrganizationIds).not.toHaveBeenCalled();
  });
});
