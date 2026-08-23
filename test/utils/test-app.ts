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
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/database/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { StubEmailProvider } from '../../src/identity/services/stub-email.provider';

export interface TestApp {
  readonly app: INestApplication;
  readonly prisma: PrismaService;
  readonly stubEmailProvider: StubEmailProvider;
  readonly flushRateLimitKeys: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const flushRateLimitKeys = async (): Promise<void> => {
    const client = moduleRef.get(RedisService).getClient();
    const keys = await client.keys('ratelimit:*');
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
 */
export async function waitFor<T>(
  check: () => T | undefined,
  { timeoutMs = 5000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
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
