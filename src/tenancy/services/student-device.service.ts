/**
 * The learner device registry (master plan AD-10, D4, Phase 2 §D.7/§G).
 *
 * A DEVICE IS A SERVER-ISSUED COOKIE, NOT A FINGERPRINT.
 *
 * Phase 2 §G states this as a requirement and it is worth recording why,
 * because fingerprinting is the obvious shortcut. A fingerprint is
 * collected without the person's knowledge, is wrong often enough to lock
 * real learners out of their own courses (same phone model, same browser
 * build, a VPN), and cannot be shown to the person it describes. An opaque
 * value Atlas minted is the opposite on every count: the learner can see
 * it listed as "Chrome on macOS", rename it, and remove it — which is
 * exactly the Devices page this phase ships.
 *
 * The cookie value is stored HASHED, for the same reason
 * `refresh_tokens.token_hash` is: reading the table must not yield a
 * credential someone can replay.
 *
 * WHAT HAPPENS AT THE CAP. Reaching the device limit does NOT refuse
 * sign-in. A learner locked out of their own account because they opened a
 * third browser would have no way to remove a device, and the only route
 * left would be a support ticket. Instead the session is issued with no
 * device attached, CONTENT delivery is refused with `deviceLimit`, and the
 * learner is sent to a page listing their devices with a remove button.
 * Access to their own progress, orders and profile is never at stake.
 *
 * LIVES IN `TenancyModule`, not `LearningModule`, for the reason
 * `AcademyStudentsRepository`'s own comment already records: sign-in needs
 * it, `IdentityModule` depends on `TenancyModule`, and the reverse would
 * be a cycle.
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, StudentDevice } from '@prisma/client';

/** The cookie the browser carries. `atlas_` prefixed like every other Atlas-owned client value. */
export const DEVICE_COOKIE_NAME = 'atlas_device';

/** ~1 year. A device the learner keeps using should not silently become a "new" device and consume a second slot. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export interface DeviceResolution {
  /** Null when the learner is at their device cap — see the class comment. */
  readonly device: StudentDevice | null;
  /**
   * Set whenever the browser must be given a NEW device identity: it
   * presented none, or one that can never become a device (malformed, or
   * already known to the registry — a removed device, another account).
   * Issued AT THE CAP too, so that once the learner frees a slot this same
   * browser registers on its next request instead of minting yet another
   * row it would never be told about. Never re-issued for a device that
   * already exists.
   */
  readonly issueCookieValue: string | null;
  /** True only when this call inserted a new `student_devices` row — the one fact "New device added" announces. */
  readonly created: boolean;
  readonly atCapacity: boolean;
  readonly activeDeviceCount: number;
}

export function hashDeviceCookie(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The shape of every value `mintDeviceCookie` produces (32 random bytes, hex). */
const DEVICE_COOKIE_PATTERN = /^[0-9a-f]{64}$/;

function mintDeviceCookie(): string {
  return randomBytes(32).toString('hex');
}

/**
 * "Chrome on macOS" from a User-Agent.
 *
 * Deliberately coarse. This is a LABEL for a human to recognise their own
 * browser in a list, not a fingerprint: it records nothing that narrows
 * the device beyond what the person already knows about it, and an
 * unrecognised agent is honestly labelled "Unknown device" rather than
 * guessed at.
 */
export function deriveDeviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Firefox\//.test(userAgent)
          ? 'Firefox'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  const platform = /iPhone|iPad|iPod/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  return 'Unknown device';
}

