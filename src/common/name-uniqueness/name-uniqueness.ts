/**
 * W4 — uniqueness of organization names, academy names and learner names
 * within an academy.
 *
 * THE RULES (product defaults; see docs/W4_UNIQUENESS_REMEDIATION.md)
 *   - Organizations: unique platform-wide across every status.
 *   - Academies: unique platform-wide across every status, archived included.
 *   - Learners: unique per academy on the ACCOUNT name (`users.name`), through
 *     `academy_students.name_key`. Interactive admissions are refused with a
 *     409; automatic admissions never fail — they insert the row
 *     `name_unique_exempt` and record the clash.
 *   - Names compare by `atlas_name_key()` (SQL, authoritative).
 *
 * HOW A WRITE STAYS CORRECT UNDER CONCURRENCY AND RLS
 *   1. Inside the write transaction, take a transaction-scoped advisory lock
 *      on the name key, so two writers of the same key serialize.
 *   2. Ask a boolean SECURITY DEFINER check (RLS hides other tenants' rows
 *      from the caller, by design; the check answers one fact and never says
 *      who holds the name). Under READ COMMITTED the second writer's check
 *      sees the first writer's committed row.
 *   3. Write. The unique index is still the final truth (scripts, seeds,
 *      anything that skipped steps 1–2).
 *   4. Under FORCE RLS PostgreSQL omits the 23505 DETAIL and Prisma reports
 *      `target: "(not available)"`, so a P2002 cannot be attributed by
 *      inspection. It is CLASSIFIED by asking the check again — in a savepoint
 *      or a fresh transaction — exactly as `AuthService.isEmailConflict`
 *      settles an unnamed email conflict.
 *
 * Lock strings (also used by the SQL function
 * `academy_learner_admission_name_taken`, which must stay identical):
 *   'org-name:'      || key
 *   'academy-name:'  || key
 *   'learner-name:'  || academy_id || ':' || key
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type SqlClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export const NAME_ERROR_KEYS = {
  invalid: 'errors.validation.nameInvalid',
  organizationUnavailable: 'errors.organization.nameUnavailable',
  academyTaken: 'errors.academy.nameTaken',
  learnerTaken: 'errors.academy.learnerNameTaken',
  learnerTakenExistingAccount: 'errors.academy.learnerNameTakenExistingAccount',
  profileTakenInAcademy: 'errors.profile.nameTakenInAcademy',
} as const;

/** Prisma's unique-violation code — the cause is unknown until classified. */
export function isUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** The authoritative key, computed by the database. */
export async function sqlNameKey(client: SqlClient, name: string): Promise<string> {
  const rows = await client.$queryRaw<{ key: string | null }[]>(
    Prisma.sql`SELECT atlas_name_key(${name}) AS key`,
  );
  return rows[0]?.key ?? '';
}

/**
 * Computes the key and refuses a name that reduces to nothing comparable
 * (only marks, invisibles or spaces) with a 400.
 */
export async function requireNameKey(
  client: SqlClient,
  name: string,
  field: string,
): Promise<string> {
  const key = await sqlNameKey(client, name);
  if (key === '') throw nameInvalid(field);
  return key;
}

async function advisoryLock(client: SqlClient, lockKey: string): Promise<void> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

async function booleanQuery(client: SqlClient, query: Prisma.Sql): Promise<boolean> {
  const rows = await client.$queryRaw<{ taken: boolean }[]>(query);
  return rows[0]?.taken === true;
}

/* -------------------------------- Organizations ------------------------------ */

export function lockOrganizationName(client: SqlClient, key: string): Promise<void> {
  return advisoryLock(client, `org-name:${key}`);
}

export function isOrganizationNameTaken(
  client: SqlClient,
  key: string,
): Promise<boolean> {
  return booleanQuery(
    client,
    Prisma.sql`SELECT organization_name_taken(${key}) AS taken`,
  );
}

/* --------------------------------- Academies --------------------------------- */

export function lockAcademyName(client: SqlClient, key: string): Promise<void> {
  return advisoryLock(client, `academy-name:${key}`);
}

export function isAcademyNameTaken(
  client: SqlClient,
  key: string,
  excludeAcademyId: string | null,
): Promise<boolean> {
  return booleanQuery(
    client,
    Prisma.sql`SELECT academy_name_taken(${key}, ${excludeAcademyId}::text) AS taken`,
  );
}

/* ---------------------------------- Learners --------------------------------- */

export function lockLearnerName(
  client: SqlClient,
  academyId: string,
  key: string,
): Promise<void> {
  return advisoryLock(client, `learner-name:${academyId}:${key}`);
}

/** Another NON-EXEMPT learner of this academy holds `key` (exempt rows never block). */
export function isLearnerNameTaken(
  client: SqlClient,
  academyId: string,
  key: string,
  excludeUserId: string | null,
): Promise<boolean> {
  return booleanQuery(
    client,
    Prisma.sql`SELECT academy_learner_name_taken(${academyId}, ${key}, ${excludeUserId}::text) AS taken`,
  );
}

/**
 * Admission check keyed on the account's CURRENT name, for callers that may
 * not be able to read the account row under RLS. Takes the learner-name
 * advisory lock for the rest of the transaction as a side effect.
 */
export function lockAndCheckLearnerAdmission(
  client: SqlClient,
  academyId: string,
  userId: string,
): Promise<boolean> {
  return booleanQuery(
    client,
    Prisma.sql`SELECT academy_learner_admission_name_taken(${academyId}, ${userId}) AS taken`,
  );
}

/* ----------------------------------- Errors ---------------------------------- */

function conflict(messageKey: string, field: string): ConflictException {
  return new ConflictException({ messageKey, violations: [{ field, messageKey }] });
}

export function nameInvalid(field: string): BadRequestException {
  return new BadRequestException({
    messageKey: NAME_ERROR_KEYS.invalid,
    violations: [{ field, messageKey: NAME_ERROR_KEYS.invalid }],
  });
}

/** Generic on purpose: never reveals that, or by whom, the name is held. */
export function organizationNameUnavailable(field = 'name'): ConflictException {
  return conflict(NAME_ERROR_KEYS.organizationUnavailable, field);
}

export function academyNameTaken(field = 'name'): ConflictException {
  return conflict(NAME_ERROR_KEYS.academyTaken, field);
}

export function learnerNameTaken(
  field = 'name',
  variant: 'self' | 'existingAccount' = 'self',
): ConflictException {
  return conflict(
    variant === 'existingAccount'
      ? NAME_ERROR_KEYS.learnerTakenExistingAccount
      : NAME_ERROR_KEYS.learnerTaken,
    field,
  );
}

/** Lists ONLY the caller's own academies — nothing about the other learner. */
export function profileNameTakenInAcademy(
  academies: readonly { readonly academyId: string; readonly name: string }[],
): ConflictException {
  return new ConflictException({
    messageKey: NAME_ERROR_KEYS.profileTakenInAcademy,
    violations: [{ field: 'name', messageKey: NAME_ERROR_KEYS.profileTakenInAcademy }],
    details: {
      academies: academies.map((academy) => ({
        academyId: academy.academyId,
        name: academy.name,
      })),
    },
  });
}

export function isNameConflict(error: unknown, messageKey?: string): boolean {
  if (!(error instanceof ConflictException)) return false;
  const key = (error.getResponse() as { messageKey?: string }).messageKey;
  if (messageKey) return key === messageKey;
  return (Object.values(NAME_ERROR_KEYS) as string[]).includes(key ?? '');
}
