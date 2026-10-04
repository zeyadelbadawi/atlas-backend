/**
 * TrialEligibilityService — THE single authoritative answer to "may this
 * subject receive a Free Trial?".
 *
 * WHY THIS EXISTS. Before Phase 10.1 the answer was implicitly "always
 * yes": `OrganizationSubscriptionBootstrapService` granted a trial to
 * every newly created Organization, unconditionally. Since any
 * authenticated user may create any number of Organizations (see
 * `SaasLevelCallerGuard` — creating an additional Organization is a
 * legitimate, supported action), one account could mint unlimited
 * trials. This was confirmed against the running application: three
 * trials in under a second from one user, with no change of email,
 * device, browser, IP or network.
 *
 * ONE DECISION POINT. Every path capable of granting a trial must call
 * `claimTrial`. There is deliberately no "check then grant" pair exposed:
 * a separate `isEligible()` used as a gate would be a
 * read-then-write race, and callers would eventually use it as the
 * enforcement point. `claimTrial` decides and records atomically, in the
 * caller's existing transaction, and its return value IS the decision.
 * `describeEligibility` exists only for read-only display and says so.
 *
 * WHAT IDENTIFIES A SUBJECT. A keyed hash of the canonical email (see
 * `trial-subject.util.ts` and `CustomerIdentityHasher`), which collapses
 * plus-addressing and, on providers that ignore them, dots.
 *
 * HASH VERSIONS (W8B). New claims store the v2 HMAC (server key). Pre-W8
 * rows hold the v1 constant-salt SHA-256 and are FROZEN — nothing inserts
 * a v1 row any more — so every claim and describe also checks the v1 digest
 * of the same address. Because v1 rows never appear concurrently, that
 * extra read is race-free; the v2 INSERT ... ON CONFLICT remains the one
 * atomic decision. v1 rows of deleted users can never be upgraded (no raw
 * address survives), so the v1 check stays for as long as such rows exist. The email is the only signal in this
 * system that is both durable and tied to identity rather than to
 * infrastructure. Deliberately NOT used as identity: IP address, device,
 * browser, user agent, or any client-supplied value — all are trivially
 * changed by an abuser and, worse, are SHARED by unrelated legitimate
 * users behind one company NAT, university, or mobile carrier. Blocking
 * on them would punish exactly the wrong people. They are recorded as
 * forensic signals and never read by this decision.
 *
 * WHAT THIS DOES NOT CLAIM. It does not prove two accounts belong to one
 * human — no technical system can establish that from network or device
 * signals. It makes trial farming cost a genuinely new, deliverable,
 * non-disposable mailbox each time, which is the practical bar. That bar
 * is only meaningful alongside the disposable-domain block and email
 * verification enforced at registration; those three layers are one
 * mechanism and weakening any of them weakens all of them.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CURRENT_SUBJECT_HASH_VERSION,
  CustomerIdentityHasher,
} from './customer-identity-hasher.service';

/** Forensic-only context. Recorded, never used to decide eligibility. */
export interface TrialClaimContext {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface TrialClaimInput {
  /** The prospective trial owner's email. Hashed immediately; never persisted in the clear. */
  readonly email: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly trialEndsAt: Date;
  readonly context?: TrialClaimContext;
}

export interface TrialClaimResult {
  /** True only when THIS call won the claim. A caller that sees `false` must not grant a trial. */
  readonly granted: boolean;
  /** Why it was refused, for logging and for the honest UI message. Absent when granted. */
  readonly reason?: 'already_redeemed';
}

@Injectable()
export class TrialEligibilityService {
  private readonly logger = new Logger(TrialEligibilityService.name);

  constructor(private readonly hasher: CustomerIdentityHasher) {}

