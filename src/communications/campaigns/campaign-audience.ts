/**
 * W3-compose — turning a typed audience into SQL, once, for every step
 * that needs it: the preview count, the send-time count and the keyset
 * expansion. The three can therefore never disagree about who is in.
 *
 * TENANT ISOLATION IS IN THE SQL. Tenant RLS is ORGANIZATION-scoped
 * (`academy_students_tenant_select` admits every academy of the org), so an
 * academy audience filters by `academy_id = $academy` explicitly in every
 * source; course ids are additionally matched against that academy's own
 * enrollments, so a course of another academy contributes nobody.
 *
 * BASE FILTERS (every audience): the account is `active`, not deleted, and
 * not anonymised (`@account.invalid`, see `AccountDeletionService`).
 *
 * EMAIL EXCLUSIONS (counted, never silently dropped):
 *   - `suppressed` — the address is on the suppression list
 *     (`communication_email_suppressed`, a SECURITY DEFINER boolean so the
 *     tenant-context preview can count without reading platform data);
 *   - `opted_out` — the recipient turned the campaign's preference category
 *     off, read with exactly `resolveCommunicationPreferences`' rules.
 * An excluded person still gets the in-app notification when that channel
 * is on: opting out of EMAIL is not opting out of the feed.
 */
import { Prisma } from '@prisma/client';
import type {
  AcademyAudience,
  CampaignAudience,
  CampaignScope,
  PlatformAudience,
} from './campaign.types';
import { CAMPAIGN_PREFERENCE_CATEGORY } from './campaign.types';

export interface AudienceContext {
  readonly scope: CampaignScope;
  /** Required for `academy` scope. */
  readonly academyId?: string;
}

/** `true` when this person opted out of the category's email. Mirrors `resolveCommunicationPreferences`. */
export function optedOutSql(scope: CampaignScope, alias = 'u'): Prisma.Sql {
  const col = Prisma.raw(`${alias}."preferences"`);
  if (CAMPAIGN_PREFERENCE_CATEGORY[scope] === 'engagement') {
    // engagement.email when it is a boolean, else NOT the legacy `notifications.email = false`.
    return Prisma.sql`(NOT (CASE
      WHEN jsonb_typeof(${col} #> '{notifications,categories,engagement,email}') = 'boolean'
        THEN (${col} #>> '{notifications,categories,engagement,email}')::boolean
      ELSE NOT (jsonb_typeof(${col} #> '{notifications,email}') = 'boolean'
                AND (${col} #>> '{notifications,email}') = 'false')
    END))`;
  }
  // operational.email ?? true (operational exists for staff; every platform audience is staff).
  return Prisma.sql`(NOT (CASE
    WHEN jsonb_typeof(${col} #> '{notifications,categories,operational,email}') = 'boolean'
      THEN (${col} #>> '{notifications,categories,operational,email}')::boolean
    ELSE true
  END))`;
}

export function suppressedSql(alias = 'u'): Prisma.Sql {
  return Prisma.sql`communication_email_suppressed(${Prisma.raw(`${alias}."email"`)})`;
}

const ACTIVE_ACCOUNT = Prisma.sql`u."status" = 'active' AND u."deleted_at" IS NULL AND lower(u."email") NOT LIKE '%@account.invalid'`;

/**
 * The raw user-id source of an audience (may contain duplicates — every
 * consumer de-duplicates through `users`). `cursor` prunes the keyset page
 * inside the source itself.
 */
export function audienceSource(
  audience: CampaignAudience,
  context: AudienceContext,
  cursor: string | null = null,
): Prisma.Sql {
  if (context.scope === 'academy') {
    if (!context.academyId) throw new Error('academy audience without an academy id');
    return academySource(audience as AcademyAudience, context.academyId, cursor);
  }
  return platformSource(audience as PlatformAudience, cursor);
}

function after(column: string, cursor: string | null): Prisma.Sql {
  return cursor === null
    ? Prisma.empty
    : Prisma.sql` AND ${Prisma.raw(column)} > ${cursor}`;
}

function academySource(
  audience: AcademyAudience,
  academyId: string,
  cursor: string | null,
): Prisma.Sql {
  switch (audience.type) {
    case 'learners':
      return Prisma.sql`
        SELECT s."user_id" FROM "academy_students" s
         WHERE s."academy_id" = ${academyId}
           AND s."status" = 'active' AND s."blocked_at" IS NULL${after('s."user_id"', cursor)}`;
    case 'courses':
      return Prisma.sql`
        SELECT e."student_id" AS "user_id" FROM "enrollments" e
          JOIN "academy_students" s
            ON s."academy_id" = e."academy_id" AND s."user_id" = e."student_id"
         WHERE e."academy_id" = ${academyId}
           AND e."course_id" = ANY(${[...audience.courseIds]}::text[])
           AND e."status" IN ('enrolled', 'completed')
           AND e."revoked_at" IS NULL
           AND s."status" = 'active' AND s."blocked_at" IS NULL${after('e."student_id"', cursor)}`;
    case 'staff':
      return Prisma.sql`
        SELECT am."user_id" FROM "academy_members" am
         WHERE am."academy_id" = ${academyId}
           AND am."status" = 'active'
           AND am."role"::text = ANY(${[...audience.roles]}::text[])${after('am."user_id"', cursor)}`;
  }
}

