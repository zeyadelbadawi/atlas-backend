/**
 * W3-compose — ONE service behind both composers.
 *
 *   preview  → counts and exclusions (and, for an academy, the quota),
 *              read-only: no campaign, no reservation, no side effect.
 *   send     → validates and sanitises the content, replays an earlier
 *              request with the same idempotency key, re-counts the
 *              audience and refuses (409) if it moved since the preview,
 *              requires confirmation for a large audience, reserves the
 *              academy's monthly email quota in the SAME transaction that
 *              creates the campaign (422, nothing sent, when it does not
 *              fit — never a silent truncation), audits, and enqueues the
 *              expansion. Returns 202 with the campaign id.
 *   list/get → history with progress derived from the real outbox rows.
 *
 * WHO MAY CALL. The controllers decide the scope; this service re-proves
 * it: a Platform Owner's context comes from `PlatformOwnerGuard` and the
 * platform RLS policies, an academy sender's from
 * `assertAcademySender` (an ACTIVE `academy_members` row with role
 * `owner` or `administrator`, on an ACTIVE academy) — organization
 * membership alone is never enough.
 */
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AcademyMemberRole } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { RedisService } from '../../redis/redis.service';
import type { CommunicationsConfig } from '../../config/configuration';
import {
  CAMPAIGN_BODY_HTML_MAX,
  CAMPAIGN_BODY_HTML_MAX_BYTES,
  CAMPAIGN_BODY_TEXT_MAX,
  CAMPAIGN_KEY,
  CAMPAIGN_LARGE_AUDIENCE,
  CAMPAIGN_PREVIEW_RATE,
  CAMPAIGN_SEND_RATE,
  CAMPAIGN_SUBJECT_MAX,
  type AcademyAudience,
  type CampaignAcceptedResponse,
  type CampaignAudience,
  type CampaignChannels,
  type CampaignPreviewResponse,
  type CampaignProgressView,
  type CampaignQuotaView,
  type CampaignScope,
  type CampaignSummaryResponse,
} from './campaign.types';
import {
  countAudience,
  countInactiveLearners,
  type AudienceContext,
} from './campaign-audience';
import { sanitizeRichText } from './rich-text-sanitizer';
import {
  AcademyEmailQuotaExceededError,
  AcademyEmailQuotaService,
} from './academy-email-quota.service';
import { CampaignsProducer } from './queue/campaigns.producer';

/** The roles allowed to message a whole academy (W3b B.3). */
export const ACADEMY_SENDER_ROLES: ReadonlySet<AcademyMemberRole> = new Set([
  'owner',
  'administrator',
]);

export type SenderContext =
  | { readonly scope: 'platform'; readonly actorUserId: string }
  | {
      readonly scope: 'academy';
      readonly actorUserId: string;
      readonly academyId: string;
      readonly organizationId: string;
      readonly role: AcademyMemberRole;
    };

export interface ComposeInput {
  readonly audience: CampaignAudience;
  readonly channels: CampaignChannels;
}

export interface SendInput extends ComposeInput {
  readonly idempotencyKey: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly contentLocale?: 'en' | 'ar';
  readonly expectedRecipientCount: number;
  readonly confirmLargeAudience?: boolean;
}

interface Counted {
  readonly recipientCount: number;
  readonly emailCount: number;
  readonly inAppCount: number;
  readonly optedOut: number;
  readonly suppressed: number;
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  return (error.meta as { code?: string } | undefined)?.code === '23505';
}

@Injectable()
export class CommunicationCampaignService {
  private readonly logger = new Logger(CommunicationCampaignService.name);
  private readonly platformName: string;

  constructor(
    private readonly tenancy: TenancyContextService,
    private readonly quota: AcademyEmailQuotaService,
    private readonly audit: AuditLogWriterService,
    private readonly redis: RedisService,
    private readonly producer: CampaignsProducer,
    configService: ConfigService,
  ) {
    this.platformName =
      configService.get<CommunicationsConfig>('communications')?.platformName ?? 'Atlas';
  }