  /**
   * Atomically claims the one Free Trial available to this subject.
   *
   * CONCURRENCY. The claim is a single INSERT ... ON CONFLICT DO NOTHING
   * against a UNIQUE index. Two simultaneous requests for the same
   * subject both attempt it, Postgres serialises them, and exactly one
   * inserts a row — the other's `count` comes back `0` and is refused.
   * There is no read-then-write window, so no amount of request
   * interleaving, retrying, or duplicate webhook delivery can produce two
   * trials.
   *
   * The INSERT runs in the CALLER'S transaction (`tx`), which is the
   * same transaction that creates the Organization and its subscription.
   * That coupling is deliberate and load-bearing: if organization
   * creation later fails and rolls back, the redemption rolls back with
   * it, so a failed signup never silently burns the user's one trial.
   *
   * @returns whether this caller may grant a trial. Never throws for the
   *          ordinary "already used" case — that is a normal business
   *          outcome, not an error.
   */
  async claimTrial(
    tx: Prisma.TransactionClient,
    input: TrialClaimInput,
  ): Promise<TrialClaimResult> {
    const { v2: subjectHash, v1: legacyHash } = this.hasher.subjectHashes(input.email);

    // Legacy (v1) redemption of the same mailbox: refused. v1 rows are
    // frozen, so this read cannot race a concurrent v1 insert. A v2 copy is
    // written opportunistically (ON CONFLICT DO NOTHING, in the caller's
    // transaction) so the subject is recognised under the current key too.
    const legacy = await tx.trialRedemption.findUnique({
      where: { subjectHash: legacyHash },
      select: {
        organizationId: true,
        redeemedByUserId: true,
        redeemedAt: true,
        trialEndsAt: true,
      },
    });
    if (legacy) {
      await tx.trialRedemption.createMany({
        data: [
          {
            subjectHash,
            hashVersion: CURRENT_SUBJECT_HASH_VERSION,
            source: 'v1_upgrade',
            organizationId: legacy.organizationId,
            redeemedByUserId: legacy.redeemedByUserId,
            redeemedAt: legacy.redeemedAt,
            trialEndsAt: legacy.trialEndsAt,
          },
        ],
        skipDuplicates: true,
      });
      this.logger.log(
        { organizationId: input.organizationId, hashVersion: 1 },
        'Free Trial refused — this subject has already redeemed one.',
      );
      return { granted: false, reason: 'already_redeemed' };
    }

    // `createMany({ skipDuplicates })` compiles to INSERT ... ON CONFLICT
    // DO NOTHING, and `count` reports whether the row was actually
    // inserted. That distinction matters enormously here.
    //
    // The obvious implementation — `create()` inside a try/catch for
    // P2002 — is WRONG in this context and was caught doing real damage
    // during verification. Postgres aborts the entire transaction as soon
    // as any statement raises, so the unique violation poisoned the
    // caller's transaction and every subsequent statement failed: the
    // organization itself was never created, and callers saw an opaque
    // 500 instead of "no trial for you". Catching the error in
    // application code cannot rescue a transaction the database has
    // already marked as failed.
    //
    // ON CONFLICT DO NOTHING never raises, so the transaction stays
    // healthy and organization creation proceeds normally — while the
    // conflict resolution itself remains atomic inside the database, so
    // the race guarantee is fully preserved.
    const inserted = await tx.trialRedemption.createMany({
      data: [
        {
          subjectHash,
          hashVersion: CURRENT_SUBJECT_HASH_VERSION,
          source: 'claim',
          organizationId: input.organizationId,
          redeemedByUserId: input.userId,
          trialEndsAt: input.trialEndsAt,
          ipAddress: input.context?.ipAddress,
          userAgent: input.context?.userAgent,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 1) return { granted: true };

    // The subject has consumed their trial already — either long ago, or
    // microseconds ago in a concurrent request that won the race. Both
    // are the same answer. Logged with neither the address nor any digest
    // of it — the organization id is enough to correlate.
    this.logger.log(
      { organizationId: input.organizationId, hashVersion: CURRENT_SUBJECT_HASH_VERSION },
      'Free Trial refused — this subject has already redeemed one.',
    );
    return { granted: false, reason: 'already_redeemed' };
  }

  /**
   * Read-only eligibility, for display purposes ONLY.
   *
   * Never use this to gate a grant. Between this read and any subsequent
   * write another request can claim the trial, and callers that "check"
   * here and then grant would reintroduce exactly the race `claimTrial`
   * exists to eliminate. The frontend may show this; nothing may enforce
   * on it.
   */
  async describeEligibility(
    tx: Prisma.TransactionClient,
    email: string,
  ): Promise<{ eligible: boolean }> {
    const { v2, v1 } = this.hasher.subjectHashes(email);
    const existing = await tx.trialRedemption.findFirst({
      where: { subjectHash: { in: [v2, v1] } },
      select: { id: true },
    });
    return { eligible: existing === null };
  }
}
