/**
 * TenantRetentionViewService — what `/dashboard/tenant/retention` shows an
 * academy owner who has just been told their video will be deleted.
 *
 * IT DECIDES NOTHING. Every date on this page comes out of
 * `resolveRetentionWindow`, the same pure evaluator the sweep runs; every
 * "sent" tick comes out of `VideoRetentionRepository.findWarningsSent`,
 * the same outbox evidence guard (2) requires before it will authorise a
 * deletion. If this service recomputed either from its own reading of
 * §31 the two would eventually disagree, and the customer would be shown
 * a date that is not the date — which, on this page, is the whole
 * failure. Nothing here writes.
 *
 * ---------------------------------------------------------------------
 * AUTHORIZATION, AND WHY IT IS ASSERTED TWICE
 * ---------------------------------------------------------------------
 *
 * GUARD: `OrganizationMembershipGuard` proves the caller belongs to this
 * organisation, then the controller requires the owner-exclusive billing
 * marker. Membership alone is not enough — a Manager or Instructor holds
 * real organisation membership, and this page names the courses and the
 * deletion date of the account's content.
 *
 * RLS: every read below runs inside ONE transaction opened with
 * `runInTenantAndUserContext(organizationId, callerUserId)`. The
 * organisation GUC is what `media_assets_tenant_select`,
 * `courses_tenant_select`, `tenant_lifecycle_state_tenant_select` and
 * `communication_outbox_tenant_select` all match on, so a caller from
 * another organisation reads zero rows from the database even with every
 * guard above removed. The two answers are independent and they agree.
 *
 * ONE TRANSACTION rather than five, deliberately: the tally, the hold and
 * the warning timeline are shown side by side and must describe the same
 * instant. Five transactions could straddle a sweep tick and render a
 * page whose timeline has advanced past its own tally.
 *
 * ---------------------------------------------------------------------
 * THE ONE HONEST GAP: A SUPPORT-CASE HOLD
 * ---------------------------------------------------------------------
 *
 * `VideoRetentionRepository.resolveHold` freezes the clock for a legal
 * hold OR any open support case. `support_cases` has no tenant-scoped
 * SELECT policy — only `support_cases_platform_select` and
 * `support_cases_requester_select` — so under the caller's own context
 * the case query can only see cases THAT CALLER opened. A hold caused by
 * a case a Manager opened is therefore invisible here.
 *
 * The residue is safe in the only direction that matters. The page then
 * shows a deletion date for an organisation that is actually frozen: it
 * OVER-warns. It can never do the reverse — claim a frozen clock for an
 * organisation that is really counting down — because the legal-hold flag
 * it reads is tenant-visible and the case query can only ever ADD a hold.
 * Closing it properly needs a tenant-scoped SELECT policy on
 * `support_cases`, which is a migration; this workstream does not write
 * migrations, so it is reported rather than faked.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import type {
  CommunicationsConfig,
  VideoRetentionMode,
} from '../../config/configuration';
import { VideoRetentionRepository } from '../repositories/video-retention.repository';
import { TenantRetentionViewRepository } from '../repositories/tenant-retention-view.repository';
import { toEvaluationInput } from './video-retention.service';
import {
  RETENTION_W1_LEAD_MS,
  RETENTION_W2_LEAD_MS,
  RETENTION_W3_LEAD_MS,
  RETENTION_W4_LEAD_MS,
  RETENTION_WARNING_STEPS,
  RETENTION_WINDOW_PAID_MS,
  RETENTION_WINDOW_TRIAL_MS,
  resolveRetentionWindow,
  type RetentionStepId,
} from '../utils/video-retention.util';
import type {
  TenantRetentionCourse,
  TenantRetentionHoldReason,
  TenantRetentionResponse,
  TenantRetentionState,
  TenantRetentionWarningStep,
} from '../dto/tenant-retention.contract';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many affected courses the page names before it stops listing them.
 *
 * Higher than the email's ten because a page can scroll and a mail client
 * should not have to; low enough that an academy with four hundred
 * courses does not ship four hundred rows to a browser. Past the cap the
 * response says it was capped — `coursesTruncated` — rather than quietly
 * presenting a partial list as the whole answer.
 */
export const TENANT_RETENTION_MAX_COURSES = 25;

/** The same leads the evaluator uses, keyed for the timeline. */
const WARNING_LEAD_MS: Readonly<Record<string, number>> = {
  retention_warning_30d: RETENTION_W1_LEAD_MS,
  retention_warning_14d: RETENTION_W2_LEAD_MS,
  retention_warning_7d: RETENTION_W3_LEAD_MS,
  retention_warning_24h: RETENTION_W4_LEAD_MS,
};

function toMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/** Whole days until `at`; 0 on the final day and once it has passed. */
function daysUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / MS_PER_DAY));
}