function platformSource(audience: PlatformAudience, cursor: string | null): Prisma.Sql {
  switch (audience.type) {
    case 'org_owners':
      return Prisma.sql`
        SELECT o."owner_user_id" AS "user_id" FROM "organizations" o
         WHERE o."status" = 'active'${after('o."owner_user_id"', cursor)}`;
    case 'academy_owners': {
      const plans = audience.planKeys?.length
        ? Prisma.sql` AND p."key" = ANY(${[...audience.planKeys]}::text[])`
        : Prisma.empty;
      const subs = audience.subscriptionStatuses?.length
        ? Prisma.sql` AND ts."status"::text = ANY(${[...audience.subscriptionStatuses]}::text[])`
        : Prisma.empty;
      const academies = audience.academyStatuses?.length
        ? Prisma.sql` AND a."status"::text = ANY(${[...audience.academyStatuses]}::text[])`
        : Prisma.empty;
      return Prisma.sql`
        SELECT am."user_id" FROM "academy_members" am
          JOIN "academies" a ON a."id" = am."academy_id"
          LEFT JOIN "tenant_subscriptions" ts ON ts."organization_id" = a."organization_id"
          LEFT JOIN "plans" p ON p."id" = ts."plan_id"
         WHERE am."role" = 'owner' AND am."status" = 'active'
           AND a."status" <> 'archived'${plans}${subs}${academies}${after('am."user_id"', cursor)}`;
    }
    case 'academy_owners_admins':
      return Prisma.sql`
        SELECT am."user_id" FROM "academy_members" am
          JOIN "academies" a ON a."id" = am."academy_id"
         WHERE am."role" IN ('owner', 'administrator') AND am."status" = 'active'
           AND a."status" <> 'archived'${after('am."user_id"', cursor)}`;
    case 'organization':
      return Prisma.sql`
        SELECT m."user_id" FROM "organization_memberships" m
         WHERE m."organization_id" = ${audience.organizationId}${after('m."user_id"', cursor)}
        UNION ALL
        SELECT am."user_id" FROM "academy_members" am
          JOIN "academies" a ON a."id" = am."academy_id"
         WHERE a."organization_id" = ${audience.organizationId}
           AND am."role" IN ('owner', 'administrator') AND am."status" = 'active'
           AND a."status" <> 'archived'${after('am."user_id"', cursor)}`;
  }
}

export interface AudienceCounts {
  readonly recipients: number;
  readonly suppressed: number;
  readonly optedOut: number;
}

/** One pass over the audience: who is reached and who is excluded from email. */
export async function countAudience(
  tx: Prisma.TransactionClient,
  audience: CampaignAudience,
  context: AudienceContext,
): Promise<AudienceCounts> {
  const rows = await tx.$queryRaw<
    { recipients: number; suppressed: number; opted_out: number }[]
  >`
    WITH src AS (${audienceSource(audience, context)}),
    people AS (
      SELECT ${suppressedSql()} AS suppressed, ${optedOutSql(context.scope)} AS opted_out
        FROM "users" u
       WHERE u."id" IN (SELECT "user_id" FROM src) AND ${ACTIVE_ACCOUNT}
    )
    SELECT count(*)::int AS recipients,
           count(*) FILTER (WHERE suppressed)::int AS suppressed,
           count(*) FILTER (WHERE NOT suppressed AND opted_out)::int AS opted_out
      FROM people
  `;
  const row = rows[0] ?? { recipients: 0, suppressed: 0, opted_out: 0 };
  return {
    recipients: row.recipients,
    suppressed: row.suppressed,
    optedOut: row.opted_out,
  };
}

