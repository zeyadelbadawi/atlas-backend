/**
 * W3-compose — turns an accepted campaign into outbox rows, off the
 * request path, in bounded steps:
 *
 *   EXPAND   keyset pages of 200 people (ordered by user id) written to
 *            `campaign_recipients` set-based, each page in its own short
 *            transaction that locks the campaign row first, so two workers
 *            can never interleave pages or double-count. Resumable from
 *            `expansion_cursor` after a crash.
 *   RELEASE  batches of 200 recipients still at state 0: one INSERT into
 *            `communication_outbox` for the email rows (linked by
 *            `campaign_id`, deduped per recipient by `campaign:<id>`), one
 *            INSERT into `notifications` when the in-app channel is on,
 *            and the recipients flipped to state 1 — all in one
 *            transaction, so a batch is released exactly once. Dispatch
 *            hints are enqueued after commit (the outbox sweep is the
 *            safety net). At most `CAMPAIGN_RELEASE_PER_RUN` per run: the
 *            outbox is a queue, not a dumping ground.
 *   SETTLE   once every recipient is released, unused academy quota is
 *            given back (`release`); once every email row is terminal, the
 *            units of rows that FAILED without provider acceptance are
 *            refunded (`refund`) and the campaign is `completed`. Status is
 *            only ever moved by these facts, never by a timer.
 *
 * CONTEXT. A platform campaign runs under the Platform Owner's user
 * context (the dispatcher's precedent). An academy campaign runs under its
 * OWN organization's tenant context plus the Platform Owner user — so the
 * audience reads are bounded by that tenant's RLS (and by the explicit
 * `academy_id` filters in `campaign-audience.ts`), while the campaign's
 * own bookkeeping uses the platform policies.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { CommunicationService } from '../services/communication.service';
import { COMMUNICATION_CATALOG } from '../catalog/communication-catalog';
import type { CommunicationsConfig } from '../../config/configuration';
import {
  CAMPAIGN_BATCH_SIZE,
  CAMPAIGN_IN_APP_EXCERPT_MAX,
  CAMPAIGN_KEY,
  CAMPAIGN_RELEASE_PER_RUN,
  type CampaignAudience,
  type CampaignChannels,
  type CampaignScope,
} from './campaign.types';
import { expandAudiencePage, type AudienceContext } from './campaign-audience';
import { excerpt } from './rich-text-sanitizer';
import { AcademyEmailQuotaService } from './academy-email-quota.service';
import { CAMPAIGN_TICK_BATCH } from './queue/campaigns.types';

/** Pages one run expands before yielding to the tick. */
const MAX_PAGES_PER_RUN = 100;

export type CampaignRunOutcome =
  'missing' | 'idle' | 'expanding' | 'sending' | 'completed';

interface LoadedCampaign {
  readonly id: string;
  readonly scope: CampaignScope;
  readonly status: string;
  readonly organizationId: string | null;
  readonly academyId: string | null;
  readonly academyName: string | null;
  readonly academyLanguage: string | null;
  readonly channels: CampaignChannels;
  readonly audience: CampaignAudience;
  readonly subject: string;
  readonly bodyText: string;
}

@Injectable()
export class CampaignWorkerService {
  private readonly logger = new Logger(CampaignWorkerService.name);
  private readonly platformName: string;

  constructor(
    private readonly tenancy: TenancyContextService,
    private readonly users: UsersRepository,
    private readonly communications: CommunicationService,
    private readonly quota: AcademyEmailQuotaService,
    configService: ConfigService,
  ) {
    this.platformName =
      configService.get<CommunicationsConfig>('communications')?.platformName ?? 'Atlas';
  }