@Injectable()
export class TenantRetentionViewService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly viewRepository: TenantRetentionViewRepository,
    private readonly retentionRepository: VideoRetentionRepository,
    private readonly configService: ConfigService,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  private get mode(): VideoRetentionMode {
    return this.configService.getOrThrow<CommunicationsConfig>('communications')
      .videoRetentionMode;
  }

  /**
   * This organisation's retention state.
   *
   * NEVER THROWS FOR "NOTHING IS HAPPENING". An organisation with a live
   * subscription, or one that has not been inactive long enough to open a
   * window, gets the full payload with `state: 'not_scheduled'` and a
   * real video tally — because "you have 42 videos and none of them are
   * scheduled for deletion" is the single most reassuring thing this
   * endpoint can say, and a 404 says it as an error.
   */
  async describe(
    organizationId: string,
    callerUserId: string,
  ): Promise<TenantRetentionResponse> {
    const now = this.clock.now();
    const mode = this.mode;

    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      callerUserId,
      async (tx) => {
        const [candidate, tally, tombstones] = await Promise.all([
          this.retentionRepository.findCandidate(tx, organizationId),
          this.viewRepository.assetTally(
            tx,
            organizationId,
            TENANT_RETENTION_MAX_COURSES,
          ),
          this.viewRepository.tombstoneTally(tx, organizationId),
        ]);

        const video = {
          assetCount: tally.assetCount,
          storedMinutes: toMinutes(tally.totalSeconds),
          storedBytes: tally.totalBytes.toString(),
          deletedAssetCount: tombstones.deletedAssetCount,
          lastDeletedAt: tombstones.lastDeletedAt?.toISOString() ?? null,
        };
        const courses: TenantRetentionCourse[] = tally.courses.map((course) => ({
          id: course.id,
          title: course.title,
          videoCount: course.videoCount,
          storedMinutes: toMinutes(course.totalSeconds),
        }));
        const coursesTruncated = tally.affectedCourseCount > tally.courses.length;

        const base = {
          organizationId,
          mode,
          video,
          courses,
          coursesTruncated,
          generatedAt: now.toISOString(),
        };

        const window = candidate
          ? resolveRetentionWindow(toEvaluationInput(candidate), now)
          : null;

        if (!candidate || !window) {
          return {
            ...base,
            state: 'not_scheduled' as TenantRetentionState,
            windowOpen: false,
            origin: null,
            windowDays: null,
            anchorAt: null,
            deletionAt: null,
            daysUntilDeletion: null,
            warnings: [],
            hold: { held: false, reason: null },
          };
        }

        const lifecycleState = candidate.organization.lifecycleState ?? null;
        const hold = await this.retentionRepository.resolveHold(
          tx,
          organizationId,
          lifecycleState,
        );
        /*
          The raw reason is NOT forwarded. `hold_reason` is free text a
          platform operator typed and `support_case:<id>` carries an
          internal identifier; neither belongs on a customer's screen.
          The page needs to know only which KIND of freeze it is, because
          that is what decides what the owner does next.
        */
        const holdReason: TenantRetentionHoldReason | null = !hold.held
          ? null
          : lifecycleState?.legalHold
            ? 'legal_hold'
            : 'support_case';

        /*
          Guard (2)'s own evidence, read for the timeline. The recipient is
          the ORGANISATION'S OWNER — the person the warnings were actually
          addressed to — not whoever opened this page, so the ticks are the
          same ticks the deletion path counts.
        */
        const ownerUserId = candidate.organization.owner?.id ?? null;
        const sent = ownerUserId
          ? await this.retentionRepository.findWarningsSent(
              tx,
              ownerUserId,
              organizationId,
              window.anchorAt,
            )
          : new Set<RetentionStepId>();

        const warnings: TenantRetentionWarningStep[] = RETENTION_WARNING_STEPS
          // Same rule as the evaluator: a warning that would fall due
          // before the anchor is not a warning, and is never shown.
          .map((step) => ({
            step,
            dueAt: new Date(window.deletionAt.getTime() - WARNING_LEAD_MS[step]),
          }))
          .filter((row) => row.dueAt.getTime() >= window.anchorAt.getTime())
          .map((row) => ({
            step: row.step,
            dueAt: row.dueAt.toISOString(),
            sent: sent.has(row.step),
          }));

        const anyWarningSent = warnings.some((row) => row.sent);
        const state: TenantRetentionState = hold.held
          ? 'held'
          : now.getTime() >= window.deletionAt.getTime()
            ? 'elapsed'
            : anyWarningSent
              ? 'warning'
              : 'scheduled';

        return {
          ...base,
          state,
          windowOpen: true,
          origin: window.origin,
          windowDays: Math.round(
            (window.origin === 'trial'
              ? RETENTION_WINDOW_TRIAL_MS
              : RETENTION_WINDOW_PAID_MS) / MS_PER_DAY,
          ),
          anchorAt: window.anchorAt.toISOString(),
          deletionAt: window.deletionAt.toISOString(),
          daysUntilDeletion: daysUntil(window.deletionAt, now),
          warnings,
          hold: { held: hold.held, reason: holdReason },
        };
      },
    );
  }
}
