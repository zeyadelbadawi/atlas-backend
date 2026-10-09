/**
 * DeletionPlanService — what deleting this account will actually do.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE DELETION ITSELF. Two surfaces need
 * to tell someone the truth before anything is destroyed: the account
 * holder's own confirmation dialog, and the Platform Owner's
 * administrative one. Both previously would have had to hardcode a list
 * of consequences, which drifts from the code the moment the code
 * changes. This reads the real rows instead, so the sentence a person
 * confirms is derived from the same database the deletion will act on.
 *
 * IT IS STRICTLY READ-ONLY. Nothing here writes, enqueues or revokes. It
 * is safe to call repeatedly, and it is deliberately NOT the gate for
 * anything: `AccountDeletionService` re-derives its own scope at
 * execution time. A plan is a description, never a permission — the
 * check-then-act gap between rendering a dialog and pressing the button
 * is exactly where a stale decision would do damage.
 *
 * THE FIVE TREATMENTS. Atlas cannot hard-delete most of what a person
 * touches (`users` carries ten `ON DELETE RESTRICT` edges, and 65
 * RLS-enabled tenant tables have no DELETE policy at all), so "deleted"
 * is not one behaviour but five, and the plan names which applies to
 * each group rather than implying a single one. See
 * `docs/ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md` §1.
 *
 * EVERY COUNT RUNS IN A CONTEXT THAT CAN SEE THE ROWS. This is the whole
 * difficulty. A count taken outside the right tenant or user context does
 * not error — RLS filters every row and it returns a confident zero. The
 * first version of account deletion shipped exactly that bug (it
 * anonymised the user and silently left every membership row behind), so
 * each count below states the context it needs and why. A zero in this
 * plan must mean "there are none", never "I could not see them".
 *
 * In particular `enrollments` is USER-scoped, not academy-scoped: an
 * owner cannot count their own academies' learners through it. The
 * learner-facing count therefore comes from `academy_students`, which has
 * a real academy-scoped read path.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';

/**
 * What happens to a group of records. Named rather than implied, because
 * "deleted" means something different for a password than for a payment.
 */
export type DeletionTreatment =
  /** The bytes or rows genuinely cease to exist. */
  | 'destroy'
  /** The row survives; the person in it does not. */
  | 'deidentify'
  /** Kept intact and unchanged, pointing at an anonymised subject. */
  | 'retain'
  /** Kept only as a marker so history stays legible and nothing 404s. */
  | 'tombstone'
  /** Access is withdrawn immediately; the record of it may remain. */
  | 'revoke';

/** The role the plan was built for. Decides which lines apply. */
export type DeletionSubjectRole =
  'platform_owner' | 'client_owner' | 'manager' | 'instructor' | 'student' | 'member';

export interface DeletionPlanLine {
  /**
   * Stable identifier, also the i18n key suffix. The frontend renders
   * `deletion:plan.<key>` — this service never returns display text,
   * matching how every other Atlas contract carries messageKeys and not
   * sentences.
   */
  readonly key: string;
  readonly treatment: DeletionTreatment;
  readonly count: number;
  /**
   * A few concrete names, so "3 academies" can read "3 academies:
   * Northwind, …". Capped — a plan is a summary, not an export.
   */
  readonly examples?: readonly string[];
}

export interface DeletionPlan {
  readonly userId: string;
  readonly subjectRole: DeletionSubjectRole;
  /** False when the account may not be deleted at all. */
  readonly deletable: boolean;
  /** Present only when `deletable` is false. A translation key. */
  readonly refusalKey?: string;
  /** True once the account has already been deleted — the plan is empty. */
  readonly alreadyDeleted: boolean;
  readonly lines: readonly DeletionPlanLine[];
}

/** How many names a line carries before it stops naming them. */
const MAX_EXAMPLES = 5;

@Injectable()
export class DeletionPlanService {
  constructor(private readonly tenancyContextService: TenancyContextService) {}

