/**
 * SubscriptionSweepService — the single periodic job body Phase 2's one
 * scheduling mechanism (`SubscriptionSweepProcessor`, BullMQ repeatable
 * job) runs. Two responsibilities, deliberately combined into the SAME
 * scheduled tick rather than two separate schedulers (roadmap: "Use one
 * mechanism for both trial expiry and usage recomputation"):
 *
 *   1. `SubscriptionExpiryService.expireDueTrials` — transitions every
 *      organization whose trial has run out to `'expired'`.
 *   2. A usage-recompute SAFETY NET: enqueues
 *      `TenantUsageRecomputeProducer.enqueueOne` for every organization
 *      whose usage has gone stale (Phase 4.5.2 — see below), never
 *      unconditionally every organization on the platform. This is
 *      additive to (never a replacement for) the real, reactive triggers
 *      wired directly into the academy/course/enrollment/media write
 *      paths (see those services' own call sites) — those keep the Usage
 *      page current within moments of a real change; this sweep exists
 *      so a transient failure in one reactive trigger (or a metric
 *      affected by a change this phase did not itself enumerate) can
 *      never leave a `tenant_usage` row stale forever without a manual
 *      ops script, matching the roadmap's own acceptance criterion
 *      verbatim ("without requiring a manual ops script to be run").
 *
 * Phase 4.5.2 (ATLAS_SCALABILITY_ARCHITECTURE_PLAN.md Change 1,
 * ATLAS_SCALABILITY_PHASE_4_5_2_REPORT.md): the original implementation
 * enumerated EVERY organization on the platform, unconditionally, every
 * tick — proven live (Phase 4.5's own investigation, reproduced again
 * during Phase 4.5.1's own regression testing) to grow the queue
 * backlog without bound once organization count × per-job cost exceeded
 * the worker's drain rate within one 15-minute interval. This method now
 * enqueues only organizations whose usage is missing or older than
 * `USAGE_STALENESS_WINDOW_MS`, cursor-paginated and capped at
 * `SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK` per tick — bounding one
 * tick's worst-case fan-out to a fixed, predictable number regardless of
 * total platform organization count, at the cost of the old "every
 * organization, every 15 minutes" guarantee becoming "every organization
 * recomputed within a bounded number of ticks of actually going stale."
 * See those two constants' own doc comments in `subscription-sweep.
 * types.ts` for why each value was chosen.
 *
 * Enumerating candidate organizations relies on the same Platform Owner
 * cross-tenant bypass `SubscriptionExpiryService` already uses
 * (`organizations_platform_select`, P15) — one platform-owner id
 * resolution, reused for both halves of this one sweep.
 *
 * Phase 4.6 (scalability fix): the cursor above is now persisted, in
 * `tenant_usage_sweep_cursor`, ACROSS ticks via
 * `TenantUsageSweepCursorRepository` — read once at the start of `run()`,
 * written after every page. Previously `cursor` was a local reset to
 * `undefined` on every single `run()` invocation, so every tick re-scanned
 * `organizations` from `id > null` (the very start of the table)
 * regardless of how far an earlier tick had gotten; once the total stale
 * backlog exceeded `SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK`, the
 * organizations past that ceiling were never reached by any tick, ever —
 * each tick just redid the same first page of work. See
 * `ATLAS_SCALE_VALIDATION_PHASE_4_6_REPORT.md` ("Failure 1") for the
 * proof-of-reproduction this fix responds to.
 *
 * Phase 4.6 fix, continued: once the cursor actually lets a tick walk
 * deep into a genuinely large stale backlog, the per-page fetch below
 * runs concurrently with however many `tenant-usage-recompute` jobs the
 * PRECEDING pages already enqueued (up to `TENANT_USAGE_RECOMPUTE_
 * CONCURRENCY` of them, each its own interactive transaction). Reproduced
 * live against the real 100K+-organization re-validation dataset: this
 * genuine, sustained connection-pool contention occasionally pushed a
 * single page-fetch transaction's own start-to-finish wall time past
 * Prisma's 5000ms interactive-transaction ceiling, surfacing as `P2028`.
 * This is the EXACT class of error `ProvisioningOrchestratorService`'s
 * own `withTransientRetry`/`isTransientDatabaseError` already documents
 * as "confirmed, reproducible... under genuinely heavy concurrent load...
 * connection-pool-level timing issues one layer below this code, not
 * business-logic bugs... a retry a short moment later succeeds" — the
 * same narrow, bounded-retry treatment is applied here, duplicated
 * locally rather than extracted into a shared utility (this codebase's
 * own established precedent: see `findAllIdsPlatformWide` vs
 * `findStaleUsageOrganizationIds` for a narrow sibling addition kept
 * separate rather than merged). Retrying is safe here specifically
 * because the cursor is only advanced/persisted AFTER a page fetch
 * succeeds — a retried fetch reruns with the exact same `cursor`, so it
 * can never skip or double-enqueue an organization.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { SubscriptionExpiryService } from './subscription-expiry.service';
import { TenantUsageRecomputeProducer } from '../queue/tenant-usage-recompute.producer';
import { TenantUsageSweepCursorRepository } from '../repositories/tenant-usage-sweep-cursor.repository';
import { AnnouncementsRepository } from '../../community/repositories/announcements.repository';
import { BlogPostsRepository } from '../../community/repositories/blog-posts.repository';
import {
  SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK,
  SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE,
  USAGE_STALENESS_WINDOW_MS,
} from '../queue/subscription-sweep.types';

/** Matches `ProvisioningOrchestratorService`'s own `isTransientDatabaseError` exactly — see this file's header comment for why this is duplicated locally rather than shared. */
function isTransientDatabaseError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2024' || error.code === 'P2028')
  ) {
    return true;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return true;
  return (
    error instanceof Error &&
    (error.message.includes('old closed transaction') ||
      error.message.includes('Transaction API error') ||
      error.message.includes('Timed out fetching'))
  );
}