/** Learners left out of a learner audience because they are blocked or pending (preview only). */
export async function countInactiveLearners(
  tx: Prisma.TransactionClient,
  audience: AcademyAudience,
  academyId: string,
): Promise<{ blocked: number; pending: number }> {
  if (audience.type === 'staff') return { blocked: 0, pending: 0 };
  const courseFilter =
    audience.type === 'courses'
      ? Prisma.sql` AND EXISTS (
          SELECT 1 FROM "enrollments" e
           WHERE e."academy_id" = s."academy_id" AND e."student_id" = s."user_id"
             AND e."course_id" = ANY(${[...audience.courseIds]}::text[])
             AND e."status" IN ('enrolled', 'completed') AND e."revoked_at" IS NULL)`
      : Prisma.empty;
  const rows = await tx.$queryRaw<{ blocked: number; pending: number }[]>`
    SELECT count(*) FILTER (WHERE s."blocked_at" IS NOT NULL)::int AS blocked,
           count(*) FILTER (WHERE s."blocked_at" IS NULL AND s."status" = 'pending')::int AS pending
      FROM "academy_students" s
     WHERE s."academy_id" = ${academyId}${courseFilter}
  `;
  return rows[0] ?? { blocked: 0, pending: 0 };
}

export interface ExpandedPage {
  /** People read in this page (the loop ends when it is below the limit). */
  readonly pageSize: number;
  /** Rows newly written (a re-run skips rows it already wrote). */
  readonly written: number;
  readonly lastUserId: string | null;
  readonly emailEligible: number;
  readonly optedOut: number;
  readonly suppressed: number;
  readonly quotaExcluded: number;
}

/**
 * Writes ONE keyset page (≤ `limit` people, ordered by user id) of the
 * audience into `campaign_recipients`: one bounded SELECT, one INSERT.
 *
 * `emailBudget` caps how many NEW rows may be email-eligible (the
 * academy's reservation still unused); anyone past it is recorded as
 * excluded with reason `quota` — counted and reported, never silently
 * dropped. `null` means no cap (platform campaigns).
 */
export async function expandAudiencePage(
  tx: Prisma.TransactionClient,
  input: {
    readonly campaignId: string;
    readonly audience: CampaignAudience;
    readonly context: AudienceContext;
    readonly cursor: string | null;
    readonly limit: number;
    readonly emailChannel: boolean;
    readonly emailBudget: number | null;
  },
): Promise<ExpandedPage> {
  const page = await tx.$queryRaw<
    { user_id: string; suppressed: boolean; opted_out: boolean }[]
  >`
    WITH src AS (${audienceSource(input.audience, input.context, input.cursor)})
    SELECT u."id" AS user_id,
           ${suppressedSql()} AS suppressed,
           ${optedOutSql(input.context.scope)} AS opted_out
      FROM "users" u
     WHERE u."id" IN (SELECT "user_id" FROM src) AND ${ACTIVE_ACCOUNT}
       ${input.cursor === null ? Prisma.empty : Prisma.sql`AND u."id" > ${input.cursor}`}
     ORDER BY u."id"
     LIMIT ${input.limit}
  `;
  if (page.length === 0) {
    return {
      pageSize: 0,
      written: 0,
      lastUserId: null,
      emailEligible: 0,
      optedOut: 0,
      suppressed: 0,
      quotaExcluded: 0,
    };
  }

  let budget = input.emailBudget;
  const ids: string[] = [];
  const eligible: boolean[] = [];
  const exclusions: (string | null)[] = [];
  for (const person of page) {
    ids.push(person.user_id);
    if (!input.emailChannel) {
      eligible.push(false);
      exclusions.push(null);
    } else if (person.suppressed) {
      eligible.push(false);
      exclusions.push('suppressed');
    } else if (person.opted_out) {
      eligible.push(false);
      exclusions.push('opted_out');
    } else if (budget !== null && budget <= 0) {
      eligible.push(false);
      exclusions.push('quota');
    } else {
      eligible.push(true);
      exclusions.push(null);
      if (budget !== null) budget -= 1;
    }
  }

  const written = await tx.$queryRaw<
    { user_id: string; email_eligible: boolean; exclusion: string | null }[]
  >`
    INSERT INTO "campaign_recipients" ("campaign_id", "user_id", "email_eligible", "exclusion", "state")
    SELECT ${input.campaignId}, t.user_id, t.email_eligible, t.exclusion, 0
      FROM unnest(${ids}::text[], ${eligible}::boolean[], ${exclusions}::text[])
           AS t(user_id, email_eligible, exclusion)
    ON CONFLICT ("campaign_id", "user_id") DO NOTHING
    RETURNING "user_id", "email_eligible", "exclusion"
  `;
  return {
    pageSize: page.length,
    written: written.length,
    lastUserId: page[page.length - 1].user_id,
    emailEligible: written.filter((row) => row.email_eligible).length,
    optedOut: written.filter((row) => row.exclusion === 'opted_out').length,
    suppressed: written.filter((row) => row.exclusion === 'suppressed').length,
    quotaExcluded: written.filter((row) => row.exclusion === 'quota').length,
  };
}