  /**
   * Builds the plan for `userId`.
   *
   * The subject is always the user being deleted, never the caller — a
   * Platform Owner previewing someone else's deletion must see that
   * person's consequences, not their own. Authorization for who may ask
   * belongs to the controller; this only describes.
   */
  async buildForUser(userId: string): Promise<DeletionPlan> {
    // `users` is readable only inside a context (authentication audit,
    // Decision 2): the subject's own. Every subsequent read says which.
    const user = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { id: true, isPlatformOwner: true, status: true },
      }),
    );

    if (!user) {
      return {
        userId,
        subjectRole: 'member',
        deletable: false,
        refusalKey: 'errors.notFound',
        alreadyDeleted: false,
        lines: [],
      };
    }

    if (user.status === 'deleted') {
      return {
        userId,
        subjectRole: 'member',
        deletable: false,
        alreadyDeleted: true,
        lines: [],
      };
    }

    if (user.isPlatformOwner) {
      // Refused for the same reason `AccountDeletionService` refuses it:
      // the account that administers the platform is not a user-facing
      // deletion, and nothing can grant `is_platform_owner` back through
      // the product.
      return {
        userId,
        subjectRole: 'platform_owner',
        deletable: false,
        refusalKey: 'errors.auth.platformOwnerCannotSelfDelete',
        alreadyDeleted: false,
        lines: [],
      };
    }

    const [tenantLines, ownedOrganizationCount] = await this.buildTenantLines(userId);
    const personalLines = await this.buildPersonalLines(userId);
    const roleFacts = await this.readRoleFacts(userId);

    const lines = [
      ...this.buildIdentityLines(),
      ...tenantLines,
      ...personalLines,
      ...this.buildRetainedLines(),
      // Drop empty groups. The four always-true lines (identity,
      // credentials, financial, audit) carry a count of 1 so they survive
      // this on their own merit.
      //
      // This used to also keep every `deidentify` line regardless of count,
      // to protect those always-true ones. It protected `certificates` too,
      // so an account with no certificates was told "0 certificates keep
      // their records" — a consequence it does not have, in a dialog whose
      // entire job is to be accurate.
    ].filter((line) => line.count > 0);

    return {
      userId,
      subjectRole: this.resolveRole(ownedOrganizationCount, roleFacts),
      deletable: true,
      alreadyDeleted: false,
      lines,
    };
  }

  /** Always true for every account, so these carry no count of their own. */
  private buildIdentityLines(): DeletionPlanLine[] {
    return [
      // Name, email, avatar and preferences are overwritten with values
      // that cannot be reversed, and the password hash with one no
      // password can produce.
      { key: 'identity', treatment: 'deidentify', count: 1 },
      // 2FA secret, recovery codes, reset and verification tokens. None
      // has audit value and all of it is dangerous to keep.
      { key: 'credentials', treatment: 'destroy', count: 1 },
    ];
  }

  /**
   * The tenant teardown: everything owned by organizations this user owns.
   *
   * Returns the lines and the owned-organization count, because the
   * caller needs the latter to decide the subject's role and re-reading
   * it would be a second query for a number already in hand.
   */
  private async buildTenantLines(userId: string): Promise<[DeletionPlanLine[], number]> {
    // USER context: the `organizations` select policy keys on
    // `app.current_user_id`. Without it this returns [] and the entire
    // tenant section of the plan silently disappears.
    const ownedOrganizations = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        tx.organization.findMany({
          where: { ownerUserId: userId },
          select: { id: true, name: true },
        }),
    );

    if (ownedOrganizations.length === 0) {
      return [[], 0];
    }

    const academyNames: string[] = [];
    let academies = 0;
    let courses = 0;
    let mediaAssets = 0;
    let mediaBytes = 0n;
    let learners = 0;

    for (const organization of ownedOrganizations) {
      // TENANT context per organization: academies and everything under
      // them resolve through `academies.organization_id`.
      await this.tenancyContextService.runInTenantContext(organization.id, async (tx) => {
        const rows = await tx.academy.findMany({
          where: { organizationId: organization.id },
          select: { id: true, name: true },
        });

        academies += rows.length;
        for (const row of rows) {
          if (academyNames.length < MAX_EXAMPLES) academyNames.push(row.name);
        }

        if (rows.length === 0) return;
        const academyIds = rows.map((row) => row.id);

        courses += await tx.course.count({
          where: { academyId: { in: academyIds } },
        });

        // Counted separately from the byte total because "how many
        // files" and "how much storage" answer different questions and
        // a single number would have to pick one.
        mediaAssets += await tx.mediaAsset.count({
          where: { academyId: { in: academyIds }, status: { not: 'deleted' } },
        });

        const bytes = await tx.mediaAsset.aggregate({
          where: { academyId: { in: academyIds }, status: { not: 'deleted' } },
          _sum: { sizeBytes: true },
        });
        mediaBytes += bytes._sum.sizeBytes ?? 0n;

        // NOT `enrollments`: that table is user-scoped, so an owner's
        // context sees only their own. `academy_students` is the
        // academy-scoped roster and is what staff already read.
        learners += await tx.academyStudent.count({
          where: { academyId: { in: academyIds } },
        });
      });
    }

    return [
      [
        // The organization row itself survives: it anchors billing and
        // audit history, and other people's records hang off it.
        {
          key: 'organizations',
          treatment: 'retain',
          count: ownedOrganizations.length,
          examples: ownedOrganizations.slice(0, MAX_EXAMPLES).map((o) => o.name),
        },
        {
          key: 'academies',
          treatment: 'destroy',
          count: academies,
          examples: academyNames,
        },
        { key: 'courses', treatment: 'destroy', count: courses },
        { key: 'mediaAssets', treatment: 'destroy', count: mediaAssets },
        // Reported in bytes; the UI formats it. A count of zero here is
        // filtered out like any other, so an academy with no uploads does
        // not claim to be freeing storage.
        { key: 'mediaBytes', treatment: 'destroy', count: Number(mediaBytes) },
        // Their access ends the moment the academies go offline. Their
        // own accounts and purchase history are untouched.
        { key: 'affectedLearners', treatment: 'revoke', count: learners },
      ],
      ownedOrganizations.length,
    ];
  }

  /** What the person holds as a participant rather than as an owner. */
  private async buildPersonalLines(userId: string): Promise<DeletionPlanLine[]> {
    // USER context throughout: enrollments, certificates and sessions are
    // all user-scoped, keyed on `app.current_user_id`.
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const [enrollments, certificates, sessions] = await Promise.all([
        tx.enrollment.count({ where: { studentId: userId } }),
        tx.certificate.count({ where: { studentId: userId } }),
        tx.refreshToken.count({ where: { userId, revokedAt: null } }),
      ]);

      return [
        // Kept so the learner's own history stays legible, and so a
        // course they paid for does not become a dead link.
        { key: 'enrollments', treatment: 'tombstone', count: enrollments },
        // The issuance facts are an academy record; the holder's name is
        // not. The PDF is re-rendered without it.
        { key: 'certificates', treatment: 'deidentify', count: certificates },
        { key: 'sessions', treatment: 'revoke', count: sessions },
      ];
    });
  }

  /**
   * The records that survive, stated rather than omitted.
   *
   * A plan that lists only what disappears would be a half-truth, and
   * this is the half people are most entitled to know about.
   */
  private buildRetainedLines(): DeletionPlanLine[] {
    return [
      // Payments, orders, refunds and the revenue ledger. Append-only by
      // construction, and legally required.
      { key: 'financialRecords', treatment: 'retain', count: 1 },
      // `audit_log_entries.actor_user_id` is RESTRICT precisely so the
      // actor cannot be deleted out from under the record.
      { key: 'auditRecords', treatment: 'retain', count: 1 },
      // Forensic video watermark records (docs/FORENSIC_WATERMARK.md): who
      // was shown which video, with an encrypted identity snapshot. Kept on
      // purpose — anti-piracy evidence must outlive the account that leaked
      // — and pruned only by the retention sweep (`WATERMARK_RETENTION_DAYS`).
      // Not counted: the table is readable only by a Platform Owner lookup,
      // and the line is true for every account that ever opened a video.
      { key: 'forensicWatermarks', treatment: 'retain', count: 1 },
    ];
  }

  /** Memberships that decide which role label the plan carries. */
  private async readRoleFacts(userId: string) {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const [memberships, studentships, instructorships] = await Promise.all([
        tx.academyMember.findMany({ where: { userId }, select: { role: true } }),
        tx.academyStudent.count({ where: { userId } }),
        tx.courseInstructor.count({ where: { userId } }),
      ]);
      return {
        roles: memberships.map((m) => String(m.role)),
        studentships,
        instructorships,
      };
    });
  }

  /**
   * The single label that best describes the subject.
   *
   * Ordered by blast radius, not by seniority: whichever consequence is
   * largest is the one the confirmation should be framed around. Someone
   * who owns an organization AND studies a course is a Client Owner here,
   * because that is the deletion that matters.
   */
  private resolveRole(
    ownedOrganizations: number,
    facts: { roles: string[]; studentships: number; instructorships: number },
  ): DeletionSubjectRole {
    if (ownedOrganizations > 0) return 'client_owner';
    if (
      facts.roles.some((r) => r === 'owner' || r === 'administrator' || r === 'manager')
    ) {
      return 'manager';
    }
    if (facts.instructorships > 0 || facts.roles.includes('instructor')) {
      return 'instructor';
    }
    if (facts.studentships > 0) return 'student';
    return 'member';
  }
}