/**
 * Same shape as `ProvisioningOrchestratorService`'s own `withTransientRetry`
 * (bounded retries, exponential backoff, rethrows anything not recognized
 * as transient on the very first attempt) with a wider budget than that
 * file's default (3 attempts / 150ms start) — sized from THIS call site's
 * own measured behavior, not guessed: reproduced live against the real
 * 100K+-organization re-validation dataset, a sustained (not merely
 * momentary) burst of concurrent `tenant-usage-recompute` load — up to
 * `TENANT_USAGE_RECOMPUTE_CONCURRENCY` jobs, draining a 10,000-job backlog
 * this same tick just enqueued — kept individual page-fetch attempts
 * failing with `P2028` for up to ~80 real seconds at a time on this
 * evidence-gathering machine. 3 attempts at 150ms/300ms/600ms (this file's
 * first attempt at this fix) exhausted in about a second — nowhere near
 * enough to ride out an 80-second episode — and the tick failed outright.
 * 6 attempts at 500ms/1s/2s/4s/8s (≈15.5s of backoff, plus each attempt's
 * own up-to-~5s transaction-timeout window) gives roughly 45 real seconds
 * of tolerance, which is what emptying this specific enqueue-then-drain
 * pattern needed in practice (see `ATLAS_SCALE_VALIDATION_PHASE_4_6_FIX_
 * REPORT.md` §9/§12 for the full before/after timing evidence). This is
 * still a bounded, finite retry on a recognized-transient error — never
 * the Prisma transaction timeout itself, which remains at its default.
 */
async function withTransientRetry<T>(
  work: () => Promise<T>,
  attemptsRemaining = 6,
  delayMs = 500,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isTransientDatabaseError(error) || attemptsRemaining <= 1) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withTransientRetry(work, attemptsRemaining - 1, delayMs * 2);
  }
}

@Injectable()
export class SubscriptionSweepService {
  private readonly logger = new Logger(SubscriptionSweepService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly subscriptionExpiryService: SubscriptionExpiryService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly sweepCursorRepository: TenantUsageSweepCursorRepository,
    // Phase 6 — see this class's own doc comment, responsibility 3.
    private readonly announcementsRepository: AnnouncementsRepository,
    private readonly blogPostsRepository: BlogPostsRepository,
  ) {}

