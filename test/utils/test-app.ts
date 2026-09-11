/**
 * Shared e2e test bootstrap — same base pattern as
 * `test/health.e2e-spec.ts` (real `AppModule`, real Postgres + Redis, no
 * mocks), plus the one addition P1 needs: `main.ts`'s global
 * `ValidationPipe`. `Test.createTestingModule(...).compile()` builds the DI
 * graph but does **not** replay `main.ts`'s imperative `bootstrap()` steps
 * (`useGlobalPipes`, `setGlobalPrefix`, `enableVersioning`, `helmet`,
 * `enableCors`) — P0's health check never needed any of those to be
 * meaningfully tested, but P1's DTO validation (whitelist/
 * forbidNonWhitelisted) does, so it's applied here identically to `main.ts`.
 * Prefix/versioning are deliberately *not* replicated — every P1 e2e spec
 * targets bare resource paths (`/auth/sign-in`, `/users/me`, ...), matching
 * how `health.e2e-spec.ts` already targets bare `/health`; the real
 * deployed `/api/v1` path is a separate, already-reported concern (see the
 * P1 final report's contract-matrix note on the frontend's `apiBaseUrl`).
 *
 * P8 addition: `main.ts`'s increased JSON body-parser limit (the default
 * 100kb rejects a real base64-encoded upload before it ever reaches
 * `MediaController`) — same computation as `main.ts`, so media e2e specs
 * can actually send a real payload.
 */
import { ConfigService } from '@nestjs/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/database/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { StubEmailProvider } from '../../src/identity/services/stub-email.provider';
import type { MediaStorageConfig } from '../../src/config/configuration';

export interface TestApp {
  readonly app: INestApplication;
  readonly prisma: PrismaService;
  readonly stubEmailProvider: StubEmailProvider;
  readonly flushRateLimitKeys: () => Promise<void>;
}

/**
 * Removes every key under the test queue prefix.
 *
 * `bull-test` is what `AppModule` sets for `app.isTest`, precisely so test
 * queue state never touches a real dev or production queue — see its own
 * comment there. Deleted in batches because a run's accumulated backlog
 * reaches six figures, and `DEL` with that many arguments at once is
 * neither necessary nor kind to Redis.
 */
async function flushTestQueues(redisService: RedisService): Promise<void> {
  const client = redisService.getClient();
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', 'bull-test:*', 'COUNT', 1000);
    cursor = next;
    /*
     * Repeat/scheduler bookkeeping is deliberately KEPT. Deleting it makes
     * `SubscriptionSweepScheduler.onApplicationBootstrap` register the
     * repeatable job as brand new on the very next boot, which schedules a
     * tick that is immediately due — so every spec file would start by
     * running a full subscription sweep. That sweep fans out one
     * `tenant-usage-recompute` job per stale organization, and on a
     * long-lived shared dev database (30,219 organizations here, from
     * months of e2e runs that never clean up) that is thousands of jobs
     * competing for the same nine-connection Prisma pool as the spec's own
     * requests. The recompute's interactive transaction then expires
     * against its 5s ceiling before its first query runs — "Transaction
     * already closed ... however 5445 ms passed since the start" — even
     * though the underlying SQL measures 0.1ms.
     *
     * Preserving these keys leaves the sweep on its real 15-minute
     * cadence, which no single spec file is long enough to hit.
     */
    const disposable = keys.filter((key) => !key.includes('repeat'));
    if (disposable.length > 0) await client.del(...disposable);
  } while (cursor !== '0');
}

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();

  const mediaConfig = moduleRef
    .get(ConfigService)
    .getOrThrow<MediaStorageConfig>('media');
  // Generous headroom above the real ceiling — same reasoning as
  // `main.ts`'s identical computation (see its own doc comment).
  app.useBodyParser('json', { limit: mediaConfig.maxUploadBytes * 3 });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  /*
   * DISCARD QUEUE STATE LEFT BEHIND BY PREVIOUS E2E RUNS, BEFORE THE
   * WORKERS START.
   *
   * Every e2e run enqueues real jobs (creating an Organization enqueues a
   * `tenant-usage-recompute`, the subscription sweep enqueues one per
   * organization, and so on) and then closes the app when the spec file
   * ends — long before those queues have drained. Nothing ever removed the
   * remainder, so across many runs against this shared Redis the backlog
   * only grew: measured at 166,309 waiting `tenant-usage-recompute` jobs
   * when this was written.
   *
   * BullMQ is FIFO, and this queue drains at roughly 137 jobs/sec
   * (`TENANT_USAGE_RECOMPUTE_CONCURRENCY`'s own benchmark), so a job
   * enqueued by a test landed behind about twenty minutes of someone
   * else's leftovers. `organizations.e2e-spec.ts`'s "a new Organization
   * gets a real tenant_usage row shortly after creation" then failed its
   * 10s wait — not because the behaviour it asserts was broken, but
   * because its job had not been reached yet. The same backlog also makes
   * `app.close()` slow, since it waits on in-flight jobs.
   *
   * The `bull-test:` prefix exists exactly so test queue state is separate
   * from anything real, which is what makes clearing it safe here. Jobs a
   * spec enqueues during its own run are untouched — this only ever runs
   * at bootstrap, before the spec has done anything.
   *
   * It has to run AFTER `app.init()`: `RedisService` constructs its client
   * in `onModuleInit`, so before init there is no connection to issue the
   * scan on. The workers are therefore already consuming by this point,
   * which is harmless — anything they pick up in that window is stale
   * leftover work, and clearing the queue underneath them is exactly what
   * is wanted.
   */
  await app.init();

  await flushTestQueues(moduleRef.get(RedisService));

  const flushRateLimitKeys = async (): Promise<void> => {
    const client = moduleRef.get(RedisService).getClient();
    /*
     * TWO independent rate limiters guard this application, and this helper
     * used to clear only one of them.
     *
     * `ratelimit:*` is `AuthRateLimiterService`, the per-IP sign-in limiter.
     * The GLOBAL `ThrottlerGuard` registered in `AppModule` (120 requests /
     * 60s, `APP_GUARD`, every route) keeps its counters in an entirely
     * different namespace — `nestjs-throttler-storage-redis` writes
     * `{<hash>:<throttler-name>}:hits` — so it was never flushed here at
     * all. With `maxWorkers: 1`, every spec file in the run shares one
     * localhost IP and therefore one 120-request budget, and any file that
     * polls an endpoint (provisioning status, worker results) exhausts it
     * and starts collecting 429s in tests that have nothing to do with rate
     * limiting.
     *
     * This does not weaken the throttler: it stays enabled for every
     * request in every spec, and is asserted where it is the subject under
     * test. It removes cross-file counter accumulation, which is exactly
     * what the comment below already claimed this helper did.
     */
    const keys = [
      ...(await client.keys('ratelimit:*')),
      ...(await client.keys('{*}:hits')),
    ];
    if (keys.length > 0) await client.del(...keys);
  };

  // Every e2e spec file registers/signs in through the same real IP
  // (localhost, via supertest) against the same real Redis instance. Without
  // this, `AuthRateLimiterService`'s per-IP counters would accumulate
  // *across* unrelated spec files and make unrelated tests flake once the
  // suite's cumulative sign-in count crosses the configured limit — not a
  // weakening of the real rate-limit feature (still fully exercised by
  // `auth-rate-limit.e2e-spec.ts`), just test-file isolation. Exposed as
  // `flushRateLimitKeys` too, for any spec file whose own test count alone
  // (not just cross-file accumulation) would otherwise cross the limit —
  // e.g. the tenant-isolation suite's several sign-ins per scenario.
  await flushRateLimitKeys();

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    stubEmailProvider: moduleRef.get(StubEmailProvider),
    flushRateLimitKeys,
  };
}

