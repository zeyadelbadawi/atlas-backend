/**
 * P64 Phase 2 — the learner device registry (master plan AD-10, D4,
 * Phase 2 §D.7/§G, §R "device cookie tampering").
 *
 * WHY THESE TESTS EXIST. Three separate promises are made about this
 * service, and none of them is visible from reading a single call site.
 *
 * 1. A DEVICE IS A SERVER-ISSUED COOKIE, NOT A FINGERPRINT. The label is
 *    something a person can recognise in a list ("Chrome on macOS") and
 *    nothing more, so the label cases below also pin what it must NOT
 *    become: an unrecognised agent stays honestly "Unknown device" rather
 *    than being guessed at, and the two lies every User-Agent tells
 *    (Chrome says "Safari", an iPhone says "Mac OS X") are resolved the
 *    way a human would resolve them.
 *
 * 2. THE COOKIE IS STORED HASHED, for the reason `refresh_tokens` is:
 *    reading the table must not yield a credential someone can replay.
 *
 * 3. AN UNKNOWN COOKIE IS NOT AN ERROR AND NOT A BYPASS. This is the
 *    adversarial case in Phase 2 §R. Tampering with the cookie must fall
 *    through to registration — which the cap then governs — rather than
 *    throwing at the learner or skipping the count. A single early return
 *    in the wrong branch would turn the device cap into an opt-out.
 *
 * The fake transaction client honours its `where` clauses on purpose: the
 * cross-academy and revoked-device cases only prove something if the fake
 * would have returned those rows had the service asked for them.
 */
import {
  deriveDeviceLabel,
  hashDeviceCookie,
  StudentDeviceService,
} from './student-device.service';
import type { Prisma } from '@prisma/client';

interface DeviceRow {
  id: string;
  userId: string;
  academyId: string;
  cookieHash: string;
  label: string;
  userAgent: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

const USER = 'user-1';
const ACADEMY = 'academy-1';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let nextId = 0;

function deviceRow(over: Partial<DeviceRow> = {}): DeviceRow {
  nextId += 1;
  return {
    id: `seeded-${nextId.toString()}`,
    userId: USER,
    academyId: ACADEMY,
    cookieHash: hashDeviceCookie(`cookie-${nextId.toString()}`),
    label: 'Chrome on macOS',
    userAgent: CHROME_MAC,
    lastSeenAt: new Date('2026-09-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    revokedAt: null,
    ...over,
  };
}

function matchesWhere(row: DeviceRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    // The rank breaks `createdAt` ties by id with an `OR` of two clauses.
    if (key === 'OR') {
      return (value as Record<string, unknown>[]).some((clause) =>
        matchesWhere(row, clause),
      );
    }
    const actual = (row as unknown as Record<string, unknown>)[key];
    // The service ranks devices by registration order with
    // `createdAt: { lt: <date> }` (and `id: { lt: <id> }` for ties), so the
    // fake has to understand that one operator. Without it the clause
    // silently matched nothing and the cap check looked like it passed when
    // it had never run.
    if (value && typeof value === 'object' && 'lt' in (value as object)) {
      const bound = (value as { lt: Date | string }).lt;
      if (bound instanceof Date) {
        return actual instanceof Date && actual.getTime() < bound.getTime();
      }
      return typeof actual === 'string' && actual < bound;
    }
    if (value instanceof Date) {
      return actual instanceof Date && actual.getTime() === value.getTime();
    }
    return actual === value;
  });
}

/**
 * A `Prisma.TransactionClient` carrying only what this service calls.
 * `hiddenHashes` stand for rows RLS hides (another account's devices):
 * invisible to reads, but still taken in the global unique index.
 */
