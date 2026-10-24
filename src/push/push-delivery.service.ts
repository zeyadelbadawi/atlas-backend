/**
 * Sends the push for one communication outbox row (B1).
 *
 * Runs after the dispatcher has taken the row, i.e. after the in-app
 * notification was committed. Decides who gets it exactly like the feed
 * does (`notificationContextFor`): an academy notification goes only to the
 * recipient's devices registered on THAT academy, an account-wide notice
 * (security) to all of them, a management notification to none (the app is
 * the learner app). A device is used only while the session that
 * registered it is alive.
 *
 * `FLAG_PUSH_MODE` other than `on` → nothing is sent (the default).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenancyContextService } from '../tenancy/services/tenancy-context.service';
import {
  COMMUNICATION_CATALOG,
  isCommunicationEventKey,
  notificationContextFor,
} from '../communications/catalog/communication-catalog';
import { PUSH_PROVIDER } from './providers/push-provider';
import type { PushProvider } from './providers/push-provider';
import { pushBody, pushTitle } from './push-copy';
import type { PushLocale } from './push-copy';

export type PushOutcome =
  | 'disabled'
  | 'skipped'
  | 'no_devices'
  | { readonly sent: number; readonly removed: number; readonly failed: number };

/** Thrown so BullMQ retries: at least one device failed transiently and none was sent. */
export class PushTransientError extends Error {}

@Injectable()
export class PushDeliveryService {
  private readonly logger = new Logger(PushDeliveryService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyContextService,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
  ) {}

  enabled(): boolean {
    return this.config.get<string>('FLAG_PUSH_MODE') === 'on';
  }

  async deliver(outboxId: string): Promise<PushOutcome> {
    if (!this.enabled()) return 'disabled';

    const ownerId = await this.platformOwnerId();
    if (!ownerId) return 'skipped';
    const loaded = await this.tenancy.runInUserContext(ownerId, async (tx) => {
      const row = await tx.communicationOutbox.findUnique({ where: { id: outboxId } });
      if (!row) return null;
      const academy = row.academyId
        ? await tx.academy.findUnique({
            where: { id: row.academyId },
            select: { name: true },
          })
        : null;
      return { row, academyName: academy?.name ?? null };
    });
    if (!loaded) return 'skipped';
    const { row, academyName } = loaded;
    const channels = row.channels as { inApp?: unknown } | null;
    if (!row.recipientUserId || channels?.inApp !== true) return 'skipped';
    if (!isCommunicationEventKey(row.key)) return 'skipped';

    const placement = notificationContextFor(row.key, row.academyId);
    if (placement.context !== 'academy' && placement.context !== 'account')
      return 'skipped';
    const recipientId = row.recipientUserId;
    const entry = COMMUNICATION_CATALOG[row.key];

    const devices = await this.tenancy.runInUserContext(recipientId, async (tx) => {
      const candidates = await tx.pushDevice.findMany({
        where: {
          userId: recipientId,
          ...(placement.context === 'academy' ? { academyId: placement.academyId! } : {}),
        },
      });
      if (candidates.length === 0) return [];
      const live = await tx.refreshToken.findMany({
        where: {
          userId: recipientId,
          sessionId: { in: [...new Set(candidates.map((d) => d.sessionId))] },
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { sessionId: true },
      });
      const liveSessions = new Set(live.map((t) => t.sessionId));
      return candidates.filter((d) => liveSessions.has(d.sessionId));
    });
    if (devices.length === 0) return 'no_devices';

    const actionUrl = entry.actionUrl?.({
      entity: { type: row.entityType ?? '', id: row.entityId ?? '' },
      values: (row.values as Record<string, unknown> | null) ?? {},
    });
    const data: Record<string, string> = {
      kind: 'notification',
      context: placement.context,
      ...(placement.academyId ? { academyId: placement.academyId } : {}),
      ...(actionUrl && actionUrl.startsWith('/') ? { path: actionUrl } : {}),
    };

    let sent = 0;
    let failed = 0;
    let transient = 0;
    const dead: string[] = [];
    const delivered: string[] = [];
    for (const device of devices) {
      const locale: PushLocale = device.locale === 'ar' ? 'ar' : 'en';
      const result = await this.provider.send({
        token: device.token,
        title: pushTitle(placement.context === 'academy' ? academyName : null, locale),
        body: pushBody(entry.notificationType as NotificationType, locale),
        data,
      });
      if (result.ok) {
        sent += 1;
        delivered.push(device.id);
      } else if (result.reason === 'invalid_token') {
        dead.push(device.id);
      } else {
        failed += 1;
        if (result.reason === 'transient') transient += 1;
        this.logger.warn(
          { outboxId, deviceId: device.id, reason: result.reason, detail: result.detail },
          'Push not delivered',
        );
      }
    }

    if (dead.length > 0 || delivered.length > 0) {
      await this.tenancy.runInUserContext(recipientId, async (tx) => {
        if (dead.length > 0) {
          await tx.pushDevice.deleteMany({
            where: { id: { in: dead }, userId: recipientId },
          });
        }
        if (delivered.length > 0) {
          await tx.pushDevice.updateMany({
            where: { id: { in: delivered }, userId: recipientId },
            data: { lastSentAt: new Date() },
          });
        }
      });
    }
    if (sent === 0 && transient > 0) {
      throw new PushTransientError(
        `push for ${outboxId}: ${transient} transient failure(s)`,
      );
    }
    return { sent, removed: dead.length, failed };
  }

  private async platformOwnerId(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT platform_owner_user_id() AS id`;
    return rows[0]?.id ?? null;
  }
}