  /** Advances every campaign still in flight. Returns how many it looked at. */
  async tick(): Promise<number> {
    const platformOwnerId = await this.platformOwnerId();
    if (!platformOwnerId) return 0;
    const active = await this.tenancy.runInUserContext(platformOwnerId, (tx) =>
      tx.communicationCampaign.findMany({
        where: { status: { in: ['queued', 'expanding', 'sending'] } },
        orderBy: { updatedAt: 'asc' },
        take: CAMPAIGN_TICK_BATCH,
        select: { id: true },
      }),
    );
    for (const { id } of active) {
      try {
        await this.run(id);
      } catch (error) {
        this.logger.error(
          {
            campaignId: id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Campaign step failed; the next tick retries it.',
        );
        await this.recordError(platformOwnerId, id, error);
      }
    }
    return active.length;
  }

  /** One bounded step of one campaign: expand → release → settle. */
  async run(campaignId: string): Promise<CampaignRunOutcome> {
    const platformOwnerId = await this.platformOwnerId();
    if (!platformOwnerId) return 'idle';
    const campaign = await this.load(platformOwnerId, campaignId);
    if (!campaign) return 'missing';
    if (!['queued', 'expanding', 'sending'].includes(campaign.status)) return 'idle';

    if (campaign.status === 'queued' || campaign.status === 'expanding') {
      const finished = await this.expand(platformOwnerId, campaign);
      if (!finished) return 'expanding';
    }
    await this.release(platformOwnerId, campaign);
    return this.settle(platformOwnerId, campaign);
  }

  // ---------------------------------------------------------------------
  // expand
  // ---------------------------------------------------------------------

  /** `true` once the whole audience has been written. */
  async expand(platformOwnerId: string, campaign: LoadedCampaign): Promise<boolean> {
    const context: AudienceContext =
      campaign.scope === 'academy'
        ? { scope: 'academy', academyId: campaign.academyId! }
        : { scope: 'platform' };
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const step = await this.inCampaignContext(platformOwnerId, campaign, async (tx) => {
        const [locked] = await tx.$queryRaw<
          {
            status: string;
            expansion_cursor: string | null;
            quota_reserved: number;
            expanded_count: number;
            excluded_opted_out: number;
            excluded_suppressed: number;
            excluded_quota: number;
          }[]
        >`
          SELECT "status", "expansion_cursor", "quota_reserved", "expanded_count",
                 "excluded_opted_out", "excluded_suppressed", "excluded_quota"
            FROM "communication_campaigns" WHERE "id" = ${campaign.id}
           FOR UPDATE
        `;
        if (!locked || !['queued', 'expanding'].includes(locked.status))
          return { done: true };

        // An academy's email-eligible rows may never exceed what it reserved.
        const emailBudget =
          campaign.scope === 'academy' && campaign.channels.email
            ? Math.max(
                0,
                locked.quota_reserved -
                  (locked.expanded_count -
                    locked.excluded_opted_out -
                    locked.excluded_suppressed -
                    locked.excluded_quota),
              )
            : null;
        const result = await expandAudiencePage(tx, {
          campaignId: campaign.id,
          audience: campaign.audience,
          context,
          cursor: locked.expansion_cursor,
          limit: CAMPAIGN_BATCH_SIZE,
          emailChannel: campaign.channels.email,
          emailBudget,
        });
        const done = result.pageSize < CAMPAIGN_BATCH_SIZE;
        await tx.$executeRaw`
          UPDATE "communication_campaigns"
             SET "status" = ${done ? 'sending' : 'expanding'}::"communication_campaign_status",
                 "expansion_cursor" = ${result.lastUserId ?? locked.expansion_cursor},
                 "expanded_count" = "expanded_count" + ${result.written},
                 "excluded_opted_out" = "excluded_opted_out" + ${result.optedOut},
                 "excluded_suppressed" = "excluded_suppressed" + ${result.suppressed},
                 "excluded_quota" = "excluded_quota" + ${result.quotaExcluded},
                 "started_at" = COALESCE("started_at", now()),
                 "updated_at" = now()
           WHERE "id" = ${campaign.id}
        `;
        return { done };
      });
      if (step.done) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // release
  // ---------------------------------------------------------------------

  /** Releases up to `CAMPAIGN_RELEASE_PER_RUN` recipients. Returns how many. */
  async release(platformOwnerId: string, campaign: LoadedCampaign): Promise<number> {
    const entry = COMMUNICATION_CATALOG[CAMPAIGN_KEY[campaign.scope]];
    const senderName =
      campaign.scope === 'academy'
        ? (campaign.academyName ?? this.platformName)
        : this.platformName;
    const defaultLocale =
      campaign.scope === 'academy' && campaign.academyLanguage === 'ar' ? 'ar' : 'en';
    const dedupeKey = entry.dedupe({
      entity: { type: 'communication_campaign', id: campaign.id },
      values: {},
    });
    const outboxChannels = JSON.stringify({
      inApp: campaign.channels.inApp,
      email: campaign.channels.email ? 'preference' : 'never',
    });
    const inAppValues = JSON.stringify({
      campaignId: campaign.id,
      subject: campaign.subject,
      excerpt: excerpt(campaign.bodyText, CAMPAIGN_IN_APP_EXCERPT_MAX),
      senderName,
    });

    let released = 0;
    while (released < CAMPAIGN_RELEASE_PER_RUN) {
      const batch = await this.inCampaignContext(
        platformOwnerId,
        campaign,
        async (tx) => {
          const [locked] = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status" FROM "communication_campaigns" WHERE "id" = ${campaign.id} FOR UPDATE
        `;
          if (!locked || locked.status !== 'sending') return { count: 0, outboxIds: [] };
          const rows = await tx.$queryRaw<{ user_id: string; email_eligible: boolean }[]>`
          SELECT "user_id", "email_eligible" FROM "campaign_recipients"
           WHERE "campaign_id" = ${campaign.id} AND "state" = 0
           ORDER BY "user_id"
           LIMIT ${CAMPAIGN_BATCH_SIZE}
        `;
          if (rows.length === 0) return { count: 0, outboxIds: [] };

          const userIds = rows.map((row) => row.user_id);
          const outboxByUser = new Map<string, string>();
          for (const row of rows) {
            if (campaign.channels.email && row.email_eligible) {
              outboxByUser.set(row.user_id, randomUUID());
            }
          }
          const emailUsers = [...outboxByUser.keys()];
          const emailOutboxIds = emailUsers.map((userId) => outboxByUser.get(userId)!);

          if (emailUsers.length > 0) {
            await tx.$executeRaw`
            INSERT INTO "communication_outbox"
              ("id", "key", "category", "recipient_user_id", "organization_id", "academy_id",
               "entity_type", "entity_id", "dedupe_key", "locale", "branding", "values", "channels",
               "priority", "state", "available_at", "attempts", "created_at", "campaign_id")
            SELECT t.id, ${CAMPAIGN_KEY[campaign.scope]}, ${entry.category}::"communication_category",
                   t.user_id, ${campaign.organizationId}, ${campaign.academyId},
                   'communication_campaign', ${campaign.id}, ${dedupeKey},
                   CASE WHEN u."preferences"->>'language' IN ('en', 'ar')
                        THEN u."preferences"->>'language' ELSE ${defaultLocale} END,
                   ${entry.branding}, '{}'::jsonb, ${outboxChannels}::jsonb,
                   ${entry.priority}::"notification_priority",
                   'pending'::"communication_outbox_state", now(), 0, now(), ${campaign.id}
              FROM unnest(${emailOutboxIds}::text[], ${emailUsers}::text[]) AS t(id, user_id)
              JOIN "users" u ON u."id" = t.user_id
          `;
          }
          let inApp = 0;
          if (campaign.channels.inApp) {
            // Notification context isolation — a platform broadcast, or an
            // academy campaign to its STAFF, belongs to the Management
            // dashboard; an academy campaign to learners belongs to that
            // academy's learner area.
            const placement = campaignNotificationPlacement(campaign);
            inApp = await tx.$executeRaw`
            INSERT INTO "notifications"
              ("id", "user_id", "type", "priority", "title_key", "message_key", "values",
               "action_url", "action_label_key", "metadata", "dedupe_key", "retention_class",
               "context", "academy_id", "created_at", "updated_at")
            SELECT gen_random_uuid()::text, t.user_id, ${entry.notificationType}::"notification_type",
                   ${entry.priority}::"notification_priority", ${entry.titleKey}, ${entry.messageKey},
                   ${inAppValues}::jsonb, NULL, NULL,
                   ${JSON.stringify({ campaignId: campaign.id })}::jsonb, ${dedupeKey},
                   ${entry.retentionClass}::"notification_retention_class",
                   ${placement.context}::"notification_context", ${placement.academyId},
                   now(), now()
              FROM unnest(${userIds}::text[]) AS t(user_id)
          `;
          }
          const outboxColumn = userIds.map((userId) => outboxByUser.get(userId) ?? null);
          await tx.$executeRaw`
          UPDATE "campaign_recipients" r
             SET "state" = 1, "released_at" = now(), "outbox_id" = m.outbox_id
            FROM unnest(${userIds}::text[], ${outboxColumn}::text[]) AS m(user_id, outbox_id)
           WHERE r."campaign_id" = ${campaign.id} AND r."user_id" = m.user_id AND r."state" = 0
        `;
          await tx.$executeRaw`
          UPDATE "communication_campaigns"
             SET "email_released_count" = "email_released_count" + ${emailUsers.length},
                 "in_app_released_count" = "in_app_released_count" + ${inApp},
                 "updated_at" = now()
           WHERE "id" = ${campaign.id}
        `;
          return { count: rows.length, outboxIds: emailOutboxIds };
        },
      );
      if (batch.count === 0) break;
      released += batch.count;
      for (const outboxId of batch.outboxIds) {
        await this.communications.enqueueAfterCommit(outboxId);
      }
      if (batch.count < CAMPAIGN_BATCH_SIZE) break;
    }
    return released;
  }

  // ---------------------------------------------------------------------
  // settle
  // ---------------------------------------------------------------------

  async settle(
    platformOwnerId: string,
    campaign: LoadedCampaign,
  ): Promise<CampaignRunOutcome> {
    return this.inCampaignContext(platformOwnerId, campaign, async (tx) => {
      const [locked] = await tx.$queryRaw<
        {
          status: string;
          quota_reserved: number;
          email_released_count: number;
          quota_period_start: Date | null;
        }[]
      >`
        SELECT "status", "quota_reserved", "email_released_count", "quota_period_start"
          FROM "communication_campaigns" WHERE "id" = ${campaign.id} FOR UPDATE
      `;
      if (!locked) return 'missing';
      if (locked.status !== 'sending') {
        return locked.status === 'completed' ? 'completed' : 'expanding';
      }
      const [{ awaiting }] = await tx.$queryRaw<{ awaiting: number }[]>`
        SELECT count(*)::int AS awaiting FROM "campaign_recipients"
         WHERE "campaign_id" = ${campaign.id} AND "state" = 0
      `;
      if (awaiting > 0) return 'sending';

      const academyQuota =
        campaign.scope === 'academy' && locked.quota_period_start
          ? {
              organizationId: campaign.organizationId!,
              academyId: campaign.academyId!,
              periodStart: locked.quota_period_start,
              messageId: campaign.id,
            }
          : null;
      // Charge = email rows actually created: give back what was reserved
      // but never became a row (people who left, opted out or were
      // suppressed between the send and the expansion).
      if (academyQuota && locked.quota_reserved > locked.email_released_count) {
        await this.quota.giveBack(tx, {
          ...academyQuota,
          kind: 'release',
          quantity: locked.quota_reserved - locked.email_released_count,
        });
      }

      const [states] = await tx.$queryRaw<{ open: number; failed: number }[]>`
        SELECT count(*) FILTER (WHERE "state" IN ('pending', 'deferred'))::int AS open,
               count(*) FILTER (WHERE "state" = 'failed')::int AS failed
          FROM "communication_outbox" WHERE "campaign_id" = ${campaign.id}
      `;
      if (states.open > 0) return 'sending';

      // Terminal failures never reached a provider (a provider acceptance
      // settles the row `dispatched`), so their units are refunded.
      if (academyQuota && states.failed > 0) {
        await this.quota.giveBack(tx, {
          ...academyQuota,
          kind: 'refund',
          quantity: states.failed,
        });
      }
      await tx.$executeRaw`
        UPDATE "communication_campaigns"
           SET "status" = 'completed'::"communication_campaign_status",
               "completed_at" = now(), "updated_at" = now()
         WHERE "id" = ${campaign.id}
      `;
      return 'completed';
    });
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private inCampaignContext<T>(
    platformOwnerId: string,
    campaign: Pick<LoadedCampaign, 'scope' | 'organizationId'>,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return campaign.scope === 'academy' && campaign.organizationId
      ? this.tenancy.runInTenantAndUserContext(
          campaign.organizationId,
          platformOwnerId,
          work,
        )
      : this.tenancy.runInUserContext(platformOwnerId, work);
  }

  private async load(
    platformOwnerId: string,
    campaignId: string,
  ): Promise<LoadedCampaign | null> {
    const row = await this.tenancy.runInUserContext(platformOwnerId, (tx) =>
      tx.communicationCampaign.findUnique({
        where: { id: campaignId },
        include: { academy: { select: { name: true, language: true } } },
      }),
    );
    if (!row) return null;
    return {
      id: row.id,
      scope: row.scope as CampaignScope,
      status: row.status,
      organizationId: row.organizationId,
      academyId: row.academyId,
      academyName: row.academy?.name ?? null,
      academyLanguage: row.academy?.language ?? null,
      channels: row.channels as unknown as CampaignChannels,
      audience: row.audience as unknown as CampaignAudience,
      subject: row.subject,
      bodyText: row.bodyText,
    };
  }

  private async recordError(
    platformOwnerId: string,
    campaignId: string,
    error: unknown,
  ): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    );
    try {
      await this.tenancy.runInUserContext(
        platformOwnerId,
        (tx) =>
          tx.$executeRaw`
          UPDATE "communication_campaigns" SET "last_error" = ${message}, "updated_at" = now()
           WHERE "id" = ${campaignId}
        `,
      );
    } catch {
      // Recording the error is best-effort; the log line above has it.
    }
  }

  private async platformOwnerId(): Promise<string | null> {
    const owner = await this.users.findFirstPlatformOwnerId();
    if (owner) return owner.id;
    this.logger.warn(
      'No platform owner account exists yet — campaigns cannot be processed.',
    );
    return null;
  }
}

/** Notification context isolation — where a campaign's in-app rows are shown. */
export function campaignNotificationPlacement(campaign: {
  readonly scope: string;
  readonly academyId: string | null;
  readonly audience: unknown;
}): { readonly context: 'management' | 'academy'; readonly academyId: string | null } {
  const audienceType =
    campaign.audience && typeof campaign.audience === 'object'
      ? (campaign.audience as { type?: unknown }).type
      : undefined;
  if (campaign.scope === 'academy' && campaign.academyId && audienceType !== 'staff') {
    return { context: 'academy', academyId: campaign.academyId };
  }
  return { context: 'management', academyId: null };
}
