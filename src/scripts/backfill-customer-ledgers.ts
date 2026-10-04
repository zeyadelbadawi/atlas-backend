/**
 * W8B — backfill the customer-identity ledgers for customers who used a
 * trial (or paid) BEFORE the ledgers existed.
 *
 * STATUS: APPROVED FOR PRODUCTION by the product owner on 4 Oct 2026, run
 * with `--gifts` and WITHOUT `--include-auto-trial-era` (that era is
 * inferred from an organization's creation date, not evidence that a trial
 * was used, so it is not recorded). Production runs go through the
 * `Customer ledger backfill` workflow (deploy/ledger-backfill/remote.sh),
 * which pins `CUSTOMER_IDENTITY_HMAC_KEY` first and takes a data-only dump
 * of both ledgers before `--apply`. The script still refuses a production
 * environment unless `--allow-production` is passed. Running it locally
 * against test data is fine.
 *
 * WHAT IT DOES. Collects evidence that an email has already consumed a
 * benefit, canonicalizes + HMACs it exactly like the application
 * (`customerSubjectHashV2`, same key resolution as `CustomerIdentityHasher`),
 * and — only with `--apply` — inserts ledger rows with
 * `INSERT ... ON CONFLICT DO NOTHING` and `source = 'backfill'`. Idempotent:
 * subjects already in a ledger (v1 or v2) are filtered out first, and
 * `skipDuplicates` covers a concurrent claim, so a second run inserts
 * nothing.
 *
 *   Trials (always considered), strongest evidence first:
 *     (a) audit entries `subscription.trial.redeemed` → the actor's email;
 *     (b) `subscription_cancellations.kind = 'trial'` → the org owner;
 *     (c) `tenant_subscriptions` with status trialing / trial_expired or a
 *         `trial_ends_at` → the org owner;
 *     (d) ONLY with `--include-auto-trial-era`: every organization created
 *         before the trial ledger migration (the P4–P33 era, when every new
 *         organization was auto-granted a trial) → the org owner. NOT
 *         approved for production.
 *   Gifts (only with `--gifts`): owners of organizations with a succeeded
 *     plan-subscription payment → a `paid_gift_redemptions` row carrying no
 *     gift (gifted_days NULL), so "first-ever paid subscription" means first
 *     ever, not first since launch, across all of that owner's organizations.
 *
 * Deleted / anonymised accounts are skipped and counted: their addresses no
 * longer exist, so they cannot be recovered (accepted residual).
 *
 * OUTPUT IS COUNTS ONLY. No email, canonical address or digest is printed.
 * Every mode ends with the ledger state: rows by source (and hash version
 * for trials), duplicate subject hashes per table (0 — both are UNIQUE),
 * and backfill gift rows carrying gifted days (0 — a backfill row is never
 * a gift). `--verify` prints only that state and the key check; it reads
 * nothing else and writes nothing, and exits non-zero if an invariant
 * does not hold.
 *
 * KEY SAFETY. Rows hashed under the wrong key are worthless (they match
 * nobody) and would mask the mistake. Before writing, the script recomputes
 * a sample of existing v2 trial rows whose redeemer is still a live account;
 * if v2 rows exist and none match, it aborts.
 *
 * Usage (DATABASE_URL = the migration/superuser connection; the app's
 * PAYMENT_CREDENTIALS_ENCRYPTION_KEY / CUSTOMER_IDENTITY_HMAC_KEY):
 *   node dist/scripts/backfill-customer-ledgers.js              # dry run
 *   node dist/scripts/backfill-customer-ledgers.js --apply      # write
 *   node dist/scripts/backfill-customer-ledgers.js --verify     # read-only state
 *   ... [--gifts] [--include-auto-trial-era] [--allow-production]
 * In production, inside the running backend container (via the workflow):
 *   docker compose exec -T backend node dist/scripts/backfill-customer-ledgers.js \
 *     --gifts --allow-production [--apply | --verify]
 * From a checkout without a build:
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfill-customer-ledgers.ts
 */
/* eslint-disable no-console -- an operator CLI: counts on stdout are its interface. */
import { Prisma, PrismaClient } from '@prisma/client';
import { customerIdentityKeyFromEnv } from '../plans/utils/customer-identity-key.util';
import {
  customerSubjectHashV2,
  legacySubjectHashV1,
} from '../plans/utils/trial-subject.util';

const TRIAL_LEDGER_MIGRATION = '20260911000000_p33_trial_redemption_history';
const DELETED_EMAIL = /^deleted-.*@account\.invalid$/i;