  // ---------------------------------------------------------------------
  // authorization
  // ---------------------------------------------------------------------

  /**
   * An academy sender is an ACTIVE `academy_members` row with role owner or
   * administrator — or the organization owner, the implicit owner of every
   * academy — on an ACTIVE academy, read inside the academy's own tenant. Organization membership alone (what `AcademyScopeGuard`
   * proves) is not enough, and `assertCanManage`'s missing status check is
   * not repeated here.
   */
  async assertAcademySender(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<Extract<SenderContext, { scope: 'academy' }>> {
    return this.tenancy.runInTenantAndUserContext(organizationId, userId, async (tx) => {
      const [academy, membership] = await Promise.all([
        tx.academy.findUnique({
          where: { id: academyId },
          select: { id: true, organizationId: true, status: true },
        }),
        tx.academyMember.findUnique({
          where: { academyId_userId: { academyId, userId } },
          select: { role: true, status: true },
        }),
      ]);
      if (!academy || academy.organizationId !== organizationId) {
        throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
      }
      // The organization OWNER is the implicit owner of every academy in
      // the organization (`AcademyScopeGuard`'s rule), with or without a
      // staff row. Organization managers and members get no such pass.
      const staffRole =
        membership &&
        membership.status === 'active' &&
        ACADEMY_SENDER_ROLES.has(membership.role)
          ? membership.role
          : null;
      const role =
        staffRole ??
        ((await tx.organizationMembership.findFirst({
          where: { organizationId: academy.organizationId, userId, role: 'owner' },
          select: { id: true },
        }))
          ? ('owner' as const)
          : null);
      if (!role) {
        throw new ForbiddenException({
          messageKey: 'errors.messaging.notAllowed',
          code: 'ACADEMY_MESSAGING_FORBIDDEN',
        });
      }
      if (academy.status !== 'active') {
        throw new ForbiddenException({
          messageKey: 'errors.messaging.academyInactive',
          code: 'ACADEMY_NOT_ACTIVE',
        });
      }
      return {
        scope: 'academy' as const,
        actorUserId: userId,
        academyId,
        organizationId,
        role,
      };
    });
  }

  // ---------------------------------------------------------------------
  // preview
  // ---------------------------------------------------------------------

  async preview(
    sender: SenderContext,
    input: ComposeInput,
  ): Promise<CampaignPreviewResponse> {
    this.assertChannels(input.channels);
    await this.rateLimit(
      `campaign:preview:${sender.actorUserId}`,
      CAMPAIGN_PREVIEW_RATE.max,
      CAMPAIGN_PREVIEW_RATE.windowSeconds,
    );
    return this.inSenderContext(sender, async (tx) => {
      await this.assertAudienceInScope(tx, sender, input.audience);
      const counted = await this.count(tx, sender, input);
      const inactive =
        sender.scope === 'academy'
          ? await countInactiveLearners(
              tx,
              input.audience as AcademyAudience,
              sender.academyId,
            )
          : { blocked: 0, pending: 0 };
      const quota =
        sender.scope === 'academy'
          ? await this.quota.view(tx, sender.organizationId, sender.academyId)
          : null;
      return {
        recipientCount: counted.recipientCount,
        emailCount: counted.emailCount,
        inAppCount: counted.inAppCount,
        excluded: {
          optedOut: counted.optedOut,
          suppressed: counted.suppressed,
          blocked: inactive.blocked,
          pending: inactive.pending,
        },
        requiresConfirmation: counted.recipientCount >= CAMPAIGN_LARGE_AUDIENCE,
        quota,
        overBy:
          quota && quota.remaining !== null
            ? Math.max(0, counted.emailCount - quota.remaining)
            : 0,
      };
    });
  }

  /** The composer's quota meter, without an audience. */
  async quotaView(
    sender: Extract<SenderContext, { scope: 'academy' }>,
  ): Promise<CampaignQuotaView> {
    return this.tenancy.runInTenantAndUserContext(
      sender.organizationId,
      sender.actorUserId,
      (tx) => this.quota.view(tx, sender.organizationId, sender.academyId),
    );
  }

  // ---------------------------------------------------------------------
  // send
  // ---------------------------------------------------------------------

  async send(sender: SenderContext, input: SendInput): Promise<CampaignAcceptedResponse> {
    this.assertChannels(input.channels);
    // Cheap checks only (subject, raw size) before the rate limit; the
    // sanitiser — the expensive part — runs after it (security review
    // finding 3), so a flood of oversized bodies is refused by the limiter.
    this.assertRawContent(input);
    const idempotencyScope =
      sender.scope === 'academy' ? `academy:${sender.academyId}` : 'platform';

    // A replay never consumes the rate limit, so a client retrying after a
    // lost response is not punished for it.
    const replay = await this.findReplay(sender, idempotencyScope, input.idempotencyKey);
    if (replay) return replay;

    const rate = CAMPAIGN_SEND_RATE[sender.scope];
    await this.rateLimit(
      sender.scope === 'academy'
        ? `campaign:send:academy:${sender.academyId}`
        : `campaign:send:platform:${sender.actorUserId}`,
      rate.max,
      rate.windowSeconds,
    );
    const content = this.sanitizeContent(input);

    const campaignId = randomUUID();
    try {
      const accepted = await this.inSenderContext(sender, async (tx) => {
        await this.assertAudienceInScope(tx, sender, input.audience);
        const counted = await this.count(tx, sender, input);

        if (counted.recipientCount === 0) {
          throw new UnprocessableEntityException({
            messageKey: 'errors.messaging.noRecipients',
            code: 'CAMPAIGN_NO_RECIPIENTS',
          });
        }
        // The audience moved since the preview the person confirmed: they
        // must look at the new numbers before anything is sent or charged.
        if (counted.recipientCount !== input.expectedRecipientCount) {
          throw new ConflictException({
            messageKey: 'errors.messaging.audienceChanged',
            code: 'CAMPAIGN_AUDIENCE_CHANGED',
            details: {
              recipientCount: counted.recipientCount,
              emailCount: counted.emailCount,
              expectedRecipientCount: input.expectedRecipientCount,
            },
          });
        }
        if (
          counted.recipientCount >= CAMPAIGN_LARGE_AUDIENCE &&
          !input.confirmLargeAudience
        ) {
          throw new UnprocessableEntityException({
            messageKey: 'errors.messaging.confirmationRequired',
            code: 'CAMPAIGN_CONFIRMATION_REQUIRED',
            details: { recipientCount: counted.recipientCount },
          });
        }

        let quota: CampaignQuotaView | null = null;
        if (sender.scope === 'academy') {
          // The authoritative check is the conditional UPDATE inside
          // `reserve`; it runs in THIS transaction, so a refusal rolls the
          // campaign row back with it.
          quota = await this.quota.reserve(tx, {
            organizationId: sender.organizationId,
            academyId: sender.academyId,
            messageId: campaignId,
            quantity: counted.emailCount,
            actorUserId: sender.actorUserId,
          });
        }

        await tx.communicationCampaign.create({
          data: {
            id: campaignId,
            scope: sender.scope,
            organizationId: sender.scope === 'academy' ? sender.organizationId : null,
            academyId: sender.scope === 'academy' ? sender.academyId : null,
            createdBy: sender.actorUserId,
            idempotencyScope,
            idempotencyKey: input.idempotencyKey,
            key: CAMPAIGN_KEY[sender.scope],
            channels: { email: input.channels.email, inApp: input.channels.inApp },
            audience: input.audience as unknown as Prisma.InputJsonValue,
            subject: content.subject,
            bodyHtml: content.html,
            bodyText: content.text,
            contentLocale: input.contentLocale === 'ar' ? 'ar' : 'en',
            status: 'queued',
            recipientCount: counted.recipientCount,
            expectedEmailCount: counted.emailCount,
            quotaPeriodStart: quota ? new Date(quota.periodStart) : null,
            quotaReserved: sender.scope === 'academy' ? counted.emailCount : 0,
            largeAudienceConfirmed: Boolean(input.confirmLargeAudience),
          },
          select: { id: true },
        });

        const auditContext = {
          audienceType: input.audience.type,
          channels: [
            input.channels.email ? 'email' : null,
            input.channels.inApp ? 'inApp' : null,
          ]
            .filter(Boolean)
            .join(','),
          recipientCount: counted.recipientCount,
          mailCount: counted.emailCount,
          inAppCount: counted.inAppCount,
        };
        if (sender.scope === 'academy') {
          await this.audit.record(tx, {
            actorUserId: sender.actorUserId,
            action: 'academy.message.sent',
            targetId: campaignId,
            targetLabel: content.subject,
            academyId: sender.academyId,
            organizationId: sender.organizationId,
            role: sender.role,
            context: auditContext,
          });
        } else {
          await this.audit.record(tx, {
            actorUserId: sender.actorUserId,
            action: 'platform.campaign.sent',
            targetId: campaignId,
            targetLabel: content.subject,
            role: 'platform_owner',
            context: auditContext,
          });
        }

        return {
          campaignId,
          status: 'queued',
          recipientCount: counted.recipientCount,
          emailCount: counted.emailCount,
          inAppCount: counted.inAppCount,
          replayed: false,
          quota,
        } satisfies CampaignAcceptedResponse;
      });

      await this.producer.enqueueRun(accepted.campaignId);
      return accepted;
    } catch (error) {
      if (error instanceof AcademyEmailQuotaExceededError) {
        throw new UnprocessableEntityException({
          messageKey: 'errors.messaging.quotaExceeded',
          code: 'ACADEMY_EMAIL_QUOTA_EXCEEDED',
          details: {
            remaining: error.remaining,
            requested: error.requested,
            limit: error.limit ?? 'unlimited',
          },
        });
      }
      // Two concurrent requests with the same key: the loser's whole
      // transaction (campaign AND quota charge) rolled back on the unique
      // index — answer with the winner's campaign.
      if (isUniqueViolation(error)) {
        const winner = await this.findReplay(
          sender,
          idempotencyScope,
          input.idempotencyKey,
        );
        if (winner) return winner;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // history
  // ---------------------------------------------------------------------

  async list(
    sender: SenderContext,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<{ items: CampaignSummaryResponse[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit, 1), 50);
    return this.inSenderContext(sender, async (tx) => {
      const where: Prisma.CommunicationCampaignWhereInput =
        sender.scope === 'academy'
          ? { scope: 'academy', academyId: sender.academyId }
          : { scope: 'platform' };
      const rows = await tx.communicationCampaign.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        include: { author: { select: { name: true } } },
      });
      const page = rows.slice(0, limit);
      const progress = await this.progressFor(
        tx,
        page.map((row) => row.id),
      );
      return {
        items: page.map((row) => this.toSummary(row, progress.get(row.id))),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  async get(sender: SenderContext, campaignId: string): Promise<CampaignSummaryResponse> {
    return this.inSenderContext(sender, async (tx) => {
      const row = await tx.communicationCampaign.findUnique({
        where: { id: campaignId },
        include: { author: { select: { name: true } } },
      });
      const inScope =
        row &&
        (sender.scope === 'academy'
          ? row.scope === 'academy' && row.academyId === sender.academyId
          : row.scope === 'platform');
      if (!row || !inScope)
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      const progress = await this.progressFor(tx, [row.id]);
      return this.toSummary(row, progress.get(row.id));
    });
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private inSenderContext<T>(
    sender: SenderContext,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return sender.scope === 'academy'
      ? this.tenancy.runInTenantAndUserContext(
          sender.organizationId,
          sender.actorUserId,
          work,
        )
      : this.tenancy.runInUserContext(sender.actorUserId, work);
  }

  private audienceContext(sender: SenderContext): AudienceContext {
    return sender.scope === 'academy'
      ? { scope: 'academy', academyId: sender.academyId }
      : { scope: 'platform' };
  }

  private async count(
    tx: Prisma.TransactionClient,
    sender: SenderContext,
    input: ComposeInput,
  ): Promise<Counted> {
    const counts = await countAudience(tx, input.audience, this.audienceContext(sender));
    const emailable = counts.recipients - counts.suppressed - counts.optedOut;
    return {
      recipientCount: counts.recipients,
      emailCount: input.channels.email ? Math.max(0, emailable) : 0,
      inAppCount: input.channels.inApp ? counts.recipients : 0,
      optedOut: input.channels.email ? counts.optedOut : 0,
      suppressed: input.channels.email ? counts.suppressed : 0,
    };
  }

  /**
   * Ids a client names (courses, an organization) must exist inside the
   * sender's scope — a course of another academy is refused rather than
   * quietly matching nobody, so the composer can say why.
   */
  private async assertAudienceInScope(
    tx: Prisma.TransactionClient,
    sender: SenderContext,
    audience: CampaignAudience,
  ): Promise<void> {
    if (sender.scope === 'academy' && audience.type === 'courses') {
      const unique = [...new Set(audience.courseIds)];
      const found = await tx.course.count({
        where: { id: { in: unique }, academyId: sender.academyId },
      });
      if (found !== unique.length) {
        throw new UnprocessableEntityException({
          messageKey: 'errors.messaging.unknownCourse',
          code: 'CAMPAIGN_UNKNOWN_COURSE',
        });
      }
    }
    if (sender.scope === 'platform' && audience.type === 'organization') {
      const organization = await tx.organization.findUnique({
        where: { id: audience.organizationId },
        select: { id: true },
      });
      if (!organization) {
        throw new UnprocessableEntityException({
          messageKey: 'errors.messaging.unknownOrganization',
          code: 'CAMPAIGN_UNKNOWN_ORGANIZATION',
        });
      }
    }
  }

  private assertChannels(channels: CampaignChannels): void {
    if (!channels.email && !channels.inApp) {
      throw new UnprocessableEntityException({
        messageKey: 'errors.messaging.noChannel',
        code: 'CAMPAIGN_NO_CHANNEL',
      });
    }
  }

  /** Subject and raw body size — no parsing, safe to run before the rate limit. */
  private assertRawContent(input: SendInput): string {
    // Control characters (CR/LF included) never belong in a subject line —
    // they are the classic header-injection vector.
    // eslint-disable-next-line no-control-regex
    const subject = input.subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!subject || subject.length > CAMPAIGN_SUBJECT_MAX) {
      throw new UnprocessableEntityException({
        messageKey: 'errors.messaging.subjectInvalid',
        code: 'CAMPAIGN_SUBJECT_INVALID',
        details: { max: CAMPAIGN_SUBJECT_MAX },
      });
    }
    if (
      input.bodyHtml.length > CAMPAIGN_BODY_HTML_MAX ||
      Buffer.byteLength(input.bodyHtml, 'utf8') > CAMPAIGN_BODY_HTML_MAX_BYTES
    ) {
      throw new UnprocessableEntityException({
        messageKey: 'errors.messaging.bodyTooLong',
        code: 'CAMPAIGN_BODY_TOO_LONG',
        details: { max: CAMPAIGN_BODY_TEXT_MAX },
      });
    }
    return subject;
  }

  private sanitizeContent(input: SendInput): {
    subject: string;
    html: string;
    text: string;
  } {
    const subject = this.assertRawContent(input);
    const sanitized = sanitizeRichText(input.bodyHtml);
    if (!sanitized.text) {
      throw new UnprocessableEntityException({
        messageKey: 'errors.messaging.bodyEmpty',
        code: 'CAMPAIGN_BODY_EMPTY',
      });
    }
    if (sanitized.text.length > CAMPAIGN_BODY_TEXT_MAX) {
      throw new UnprocessableEntityException({
        messageKey: 'errors.messaging.bodyTooLong',
        code: 'CAMPAIGN_BODY_TOO_LONG',
        details: { max: CAMPAIGN_BODY_TEXT_MAX },
      });
    }
    return { subject, html: sanitized.html, text: sanitized.text };
  }

  private async findReplay(
    sender: SenderContext,
    idempotencyScope: string,
    idempotencyKey: string,
  ): Promise<CampaignAcceptedResponse | null> {
    return this.inSenderContext(sender, async (tx) => {
      const existing = await tx.communicationCampaign.findUnique({
        where: { idempotencyScope_idempotencyKey: { idempotencyScope, idempotencyKey } },
        select: {
          id: true,
          status: true,
          recipientCount: true,
          expectedEmailCount: true,
          channels: true,
          createdBy: true,
        },
      });
      if (!existing) return null;
      // A key is the author's own: another person reusing it gets a
      // conflict, never somebody else's campaign.
      if (existing.createdBy !== sender.actorUserId) {
        throw new ConflictException({
          messageKey: 'errors.messaging.idempotencyKeyReused',
          code: 'CAMPAIGN_IDEMPOTENCY_KEY_REUSED',
        });
      }
      const channels = existing.channels as unknown as CampaignChannels;
      const quota =
        sender.scope === 'academy'
          ? await this.quota.view(tx, sender.organizationId, sender.academyId)
          : null;
      return {
        campaignId: existing.id,
        status: existing.status,
        recipientCount: existing.recipientCount,
        emailCount: existing.expectedEmailCount,
        inAppCount: channels.inApp ? existing.recipientCount : 0,
        replayed: true,
        quota,
      };
    });
  }

  /**
   * Progress, from the rows themselves:
   *   - outbox state per campaign (`pending`/`deferred` = queued;
   *     `dispatched` with no reason = sent; `dispatched` with a reason or
   *     `suppressed` = skipped; `failed`);
   *   - delivered / bounced from provider webhooks on the email deliveries;
   *   - in-app and awaiting-release from `campaign_recipients`.
   * Nothing here is estimated.
   */
  private async progressFor(
    tx: Prisma.TransactionClient,
    campaignIds: readonly string[],
  ): Promise<Map<string, CampaignProgressView>> {
    const result = new Map<string, CampaignProgressView>();
    if (campaignIds.length === 0) return result;
    const ids = [...campaignIds];
    const [outbox, deliveries, recipients] = await Promise.all([
      tx.$queryRaw<
        {
          campaign_id: string;
          queued: number;
          sent: number;
          skipped: number;
          failed: number;
        }[]
      >`
        SELECT o."campaign_id",
               count(*) FILTER (WHERE o."state" IN ('pending', 'deferred'))::int AS queued,
               count(*) FILTER (WHERE o."state" = 'dispatched' AND o."last_error" IS NULL)::int AS sent,
               count(*) FILTER (WHERE (o."state" = 'dispatched' AND o."last_error" IS NOT NULL)
                                   OR o."state" = 'suppressed')::int AS skipped,
               count(*) FILTER (WHERE o."state" = 'failed')::int AS failed
          FROM "communication_outbox" o
         WHERE o."campaign_id" = ANY(${ids}::text[])
         GROUP BY o."campaign_id"
      `,
      tx.$queryRaw<{ campaign_id: string; delivered: number; bounced: number }[]>`
        SELECT o."campaign_id",
               count(*) FILTER (WHERE d."status" = 'delivered')::int AS delivered,
               count(*) FILTER (WHERE d."status" IN ('bounced', 'complained'))::int AS bounced
          FROM "communication_deliveries" d
          JOIN "communication_outbox" o ON o."id" = d."outbox_id"
         WHERE o."campaign_id" = ANY(${ids}::text[]) AND d."channel" = 'email'
         GROUP BY o."campaign_id"
      `,
      tx.$queryRaw<{ campaign_id: string; awaiting: number }[]>`
        SELECT r."campaign_id", count(*) FILTER (WHERE r."state" = 0)::int AS awaiting
          FROM "campaign_recipients" r
         WHERE r."campaign_id" = ANY(${ids}::text[])
         GROUP BY r."campaign_id"
      `,
    ]);
    const empty: CampaignProgressView = {
      queued: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      delivered: 0,
      bounced: 0,
      inApp: 0,
      awaitingRelease: 0,
    };
    for (const id of ids) result.set(id, { ...empty });
    for (const row of outbox) {
      const current = result.get(row.campaign_id)!;
      result.set(row.campaign_id, {
        ...current,
        queued: row.queued,
        sent: row.sent,
        skipped: row.skipped,
        failed: row.failed,
      });
    }
    for (const row of deliveries) {
      const current = result.get(row.campaign_id)!;
      result.set(row.campaign_id, {
        ...current,
        delivered: row.delivered,
        bounced: row.bounced,
      });
    }
    for (const row of recipients) {
      const current = result.get(row.campaign_id)!;
      result.set(row.campaign_id, { ...current, awaitingRelease: row.awaiting });
    }
    return result;
  }

  private toSummary(
    row: Prisma.CommunicationCampaignGetPayload<{
      include: { author: { select: { name: true } } };
    }>,
    progress: CampaignProgressView | undefined,
  ): CampaignSummaryResponse {
    const base = progress ?? {
      queued: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      delivered: 0,
      bounced: 0,
      inApp: 0,
      awaitingRelease: 0,
    };
    return {
      id: row.id,
      scope: row.scope as CampaignScope,
      status: row.status,
      subject: row.subject,
      channels: row.channels as unknown as CampaignChannels,
      audience: row.audience as unknown as CampaignAudience,
      recipientCount: row.recipientCount,
      expectedEmailCount: row.expectedEmailCount,
      excluded: {
        optedOut: row.excludedOptedOut,
        suppressed: row.excludedSuppressed,
        quota: row.excludedQuota,
      },
      // The in-app count is the release step's own tally of rows it wrote.
      progress: { ...base, inApp: row.inAppReleasedCount },
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      authorName: row.author?.name ?? null,
    };
  }

  /** Fixed-window limiter under `ratelimit:` (the namespace the e2e helper flushes). */
  private async rateLimit(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<void> {
    let count = 0;
    let ttl = windowSeconds;
    try {
      const client = this.redis.getClient();
      const redisKey = `ratelimit:${key}`;
      count = await client.incr(redisKey);
      if (count === 1) await client.expire(redisKey, windowSeconds);
      if (count > max) ttl = await client.ttl(redisKey);
    } catch (error) {
      // A sending limit must not fail open silently for long, but a Redis
      // blip must not block a legitimate send either: log and allow.
      this.logger.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        'Campaign rate limit could not be checked; allowing this request.',
      );
      return;
    }
    if (count > max) {
      throw new HttpException(
        {
          messageKey: 'errors.messaging.rateLimited',
          code: 'CAMPAIGN_RATE_LIMITED',
          details: { retryAfterSeconds: ttl > 0 ? ttl : windowSeconds },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** The sender name shown in the in-app feed. */
  senderNameFor(scope: CampaignScope, academyName: string | null): string {
    return scope === 'academy' ? (academyName ?? this.platformName) : this.platformName;
  }
}