function fakeTx(rows: DeviceRow[], hiddenHashes: readonly string[] = []) {
  let created = 0;
  const studentDevice = {
    findFirst: jest.fn(
      (args: { where: Record<string, unknown> }): Promise<DeviceRow | null> =>
        Promise.resolve(rows.find((row) => matchesWhere(row, args.where)) ?? null),
    ),
    count: jest.fn((args: { where: Record<string, unknown> }): Promise<number> =>
      Promise.resolve(rows.filter((row) => matchesWhere(row, args.where)).length),
    ),
    update: jest.fn(
      (args: { where: { id: string }; data: Partial<DeviceRow> }): Promise<DeviceRow> => {
        const row = rows.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error(`fake tx: no device ${args.where.id}`);
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
    ),
    create: jest.fn((args: { data: Partial<DeviceRow> }): Promise<DeviceRow> => {
      created += 1;
      const row: DeviceRow = {
        id: `created-${created.toString()}`,
        userId: '',
        academyId: '',
        cookieHash: '',
        label: '',
        userAgent: null,
        lastSeenAt: new Date(),
        createdAt: new Date(),
        revokedAt: null,
        ...args.data,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    createMany: jest.fn(
      (args: {
        data: Partial<DeviceRow>[];
        skipDuplicates?: boolean;
      }): Promise<{
        count: number;
      }> => {
        let count = 0;
        for (const data of args.data) {
          const taken =
            hiddenHashes.includes(data.cookieHash ?? '') ||
            rows.some((row) => row.cookieHash === data.cookieHash);
          if (taken) {
            if (!args.skipDuplicates) throw new Error('fake tx: unique violation');
            continue;
          }
          created += 1;
          count += 1;
          rows.push({
            id: `created-${created.toString()}`,
            userId: '',
            academyId: '',
            cookieHash: '',
            label: '',
            userAgent: null,
            lastSeenAt: new Date(),
            createdAt: new Date(),
            revokedAt: null,
            ...data,
          });
        }
        return Promise.resolve({ count });
      },
    ),
  };
  // The per-learner registration lock (`pg_advisory_xact_lock`).
  const $queryRaw = jest.fn(() => Promise.resolve([{ locked: 1 }]));
  return {
    tx: { studentDevice, $queryRaw } as unknown as Prisma.TransactionClient,
    $queryRaw,
    studentDevice,
    rows,
  };
}

describe('deriveDeviceLabel', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['Chrome on macOS', CHROME_MAC, 'Chrome on macOS'],
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Chrome on Android',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Firefox on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Firefox on macOS',
    ],
    [
      'Firefox on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Firefox on Windows',
    ],
    [
      'Firefox on Android',
      'Mozilla/5.0 (Android 13; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
      'Firefox on Android',
    ],
    [
      'Safari on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
      'Safari on macOS',
    ],
    [
      'Safari on an iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Safari on an iPad',
      'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Edge on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91',
      'Edge on Windows',
    ],
    [
      'Edge on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91',
      'Edge on macOS',
    ],
  ];

  for (const [name, userAgent, expected] of cases) {
    it(`labels ${name}`, () => {
      expect(deriveDeviceLabel(userAgent)).toBe(expected);
    });
  }

  /*
   * THE TWO LIES EVERY USER-AGENT TELLS. Chrome's string ends in
   * "Safari/537.36" and an iPhone claims to be "like Mac OS X". A label a
   * learner is asked to recognise has to resolve both the way they would.
   */
  it('does not call Chrome "Safari" even though Chrome says "Safari"', () => {
    expect(CHROME_MAC).toContain('Safari/');
    expect(deriveDeviceLabel(CHROME_MAC)).toBe('Chrome on macOS');
  });

  it('does not call an iPhone "macOS" even though iOS says "like Mac OS X"', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
    expect(iphone).toContain('Mac OS X');
    expect(deriveDeviceLabel(iphone)).toBe('Safari on iOS');
  });

  it('says "Unknown device" for no User-Agent at all', () => {
    expect(deriveDeviceLabel(undefined)).toBe('Unknown device');
    expect(deriveDeviceLabel('')).toBe('Unknown device');
  });

  it('says "Unknown device" for an agent it does not recognise, rather than guessing', () => {
    expect(deriveDeviceLabel('curl/8.4.0')).toBe('Unknown device');
    expect(deriveDeviceLabel('AtlasBot/1.0 (+https://example.test)')).toBe(
      'Unknown device',
    );
  });

  it('names whichever half it does recognise', () => {
    expect(deriveDeviceLabel('Firefox/121.0')).toBe('Firefox');
    expect(deriveDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(
      'Windows',
    );
  });
});

describe('hashDeviceCookie', () => {
  it('is stable for the same value', () => {
    const value = 'a1b2c3';
    expect(hashDeviceCookie(value)).toBe(hashDeviceCookie(value));
  });

  it('differs for values that differ by a single character', () => {
    expect(hashDeviceCookie('a1b2c3')).not.toBe(hashDeviceCookie('a1b2c4'));
  });

  /* A database read must not yield something replayable. */
  it('is a SHA-256 hex digest that contains none of the original value', () => {
    const value = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const hash = hashDeviceCookie(value);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(value);
    expect(hash).not.toContain(value);
  });
});

describe('StudentDeviceService.resolveForSession', () => {
  const service = new StudentDeviceService();

  /*
   * The cap has to govern RECOGNISED devices too, not only registration.
   *
   * The scenario is the one an owner actually performs: three devices are
   * already registered, the owner lowers the academy's device policy to
   * two because they suspect sharing, and the policy has to take effect on
   * the learner who already has three. If the cap were checked only at
   * registration, that learner would keep all three forever and the
   * setting would be decorative.
   *
   * Registration order decides who keeps working, oldest first — the only
   * stable ordering. Ranking by last-seen would reshuffle on every
   * request, so a learner alternating between two browsers under a cap of
   * one would lock each out in turn and never finish a lesson.
   */
  it('breaks a createdAt tie by id, so devices registered in the same millisecond never share a rank', async () => {
    const at = new Date('2026-09-01T00:00:00.000Z');
    const rows = ['a', 'b', 'c'].map((name) =>
      deviceRow({ id: `tie-${name}`, cookieHash: hashDeviceCookie(name), createdAt: at }),
    );
    const outcomes: boolean[] = [];
    for (const cookie of ['a', 'b', 'c']) {
      const { tx } = fakeTx([...rows]);
      const resolution = await service.resolveForSession(tx, {
        userId: USER,
        academyId: ACADEMY,
        cookieValue: cookie,
        userAgent: CHROME_MAC,
        maxDevices: 2,
      });
      outcomes.push(Boolean(resolution.device));
    }
    expect(outcomes).toEqual([true, true, false]);
  });

  it('refuses a recognised device that falls outside a LOWERED cap, oldest registrations first', async () => {
    const first = deviceRow({
      cookieHash: hashDeviceCookie('first'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const second = deviceRow({
      cookieHash: hashDeviceCookie('second'),
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    const third = deviceRow({
      cookieHash: hashDeviceCookie('third'),
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    const rows = [first, second, third];

    // Cap of 2: the two oldest keep working, the newest is refused.
    for (const [cookie, expected] of [
      ['first', true],
      ['second', true],
      ['third', false],
    ] as const) {
      const { tx } = fakeTx([...rows]);
      const resolution = await service.resolveForSession(tx, {
        userId: USER,
        academyId: ACADEMY,
        cookieValue: cookie,
        userAgent: CHROME_MAC,
        maxDevices: 2,
      });
      expect(Boolean(resolution.device)).toBe(expected);
      expect(resolution.atCapacity).toBe(!expected);
      // A device refused by the cap must never be handed a fresh cookie —
      // that would silently register a replacement and defeat the limit.
      expect(resolution.issueCookieValue).toBeNull();
    }
  });

  it('still admits every registered device while the cap has room for them all', async () => {
    const first = deviceRow({
      cookieHash: hashDeviceCookie('first'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const second = deviceRow({
      cookieHash: hashDeviceCookie('second'),
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    for (const cookie of ['first', 'second'] as const) {
      const { tx } = fakeTx([first, second]);
      const resolution = await service.resolveForSession(tx, {
        userId: USER,
        academyId: ACADEMY,
        cookieValue: cookie,
        userAgent: CHROME_MAC,
        maxDevices: 2,
      });
      expect(resolution.device).not.toBeNull();
      expect(resolution.atCapacity).toBe(false);
    }
  });

  it('returns the existing device and issues NO new cookie when the cookie matches', async () => {
    const cookieValue = 'known-cookie-value';
    const existing = deviceRow({ cookieHash: hashDeviceCookie(cookieValue) });
    const { tx, studentDevice } = fakeTx([existing]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });

    expect(result.device?.id).toBe(existing.id);
    expect(result.issueCookieValue).toBeNull(); // never re-issued for a known device
    expect(result.atCapacity).toBe(false);
    expect(result.activeDeviceCount).toBe(1);
    expect(studentDevice.create).not.toHaveBeenCalled();
  });

  it('touches lastSeenAt on the device it recognised', async () => {
    const cookieValue = 'known-cookie-value';
    const existing = deviceRow({ cookieHash: hashDeviceCookie(cookieValue) });
    const before = existing.lastSeenAt;
    const { tx, studentDevice } = fakeTx([existing]);

    await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue,
      maxDevices: 2,
    });

    expect(studentDevice.update).toHaveBeenCalledTimes(1);
    expect(existing.lastSeenAt.getTime()).toBeGreaterThan(before.getTime());
  });

  /*
   * A COOKIE IS NOT A BEARER CREDENTIAL FOR SOMEBODY ELSE'S ROW. The hash
   * is matched together with `userId` and `academyId`, so the same cookie
   * presented at a different academy — or by a different account — is
   * simply an unknown cookie.
   */
  it('does not accept a cookie registered at another academy', async () => {
    const cookieValue = 'cross-tenant-cookie';
    const foreign = deviceRow({
      academyId: 'academy-2',
      cookieHash: hashDeviceCookie(cookieValue),
    });
    const { tx, studentDevice } = fakeTx([foreign]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });

    expect(result.device?.id).not.toBe(foreign.id);
    expect(studentDevice.create).toHaveBeenCalledTimes(1); // registered here, freshly
    expect(result.issueCookieValue).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not accept another account's cookie", async () => {
    const cookieValue = 'someone-elses-cookie';
    const foreign = deviceRow({
      userId: 'user-2',
      cookieHash: hashDeviceCookie(cookieValue),
    });
    const { tx } = fakeTx([foreign]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue,
      maxDevices: 2,
    });

    expect(result.device?.id).not.toBe(foreign.id);
    expect(result.device?.userId).toBe(USER);
  });

  /* §R: TAMPERING. Not an error the learner sees. */
  it('treats an unknown or tampered cookie exactly like no cookie', async () => {
    const existing = deviceRow();
    const { tx, studentDevice } = fakeTx([existing]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: 'tampered-'.repeat(8),
      userAgent: CHROME_MAC,
      maxDevices: 3,
    });

    expect(result.device).not.toBeNull();
    expect(result.device?.id).not.toBe(existing.id);
    expect(result.issueCookieValue).not.toBeNull();
    expect(result.activeDeviceCount).toBe(2);
    expect(studentDevice.create).toHaveBeenCalledTimes(1);
  });

  /* §R: TAMPERING IS NOT A BYPASS. The cap still governs the re-registration. */
  it('does not let a tampered cookie bypass the device cap', async () => {
    const { tx, studentDevice } = fakeTx([deviceRow(), deviceRow()]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: 'forged-value-that-matches-nothing',
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });

    expect(result).toMatchObject({
      device: null,
      created: false,
      atCapacity: true,
      activeDeviceCount: 2,
    });
    // The forged value is never adopted: the browser is given a fresh,
    // server-minted identity instead, and nothing is registered.
    expect(result.issueCookieValue).toMatch(/^[0-9a-f]{64}$/);
    expect(result.issueCookieValue).not.toBe('forged-value-that-matches-nothing');
    expect(studentDevice.create).not.toHaveBeenCalled();
    expect(studentDevice.createMany).not.toHaveBeenCalled();
  });

  /*
   * AT THE CAP, NOBODY IS LOCKED OUT AND NOBODY IS GIVEN A THIRD DEVICE.
   * The session is issued with no device attached; CONTENT is what gets
   * refused, upstream, with `deviceLimit`.
   */
  /*
   * Device Identity + Device-Limit fix — the browser IS given an identity
   * at the cap. Issuing nothing here was the root cause of the limit
   * dialog loop: the browser stayed cookie-less, so once the learner freed
   * a slot the next grant registered a row it was never told about.
   */
  it('returns { device: null, atCapacity: true } at capacity, registers nothing, and gives the browser an identity', async () => {
    const { tx, studentDevice } = fakeTx([deviceRow(), deviceRow()]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: null,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });

    expect(result.device).toBeNull();
    expect(result.atCapacity).toBe(true);
    expect(result.created).toBe(false);
    expect(result.issueCookieValue).toMatch(/^[0-9a-f]{64}$/);
    expect(result.activeDeviceCount).toBe(2);
    expect(studentDevice.create).not.toHaveBeenCalled();
    expect(studentDevice.createMany).not.toHaveBeenCalled();
  });

  it('at capacity, a browser that already holds a well-formed identity keeps it', async () => {
    const { tx } = fakeTx([deviceRow(), deviceRow()]);
    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: 'a'.repeat(64),
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });
    expect(result).toMatchObject({ device: null, atCapacity: true, created: false });
    expect(result.issueCookieValue).toBeNull();
  });

  it('registers the identity the browser was given at the cap, once a slot frees — no new cookie, one row', async () => {
    const identity = 'b'.repeat(64);
    const { tx, rows, studentDevice } = fakeTx([deviceRow()]);
    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: identity,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });
    expect(result.created).toBe(true);
    expect(result.atCapacity).toBe(false);
    expect(result.issueCookieValue).toBeNull();
    expect(result.device?.cookieHash).toBe(hashDeviceCookie(identity));
    expect(
      rows.filter((row) => row.cookieHash === hashDeviceCookie(identity)),
    ).toHaveLength(1);
    expect(studentDevice.create).not.toHaveBeenCalled();

    // The next request from the same browser (another tab, the retry) is
    // RECOGNISED — no second row, nothing announced again.
    const again = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: identity,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });
    expect(again.created).toBe(false);
    expect(again.device?.id).toBe(result.device?.id);
    expect(rows).toHaveLength(2);
  });

  it('serialises registration per learner and academy (the cap is never raced)', async () => {
    const { tx, $queryRaw } = fakeTx([]);
    await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it("never reuses a removed device's identity — the browser is registered under a fresh one", async () => {
    const identity = 'c'.repeat(64);
    const removed = deviceRow({
      cookieHash: hashDeviceCookie(identity),
      revokedAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    const { tx } = fakeTx([removed]);
    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: identity,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });
    expect(result.created).toBe(true);
    expect(result.issueCookieValue).toMatch(/^[0-9a-f]{64}$/);
    expect(result.issueCookieValue).not.toBe(identity);
    expect(removed.revokedAt).not.toBeNull();
  });

  it('an identity another account holds (hidden by RLS) is not adopted, and does not abort the transaction', async () => {
    const identity = 'd'.repeat(64);
    const { tx, studentDevice } = fakeTx([], [hashDeviceCookie(identity)]);
    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: identity,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });
    expect(studentDevice.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(result.created).toBe(true);
    expect(result.issueCookieValue).toMatch(/^[0-9a-f]{64}$/);
    expect(result.issueCookieValue).not.toBe(identity);
    expect(result.device?.userId).toBe(USER);
  });

  it('registers below capacity and returns a new cookie value to write', async () => {
    const { tx, studentDevice, rows } = fakeTx([deviceRow()]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue: null,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });

    expect(result.atCapacity).toBe(false);
    expect(result.device).not.toBeNull();
    expect(result.activeDeviceCount).toBe(2);
    expect(studentDevice.create).toHaveBeenCalledTimes(1);

    // 32 random bytes, hex-encoded — opaque, server-minted, not derived
    // from anything about the browser.
    expect(result.issueCookieValue).toMatch(/^[0-9a-f]{64}$/);

    // And what was STORED is the hash of that value, never the value.
    const stored = rows[rows.length - 1];
    expect(stored.cookieHash).toBe(hashDeviceCookie(result.issueCookieValue as string));
    expect(stored.cookieHash).not.toBe(result.issueCookieValue);
    expect(stored.label).toBe('Chrome on macOS');
    expect(stored.userAgent).toBe(CHROME_MAC);
  });

  it('issues a different cookie value every time it registers', async () => {
    const { tx } = fakeTx([]);
    const first = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      maxDevices: 5,
    });
    const second = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      maxDevices: 5,
    });

    expect(first.issueCookieValue).not.toBe(second.issueCookieValue);
  });

  it('labels a registration with no User-Agent "Unknown device"', async () => {
    const { tx, rows } = fakeTx([]);

    await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      userAgent: null,
      maxDevices: 2,
    });

    expect(rows[0].label).toBe('Unknown device');
    expect(rows[0].userAgent).toBeNull();
  });

  /*
   * A REMOVED DEVICE FREES ITS SLOT. Rows are never hard-deleted (the
   * audit trail has to survive), so the cap has to count only the rows
   * that are still active.
   */
  it('does not count a revoked device against the cap', async () => {
    const { tx, studentDevice } = fakeTx([
      deviceRow(),
      deviceRow({ revokedAt: new Date('2026-09-10T00:00:00.000Z') }),
    ]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      userAgent: CHROME_MAC,
      maxDevices: 2,
    });

    expect(result.atCapacity).toBe(false);
    expect(studentDevice.create).toHaveBeenCalledTimes(1);
    expect(result.activeDeviceCount).toBe(2);
  });

  it('does not recognise the cookie of a revoked device', async () => {
    // Removing a device must mean the browser holding its cookie has to
    // register again and be counted again.
    const cookieValue = 'revoked-device-cookie';
    const revoked = deviceRow({
      cookieHash: hashDeviceCookie(cookieValue),
      revokedAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    const { tx, studentDevice } = fakeTx([revoked]);

    const result = await service.resolveForSession(tx, {
      userId: USER,
      academyId: ACADEMY,
      cookieValue,
      userAgent: CHROME_MAC,
      maxDevices: 1,
    });

    expect(result.device?.id).not.toBe(revoked.id);
    expect(studentDevice.create).toHaveBeenCalledTimes(1);
  });
});
