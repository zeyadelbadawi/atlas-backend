/**
 * P64 Phase 2 — device/session policy resolution (master plan D4/D8,
 * Phase 2 §D.7, §N "policy resolution most-specific-first with platform
 * maximums").
 *
 * WHY THESE TESTS EXIST. This resolver is the only place the platform
 * ceiling is applied. There is deliberately no CHECK constraint behind it
 * (the resolver's own comment explains why), which means a clamp that
 * silently stopped clamping would show up nowhere: every academy row would
 * still be valid, every query would still succeed, and an academy that had
 * once written "99 devices" would simply start getting 99 devices. The
 * clamp cases below are the whole safety property, and the `source` cases
 * are what the Devices page and the audit trail tell an owner.
 *
 * The second property is that a MISSING row never means "unlimited". Both
 * the no-rows-at-all case and the no-platform-row case assert the D4
 * defaults, because a deleted policy row must not be the reason a limit
 * stops being enforced.
 *
 * The fake transaction client is hand-written rather than a Prisma mock so
 * that the `where` clause is actually honoured: the "another academy's
 * row" case only proves anything if the fake would have returned that row
 * had the service asked for it.
 */
import { AccessPolicyService, DEFAULT_ACCESS_POLICY } from './access-policy.service';
import type { Prisma } from '@prisma/client';

interface PolicyRow {
  readonly scope: 'academy' | 'plan' | 'platform';
  readonly academyId?: string | null;
  readonly planKey?: string | null;
  readonly maxDevices: number;
  readonly maxConcurrentSessions: number;
}

const ACADEMY = 'academy-1';

function academyRow(
  maxDevices: number,
  maxConcurrentSessions: number,
  academyId = ACADEMY,
): PolicyRow {
  return { scope: 'academy', academyId, maxDevices, maxConcurrentSessions };
}

function planRow(
  maxDevices: number,
  maxConcurrentSessions: number,
  planKey = 'growth',
): PolicyRow {
  return { scope: 'plan', planKey, maxDevices, maxConcurrentSessions };
}

function platformRow(maxDevices: number, maxConcurrentSessions: number): PolicyRow {
  return { scope: 'platform', maxDevices, maxConcurrentSessions };
}

/** Does one seeded row satisfy one clause of the resolver's `OR`? */
function matchesClause(row: PolicyRow, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(
    ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
  );
}

/**
 * A `Prisma.TransactionClient` with exactly the two methods this service
 * calls, filtering the seeded rows the way PostgreSQL would.
 */
function fakeTx(rows: readonly PolicyRow[]) {
  const findMany = jest.fn(
    (args: { where: { OR: Record<string, unknown>[] } }): Promise<PolicyRow[]> =>
      Promise.resolve(
        rows.filter((row) => args.where.OR.some((clause) => matchesClause(row, clause))),
      ),
  );
  const findFirst = jest.fn(
    (args: { where: { scope: string } }): Promise<PolicyRow | null> =>
      Promise.resolve(rows.find((row) => row.scope === args.where.scope) ?? null),
  );
  return {
    tx: { accessPolicy: { findMany, findFirst } } as unknown as Prisma.TransactionClient,
    findMany,
    findFirst,
  };
}

describe('AccessPolicyService.resolveForAcademy — most-specific-first', () => {
  const service = new AccessPolicyService();

  it('prefers the academy row over the plan and platform rows', async () => {
    const { tx } = fakeTx([academyRow(3, 2), planRow(5, 3), platformRow(10, 5)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, 'growth')).resolves.toEqual({
      maxDevices: 3,
      maxConcurrentSessions: 2,
      source: 'academy',
    });
  });

  it('falls back to the plan row when the academy has none', async () => {
    const { tx } = fakeTx([planRow(5, 3), platformRow(10, 5)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, 'growth')).resolves.toEqual({
      maxDevices: 5,
      maxConcurrentSessions: 3,
      source: 'plan',
    });
  });

  it('falls back to the platform row when neither academy nor plan has one', async () => {
    const { tx } = fakeTx([platformRow(10, 5)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, 'growth')).resolves.toEqual({
      maxDevices: 10,
      maxConcurrentSessions: 5,
      source: 'platform',
    });
  });

  /* TENANCY. Another academy's policy is not this academy's policy. */
  it('ignores an academy row belonging to a different academy', async () => {
    const { tx } = fakeTx([academyRow(9, 9, 'academy-2'), platformRow(10, 5)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, null)).resolves.toEqual({
      maxDevices: 10,
      maxConcurrentSessions: 5,
      source: 'platform',
    });
  });

  it('ignores a plan row when the academy is on no plan', async () => {
    // No `planKey` is passed, so the plan clause is not even asked for —
    // a plan row must not leak into an academy that is not on that plan.
    const { tx } = fakeTx([planRow(7, 4), platformRow(10, 5)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, null)).resolves.toEqual({
      maxDevices: 10,
      maxConcurrentSessions: 5,
      source: 'platform',
    });
  });

  it('ignores a plan row for a different plan key', async () => {
    const { tx } = fakeTx([planRow(7, 4, 'enterprise'), platformRow(10, 5)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, 'starter')).resolves.toEqual({
      maxDevices: 10,
      maxConcurrentSessions: 5,
      source: 'platform',
    });
  });
});