@Injectable()
export class StudentDeviceService {
  /**
   * Finds the device this request is coming from, or registers it.
   *
   * The cookie is matched against `userId` AND `academyId` as well as its
   * own hash: a cookie is not a bearer credential for somebody else's
   * device row, and a device registered at one academy must not silently
   * satisfy another academy's cap.
   */
  async resolveForSession(
    tx: Prisma.TransactionClient,
    args: {
      readonly userId: string;
      readonly academyId: string;
      readonly cookieValue?: string | null;
      readonly userAgent?: string | null;
      readonly maxDevices: number;
    },
  ): Promise<DeviceResolution> {
    const activeWhere = {
      userId: args.userId,
      academyId: args.academyId,
      revokedAt: null,
    } as const;

    // A RECOGNISED device: the cookie names one of this learner's active
    // devices at this academy.
    const recognised = await this.findActive(
      tx,
      args.userId,
      args.academyId,
      args.cookieValue,
    );
    if (recognised)
      return this.touchRecognised(tx, recognised, activeWhere, args.maxDevices);

    // Device identity lifecycle (Device Identity + Device-Limit fix).
    //
    // ROOT CAUSE this replaces: an unrecognised browser used to be given a
    // freshly minted value on the INSERT alone. Sign-in could hand it to the
    // browser, but the lesson grant — which also registers — has no way to,
    // and sign-in at the cap issued nothing at all. So a browser that signed
    // in while the learner was at their limit stayed cookie-less: removing a
    // device from the limit dialog freed a slot, the very next grant
    // registered a row the browser was never told about (announcing "New
    // device added"), and the request after it was refused with
    // `deviceLimit` again — the dialog "did nothing", and every retry added
    // another identical row and another notification.
    //
    // Now the browser always holds an identity (issued at the cap too), and
    // an unrecognised browser registers THE IDENTITY IT PRESENTS. The
    // registry stays server-authoritative: the cap is counted here, under a
    // per-learner lock, never trusted from the client; a value already
    // known to the registry (a removed device's cookie, another account's)
    // is never reused — a removed device cannot come back as itself.
    await this.lockRegistry(tx, args.userId, args.academyId);
    // Re-checked under the lock: a concurrent request from another tab of
    // this same browser may have just registered this very identity.
    const registeredMeanwhile = await this.findActive(
      tx,
      args.userId,
      args.academyId,
      args.cookieValue,
    );
    if (registeredMeanwhile) {
      return this.touchRecognised(tx, registeredMeanwhile, activeWhere, args.maxDevices);
    }

    let identity =
      args.cookieValue && DEVICE_COOKIE_PATTERN.test(args.cookieValue)
        ? args.cookieValue
        : null;
    if (identity) {
      // RLS shows this learner's own rows only: a value another account
      // holds is invisible here and is caught by the unique index below.
      const known = await tx.studentDevice.count({
        where: { cookieHash: hashDeviceCookie(identity) },
      });
      if (known > 0) identity = null;
    }

    const activeDeviceCount = await tx.studentDevice.count({ where: activeWhere });
    if (activeDeviceCount >= args.maxDevices) {
      return {
        device: null,
        issueCookieValue: identity ? null : mintDeviceCookie(),
        created: false,
        atCapacity: true,
        activeDeviceCount,
      };
    }

    const label = deriveDeviceLabel(args.userAgent ?? undefined);
    let issueCookieValue: string | null = null;
    let inserted = 0;
    if (identity) {
      // `skipDuplicates` (ON CONFLICT DO NOTHING): a collision with a row
      // RLS hides must not abort the transaction around it.
      inserted = (
        await tx.studentDevice.createMany({
          data: [
            {
              userId: args.userId,
              academyId: args.academyId,
              cookieHash: hashDeviceCookie(identity),
              label,
              userAgent: args.userAgent ?? null,
            },
          ],
          skipDuplicates: true,
        })
      ).count;
    }
    if (inserted === 0) {
      identity = mintDeviceCookie();
      issueCookieValue = identity;
      await tx.studentDevice.create({
        data: {
          userId: args.userId,
          academyId: args.academyId,
          cookieHash: hashDeviceCookie(identity),
          label,
          userAgent: args.userAgent ?? null,
        },
      });
    }
    const device = await tx.studentDevice.findFirst({
      where: { ...activeWhere, cookieHash: hashDeviceCookie(identity as string) },
    });
    return {
      device,
      issueCookieValue,
      created: true,
      atCapacity: false,
      activeDeviceCount: activeDeviceCount + 1,
    };
  }