  async run(): Promise<void> {
    const expiredCount = await this.subscriptionExpiryService.expireDueTrials();

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping the usage-recompute safety-net sweep and the scheduled-content publish step.',
      );
      return;
    }

    // Phase 6 — publish every `scheduled` announcement/blog post whose
    // `scheduledAt` is now due, platform-wide, on this SAME tick (roadmap:
    // "MUST use the scheduler infrastructure created in Phase 2... do NOT
    // create a second scheduler"). One `updateMany` per content type — no
    // cursor/paging needed here (unlike the usage-recompute fan-out below):
    // this only flips already-narrow `status = 'scheduled' AND scheduledAt
    // <= now` rows to `published`, never enumerates the whole platform.
    const now = new Date();
    const [publishedAnnouncementCount, publishedBlogPostCount] =
      await this.tenancyContextService.runInUserContext(platformOwner.id, (tx) =>
        Promise.all([
          this.announcementsRepository.publishDueScheduled(tx, now),
          this.blogPostsRepository.publishDueScheduled(tx, now),
        ]),
      );

    const staleBefore = new Date(Date.now() - USAGE_STALENESS_WINDOW_MS);
    // Phase 4.6 fix — resume from where the LAST tick (on any backend
    // instance) left off, instead of starting over from the beginning of
    // the organizations table every time. See this class's own doc
    // comment and `TenantUsageSweepCursorRepository` for why.
    let cursor = await this.sweepCursorRepository.read();
    let recomputeEnqueuedCount = 0;
    let reachedPerTickCeiling = false;

    // Cursor-paginated, capped fan-out (Phase 4.5.2) — see this class's
    // own doc comment and the two constants' doc comments for why.
    for (;;) {
      const remaining =
        SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK - recomputeEnqueuedCount;
      if (remaining <= 0) {
        reachedPerTickCeiling = true;
        break;
      }

      const page = await withTransientRetry(() =>
        this.tenancyContextService.runInUserContext(platformOwner.id, (tx) =>
          this.organizationsRepository.findStaleUsageOrganizationIds(
            tx,
            staleBefore,
            cursor,
            Math.min(remaining, SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE),
          ),
        ),
      );
      if (page.length === 0) {
        // Zero rows past the cursor means the scan reached the real end
        // of the `organizations` table (see `findStaleUsageOrganizationIds`'s
        // own doc comment: `id > cursor` is ANDed with the staleness
        // filter, ordered by `id` ascending, so an empty page can only
        // mean no organization id exists past the cursor at all — not
        // merely "none of the nearby ones happen to be stale"). Wrap
        // around so the next tick starts from the beginning of the id
        // space again; otherwise organizations that go stale again after
        // the cursor has already passed them would never be revisited.
        cursor = undefined;
        await this.sweepCursorRepository.write(null);
        break;
      }

      for (const organization of page) {
        await this.tenantUsageRecomputeProducer.enqueueOne(organization.id);
        recomputeEnqueuedCount++;
      }
      cursor = page[page.length - 1].id;

      const reachedEndOfTable = page.length < SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE;
      // Persist after EVERY page, not just once at tick-end, so a
      // mid-tick failure (crash, `P2028`, worker restart) never discards
      // already-completed progress. When this page reached the real end
      // of the table, persist `null` directly rather than this page's
      // last id, so the very next tick wraps around immediately instead
      // of needing one more empty-page tick to discover the wrap.
      await this.sweepCursorRepository.write(reachedEndOfTable ? null : cursor);

      if (reachedEndOfTable) {
        cursor = undefined;
        break;
      }
    }

    if (reachedPerTickCeiling) {
      this.logger.warn(
        { recomputeEnqueuedCount, ceiling: SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK },
        'Subscription sweep hit its per-tick recompute ceiling — remaining stale organizations will be picked up on a later tick, not skipped.',
      );
    }

    this.logger.log(
      {
        expiredCount,
        recomputeEnqueuedCount,
        publishedAnnouncementCount,
        publishedBlogPostCount,
      },
      'Subscription sweep tick complete.',
    );
  }
}