/** A unique, obviously-test-scoped email per call — real Postgres is shared across e2e spec files/workers, so uniqueness (not cleanup) is what keeps tests independent. */
export function uniqueTestEmail(label: string): string {
  return `p1-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@atlas.test`;
}

/** A unique raw-token fixture value — same rationale: the e2e suite runs against a real, persistent Postgres database with no per-run cleanup, so a fixed literal string would collide (unique constraint) with a leftover row from a previous run. */
export function uniqueRawTokenFixture(label: string): string {
  return `p1-fixture-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Polls `check` until it returns a defined value or `timeoutMs` elapses.
 * Used to wait for the password-reset BullMQ job to actually be processed
 * by the worker — `POST /auth/password-reset/request` returns as soon as
 * the job is enqueued, not once `StubEmailProvider` has recorded it, so
 * reading the token immediately afterward is a genuine race, not a flake
 * to paper over with a fixed `setTimeout`.
 *
 * Default budget raised from 5000ms to 10000ms (Organization Management
 * Completion fix pass) after observing reproducible timeouts on a
 * long-running local dev environment under heavy accumulated Postgres/
 * Redis load from many hours of continuous e2e runs — the underlying
 * password-reset flow itself was never broken (proven by every other test
 * in the same file consistently passing); this widens the margin so the
 * assertion isn't racing the test's own polling budget under load, not a
 * product behavior change.
 */
export async function waitFor<T>(
  check: () => T | undefined,
  {
    timeoutMs = 10000,
    intervalMs = 25,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition was never met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Async-check variant of `waitFor` — for polling conditions that require
 * an `await` themselves (a database read via Prisma, unlike `waitFor`'s
 * synchronous in-memory reads such as `StubEmailProvider`'s). P4's
 * `tenant-usage-recompute-worker.e2e-spec.ts` uses this to wait for a real
 * BullMQ job to actually be processed and its result persisted, the same
 * "returns as soon as enqueued, not once processed" race `waitFor`'s own
 * doc comment describes for password-reset — just against Postgres
 * instead of an in-memory stub.
 */
/** Upper bound on the backoff below — see `waitForAsync`. */
const MAX_POLL_INTERVAL_MS = 250;

export async function waitForAsync<T>(
  check: () => Promise<T | undefined>,
  {
    timeoutMs = 10000,
    intervalMs = 25,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let delay = intervalMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitForAsync: condition was never met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    /*
     * Back off rather than polling at a fixed 25ms for the whole budget.
     * Most `check`s here are HTTP requests, and a flat interval spent up to
     * 400 of them against a single endpoint inside one 10s wait — more than
     * three times the global `ThrottlerGuard` allowance (120 requests /
     * 60s), so a test could exhaust its own budget purely by waiting and
     * then fail on a 429 that has nothing to do with what it asserts. No
     * real client polls a status endpoint forty times a second.
     *
     * The FIRST poll is still immediate and the second still lands at
     * `intervalMs`, so a condition that resolves quickly — which is nearly
     * all of them — is detected exactly as fast as before. Only a genuinely
     * long wait slows its polling, and the cap keeps worst-case detection
     * latency well under a second.
     */
    delay = Math.min(delay * 2, MAX_POLL_INTERVAL_MS);
  }
}