  private async findActive(
    tx: Prisma.TransactionClient,
    userId: string,
    academyId: string,
    cookieValue: string | null | undefined,
  ): Promise<StudentDevice | null> {
    // A cookie that matches nothing is treated exactly like no cookie: an
    // unknown or tampered value must never be an error the learner sees,
    // and must never bypass the cap (Phase 2 §R).
    if (!cookieValue) return null;
    return tx.studentDevice.findFirst({
      where: {
        userId,
        academyId,
        revokedAt: null,
        cookieHash: hashDeviceCookie(cookieValue),
      },
    });
  }

  /**
   * A RECOGNISED DEVICE IS STILL SUBJECT TO THE CAP.
   *
   * Checking the cap only at registration would make an owner's device
   * policy (D8) unable to take effect on anyone who already has devices:
   * lowering the limit from three to two — the exact action an owner takes
   * when they suspect sharing — would change nothing, because all three
   * were already registered.
   *
   * Which devices keep working is decided by REGISTRATION ORDER, oldest
   * first. That is the only ordering that is stable: ranking by last-seen
   * would reshuffle on every request, so a learner bouncing between two
   * browsers over a cap of one would lock each out in turn. Ties on
   * `createdAt` (millisecond precision) are broken by id, so every active
   * device has a distinct rank and the cap is never exceeded by a tie.
   */
  private async touchRecognised(
    tx: Prisma.TransactionClient,
    existing: StudentDevice,
    activeWhere: { userId: string; academyId: string; revokedAt: null },
    maxDevices: number,
  ): Promise<DeviceResolution> {
    const rank = await tx.studentDevice.count({
      where: {
        ...activeWhere,
        OR: [
          { createdAt: { lt: existing.createdAt } },
          { createdAt: existing.createdAt, id: { lt: existing.id } },
        ],
      },
    });
    if (rank >= maxDevices) {
      return {
        device: null,
        issueCookieValue: null,
        created: false,
        atCapacity: true,
        activeDeviceCount: await tx.studentDevice.count({ where: activeWhere }),
      };
    }
    const touched = await tx.studentDevice.update({
      where: { id: existing.id },
      data: { lastSeenAt: new Date() },
    });
    return {
      device: touched,
      issueCookieValue: null,
      created: false,
      atCapacity: false,
      activeDeviceCount: await tx.studentDevice.count({ where: activeWhere }),
    };
  }

  /**
   * Serialises registration per learner per academy for the rest of the
   * transaction, so two simultaneous requests (two tabs, two browsers at
   * once) cannot both read "one slot left" and both take it.
   */
  private async lockRegistry(
    tx: Prisma.TransactionClient,
    userId: string,
    academyId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`student_devices:${userId}:${academyId}`}, 0))) AS l`;
  }

  listActive(
    tx: Prisma.TransactionClient,
    userId: string,
    academyId: string,
  ): Promise<StudentDevice[]> {
    return tx.studentDevice.findMany({
      where: { userId, academyId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Removes a device. Scoped to the caller's own rows by the `userId`
   * filter AND by `student_devices_self_all` RLS — the service check and
   * the policy independently agree, which is the repository's standing
   * discipline for anything a learner can address by id.
   */
  async revokeOwn(
    tx: Prisma.TransactionClient,
    userId: string,
    deviceId: string,
  ): Promise<StudentDevice | null> {
    const updated = await tx.studentDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (updated.count === 0) return null;
    return tx.studentDevice.findUnique({ where: { id: deviceId } });
  }

  /** Owner-initiated reset of one learner's whole registry for this academy (Phase 2 §D.7). */
  async revokeAllForStudent(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<number> {
    const result = await tx.studentDevice.updateMany({
      where: { academyId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