describe('AccessPolicyService.resolveForAcademy — the platform ceiling', () => {
  const service = new AccessPolicyService();

  /*
   * THE SAFETY PROPERTY. An academy row is data an owner can write. It is
   * clamped at READ time so that lowering the platform maximum takes
   * effect everywhere immediately, and so that a row written while the
   * ceiling was higher cannot outlive it.
   */
  it('clamps an academy row to the platform maximums and reports it as the academy row', async () => {
    const { tx } = fakeTx([academyRow(99, 50), platformRow(3, 2)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, 'growth')).resolves.toEqual({
      maxDevices: 3,
      maxConcurrentSessions: 2,
      // Still `academy`: the academy row decided, the platform row bounded it.
      source: 'academy',
    });
  });

  it('clamps each limit independently', async () => {
    // Devices are over the ceiling, sessions are under it.
    const { tx } = fakeTx([academyRow(99, 1), platformRow(3, 2)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, null)).resolves.toEqual({
      maxDevices: 3,
      maxConcurrentSessions: 1,
      source: 'academy',
    });
  });

  it('clamps a plan row too', async () => {
    const { tx } = fakeTx([planRow(50, 20), platformRow(4, 2)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, 'growth')).resolves.toEqual({
      maxDevices: 4,
      maxConcurrentSessions: 2,
      source: 'plan',
    });
  });

  it('never RAISES an academy that asked for less than the ceiling', async () => {
    const { tx } = fakeTx([academyRow(1, 1), platformRow(10, 5)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, null)).resolves.toEqual({
      maxDevices: 1,
      maxConcurrentSessions: 1,
      source: 'academy',
    });
  });

  /*
   * A DELETED PLATFORM ROW IS NOT AN OPEN DOOR. With no platform row the
   * ceiling is the D4 default, so an academy row of 99 is still clamped —
   * to 2 — rather than being honoured because nothing said otherwise.
   */
  it('uses the D4 defaults as the ceiling when the platform row is missing', async () => {
    const { tx } = fakeTx([academyRow(99, 50)]);

    await expect(service.resolveForAcademy(tx, ACADEMY, null)).resolves.toEqual({
      maxDevices: DEFAULT_ACCESS_POLICY.maxDevices,
      maxConcurrentSessions: DEFAULT_ACCESS_POLICY.maxConcurrentSessions,
      source: 'academy',
    });
  });
});

describe('AccessPolicyService.resolveForAcademy — no rows at all', () => {
  const service = new AccessPolicyService();

  it('falls back to 2 devices / 1 session, reported as `default`', async () => {
    const { tx } = fakeTx([]);

    await expect(service.resolveForAcademy(tx, ACADEMY, 'growth')).resolves.toEqual({
      maxDevices: 2,
      maxConcurrentSessions: 1,
      source: 'default',
    });
  });

  it('pins the documented D4 defaults themselves', async () => {
    // The fallback is only safe because these are the approved numbers;
    // if someone changes the constant, this test is the place that says so.
    expect(DEFAULT_ACCESS_POLICY).toEqual({ maxDevices: 2, maxConcurrentSessions: 1 });
  });
});

describe('AccessPolicyService.platformMaximums', () => {
  const service = new AccessPolicyService();

  it('returns the seeded platform row', async () => {
    const { tx, findFirst } = fakeTx([academyRow(1, 1), platformRow(6, 3)]);

    await expect(service.platformMaximums(tx)).resolves.toEqual({
      maxDevices: 6,
      maxConcurrentSessions: 3,
    });
    // Scoped to the platform row — an academy row must never be mistaken
    // for the ceiling an academy's own settings are validated against.
    expect(findFirst).toHaveBeenCalledWith({ where: { scope: 'platform' } });
  });

  it('returns the D4 defaults when no platform row exists', async () => {
    const { tx } = fakeTx([academyRow(1, 1)]);

    await expect(service.platformMaximums(tx)).resolves.toEqual({
      maxDevices: 2,
      maxConcurrentSessions: 1,
    });
  });
});