interface Evidence {
  readonly email: string;
  readonly userStatus: string;
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly at: Date | null;
}

interface Options {
  readonly apply: boolean;
  readonly verify: boolean;
  readonly gifts: boolean;
  readonly autoTrialEra: boolean;
  readonly allowProduction: boolean;
}

const KNOWN_FLAGS = new Set([
  '--apply',
  '--verify',
  '--gifts',
  '--include-auto-trial-era',
  '--allow-production',
]);

function parseOptions(argv: readonly string[]): Options {
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option(s): ${unknown.join(' ')}. Nothing was read or written.`,
    );
  }
  const options = {
    apply: argv.includes('--apply'),
    verify: argv.includes('--verify'),
    gifts: argv.includes('--gifts'),
    autoTrialEra: argv.includes('--include-auto-trial-era'),
    allowProduction: argv.includes('--allow-production'),
  };
  if (options.apply && options.verify) {
    throw new Error('--verify is read-only; it cannot be combined with --apply.');
  }
  return options;
}

function isProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return [env.NODE_ENV, env.APP_ENV, env.ATLAS_ENV, env.SENTRY_ENVIRONMENT]
    .filter(Boolean)
    .some((v) => /^prod/i.test(String(v)));
}

async function trialEvidence(
  prisma: PrismaClient,
  autoTrialEra: boolean,
): Promise<Evidence[]> {
  const rows = await prisma.$queryRaw<
    {
      email: string;
      status: string;
      user_id: string | null;
      organization_id: string | null;
      at: Date | null;
    }[]
  >(Prisma.sql`
    -- (a) audited redemptions: the actor redeemed it
    SELECT u.email, u.status::text AS status, u.id AS user_id, a.organization_id, a.occurred_at AS at
      FROM audit_log_entries a JOIN users u ON u.id = a.actor_user_id
     WHERE a.action = 'subscription.trial.redeemed'
    UNION ALL
    -- (b) trial cancellations: the org owner
    SELECT u.email, u.status::text, u.id, o.id, c.cancelled_at
      FROM subscription_cancellations c
      JOIN organizations o ON o.id = c.organization_id
      JOIN users u ON u.id = o.owner_user_id
     WHERE c.kind = 'trial'
    UNION ALL
    -- (c) trial subscriptions: the org owner
    SELECT u.email, u.status::text, u.id, o.id, COALESCE(s.trial_ends_at, s.created_at)
      FROM tenant_subscriptions s
      JOIN organizations o ON o.id = s.organization_id
      JOIN users u ON u.id = o.owner_user_id
     WHERE s.status IN ('trialing', 'trial_expired') OR s.trial_ends_at IS NOT NULL
  `);
  const evidence = rows.map((r) => ({
    email: r.email,
    userStatus: r.status,
    userId: r.user_id,
    organizationId: r.organization_id,
    at: r.at,
  }));
  if (autoTrialEra) {
    const era = await prisma.$queryRaw<
      {
        email: string;
        status: string;
        user_id: string;
        organization_id: string;
        at: Date;
      }[]
    >(Prisma.sql`
      SELECT u.email, u.status::text AS status, u.id AS user_id, o.id AS organization_id, o.created_at AS at
        FROM organizations o JOIN users u ON u.id = o.owner_user_id
       WHERE o.created_at < (
         SELECT finished_at FROM _prisma_migrations
          WHERE migration_name = ${TRIAL_LEDGER_MIGRATION} AND finished_at IS NOT NULL
          LIMIT 1)
    `);
    evidence.push(
      ...era.map((r) => ({
        email: r.email,
        userStatus: r.status,
        userId: r.user_id,
        organizationId: r.organization_id,
        at: r.at,
      })),
    );
  }
  return evidence;
}

async function giftEvidence(prisma: PrismaClient): Promise<Evidence[]> {
  const rows = await prisma.$queryRaw<
    {
      email: string;
      status: string;
      user_id: string;
      organization_id: string;
      at: Date;
    }[]
  >(Prisma.sql`
    SELECT u.email, u.status::text AS status, u.id AS user_id, o.id AS organization_id,
           MIN(p.created_at) AS at
      FROM payments p
      JOIN checkouts c ON c.id = p.checkout_id
      JOIN organizations o ON o.id = p.organization_id
      JOIN users u ON u.id = o.owner_user_id
     WHERE p.status = 'succeeded' AND c.target_type = 'plan_subscription'
     GROUP BY u.email, u.status, u.id, o.id
  `);
  return rows.map((r) => ({
    email: r.email,
    userStatus: r.status,
    userId: r.user_id,
    organizationId: r.organization_id,
    at: r.at,
  }));
}

/** Postgres caps bind parameters at 32767; look hashes up in safe chunks. */
async function inChunks<T>(
  values: readonly string[],
  fn: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += 5000) {
    out.push(...(await fn(values.slice(i, i + 5000))));
  }
  return out;
}

/** One subject per canonical identity, earliest evidence wins. */
function bySubject(evidence: readonly Evidence[], key: Buffer) {
  let unrecoverable = 0;
  const subjects = new Map<string, { v1: string; e: Evidence }>();
  for (const e of evidence) {
    if (!e.email || e.userStatus === 'deleted' || DELETED_EMAIL.test(e.email)) {
      unrecoverable += 1;
      continue;
    }
    const v2 = customerSubjectHashV2(e.email, key);
    const current = subjects.get(v2);
    if (!current || (e.at && current.e.at && e.at < current.e.at)) {
      subjects.set(v2, { v1: legacySubjectHashV1(e.email), e });
    }
  }
  return { subjects, unrecoverable };
}

async function assertKeyMatchesApplication(
  prisma: PrismaClient,
  key: Buffer,
): Promise<string> {
  const sample = await prisma.$queryRaw<
    { subject_hash: string; email: string }[]
  >(Prisma.sql`
    SELECT t.subject_hash, u.email
      FROM trial_redemptions t JOIN users u ON u.id = t.redeemed_by_user_id
     WHERE t.hash_version = 2 AND t.source = 'claim' AND u.status <> 'deleted'
     ORDER BY t.redeemed_at DESC
     LIMIT 25
  `);
  if (sample.length === 0) return 'no live v2 rows to compare yet (key not verifiable)';
  const matches = sample.filter(
    (r) => customerSubjectHashV2(r.email, key) === r.subject_hash,
  ).length;
  if (matches === 0) {
    throw new Error(
      `Key check FAILED: 0/${sample.length} recent v2 trial rows match. This environment's identity key differs from the application's. Nothing was written.`,
    );
  }
  return `${matches}/${sample.length} recent v2 trial rows match`;
}

/**
 * The ledgers' state, counts only. Returns false when an invariant fails:
 * a duplicate subject hash (impossible under the UNIQUE constraints) or a
 * backfill gift row that carries gifted days.
 */
async function reportLedgerState(prisma: PrismaClient, label: string): Promise<boolean> {
  const trials = await prisma.$queryRaw<
    { source: string; hash_version: number; n: number }[]
  >(
    Prisma.sql`
      SELECT source, hash_version::int AS hash_version, count(*)::int AS n
        FROM trial_redemptions GROUP BY source, hash_version ORDER BY source, hash_version
    `,
  );
  const gifts = await prisma.$queryRaw<{ source: string; n: number }[]>(Prisma.sql`
    SELECT source, count(*)::int AS n FROM paid_gift_redemptions GROUP BY source ORDER BY source
  `);
  const [inv] = await prisma.$queryRaw<
    { trial_dups: number; gift_dups: number; backfill_gifted: number }[]
  >(Prisma.sql`
    SELECT
      (SELECT count(*)::int FROM (SELECT 1 FROM trial_redemptions
         GROUP BY subject_hash HAVING count(*) > 1) d) AS trial_dups,
      (SELECT count(*)::int FROM (SELECT 1 FROM paid_gift_redemptions
         GROUP BY subject_hash HAVING count(*) > 1) d) AS gift_dups,
      (SELECT count(*)::int FROM paid_gift_redemptions
        WHERE source = 'backfill' AND gifted_days IS NOT NULL) AS backfill_gifted
  `);
  console.log(`Ledger state (${label}):`);
  console.log('  trial_redemptions by source / hash_version:');
  if (trials.length === 0) console.log('    (none)');
  for (const r of trials) {
    console.log(`    ${r.source.padEnd(12)} v${r.hash_version}  ${r.n}`);
  }
  console.log('  paid_gift_redemptions by source:');
  if (gifts.length === 0) console.log('    (none)');
  for (const r of gifts) console.log(`    ${r.source.padEnd(12)}     ${r.n}`);
  const trialBackfill = trials
    .filter((r) => r.source === 'backfill')
    .reduce((s, r) => s + r.n, 0);
  const giftBackfill = gifts.find((r) => r.source === 'backfill')?.n ?? 0;
  console.log(
    `  backfill rows (trials, gifts):            ${trialBackfill}, ${giftBackfill}`,
  );
  console.log(
    `  duplicate subject_hash (trials, gifts):   ${inv.trial_dups}, ${inv.gift_dups}`,
  );
  console.log(`  backfill gift rows with gifted_days:      ${inv.backfill_gifted}`);
  const ok = inv.trial_dups === 0 && inv.gift_dups === 0 && inv.backfill_gifted === 0;
  console.log(`  invariants:                               ${ok ? 'OK' : 'VIOLATED'}`);
  return ok;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (isProductionEnvironment(process.env) && !options.allowProduction) {
    throw new Error(
      'Refusing to run against production without --allow-production (approved 4 Oct 2026; use the Customer ledger backfill workflow).',
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL must be set (the migration/superuser connection).');

  const key = customerIdentityKeyFromEnv();
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (options.verify) {
      console.log('Mode: VERIFY (read-only)');
      let keyOk = true;
      try {
        console.log(`Key check: ${await assertKeyMatchesApplication(prisma, key)}`);
      } catch (error) {
        keyOk = false;
        console.log(error instanceof Error ? error.message : 'Key check failed.');
      }
      const ok = await reportLedgerState(prisma, 'current');
      if (!ok || !keyOk) process.exitCode = 1;
      return;
    }

    console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
    console.log(`Key check: ${await assertKeyMatchesApplication(prisma, key)}`);

    // ---- trials ----
    const trial = bySubject(await trialEvidence(prisma, options.autoTrialEra), key);
    const trialHashes = [...trial.subjects.entries()].flatMap(([v2, s]) => [v2, s.v1]);
    const knownTrial = new Set(
      (
        await inChunks(trialHashes, (chunk) =>
          prisma.trialRedemption.findMany({
            where: { subjectHash: { in: chunk } },
            select: { subjectHash: true },
          }),
        )
      ).map((r) => r.subjectHash),
    );
    const trialToInsert = [...trial.subjects.entries()].filter(
      ([v2, s]) => !knownTrial.has(v2) && !knownTrial.has(s.v1),
    );
    let trialInserted = 0;
    if (options.apply && trialToInsert.length > 0) {
      const result = await prisma.trialRedemption.createMany({
        data: trialToInsert.map(([v2, s]) => ({
          subjectHash: v2,
          hashVersion: 2,
          source: 'backfill',
          organizationId: s.e.organizationId,
          redeemedByUserId: s.e.userId,
          redeemedAt: s.e.at ?? new Date(),
        })),
        skipDuplicates: true,
      });
      trialInserted = result.count;
    }
    console.log('Trials:');
    console.log(`  subjects with evidence:        ${trial.subjects.size}`);
    console.log(
      `  already in ledger (v1 or v2):  ${trial.subjects.size - trialToInsert.length}`,
    );
    console.log(`  to record:                     ${trialToInsert.length}`);
    console.log(`  recorded:                      ${trialInserted}`);
    console.log(`  unrecoverable (deleted users): ${trial.unrecoverable}`);
    console.log(
      `  auto-trial era included:       ${options.autoTrialEra ? 'yes' : 'no'}`,
    );

    // ---- gifts ----
    if (options.gifts) {
      const gift = bySubject(await giftEvidence(prisma), key);
      const known = new Set(
        (
          await inChunks([...gift.subjects.keys()], (chunk) =>
            prisma.paidGiftRedemption.findMany({
              where: { subjectHash: { in: chunk } },
              select: { subjectHash: true },
            }),
          )
        ).map((r) => r.subjectHash),
      );
      const toInsert = [...gift.subjects.entries()].filter(([v2]) => !known.has(v2));
      let inserted = 0;
      if (options.apply && toInsert.length > 0) {
        const result = await prisma.paidGiftRedemption.createMany({
          data: toInsert.map(([v2, s]) => ({
            subjectHash: v2,
            hashVersion: 2,
            source: 'backfill',
            organizationId: s.e.organizationId,
            redeemedByUserId: s.e.userId,
            giftedDays: null,
            redeemedAt: s.e.at ?? new Date(),
          })),
          skipDuplicates: true,
        });
        inserted = result.count;
      }
      console.log('Gifts (prior paying customers):');
      console.log(`  subjects with evidence:        ${gift.subjects.size}`);
      console.log(
        `  already in ledger:             ${gift.subjects.size - toInsert.length}`,
      );
      console.log(`  to record:                     ${toInsert.length}`);
      console.log(`  recorded:                      ${inserted}`);
      console.log(`  unrecoverable (deleted users): ${gift.unrecoverable}`);
    }

    const ok = await reportLedgerState(
      prisma,
      options.apply ? 'after apply' : 'unchanged, dry run',
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Backfill failed.');
  process.exit(1);
});
