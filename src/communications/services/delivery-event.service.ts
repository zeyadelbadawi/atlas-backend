/**
 * DeliveryEventService — applies one provider delivery event to
 * `communication_deliveries` and the suppression list.
 *
 * Runs in a platform owner's user context (the deliveries table allows
 * UPDATE to platform owners only — `communication_deliveries_platform_update`).
 * Idempotent on `(providerMessageId, event)`: a Redis marker
 * (`comm:webhook:seen:{sha256}`, 7 days) short-circuits redeliveries, and
 * the status write itself is a plain set, so a replay past the marker's
 * TTL is harmless too.
 *
 *   delivered    → status `delivered`
 *   bounced      → `bounced`  + permanent suppression (hard bounce)
 *   soft_bounced → `deferred` (no suppression from a single soft bounce)
 *   complained   → `complained` + permanent suppression
 *   failed       → `failed`
 *   opened/clicked → counted only; no status change
 *
 * A delivery row is matched by `provider_message_id`; an event for a
 * message this platform did not send (or whose row aged out) still
 * suppresses on bounce/complaint — the address is bad regardless.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CommunicationDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { EmailWebhookEventKind } from '../../identity/services/email-provider.interface';
import type { CommunicationsWebhookJobPayload } from '../queue/communications-queue.types';
import { CommunicationMetricsService } from './communication-metrics.service';
import { SuppressionService } from './suppression.service';

const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const STATUS_FOR_EVENT: Readonly<
  Partial<Record<EmailWebhookEventKind, CommunicationDeliveryStatus>>
> = {
  delivered: 'delivered',
  bounced: 'bounced',
  soft_bounced: 'deferred',
  complained: 'complained',
  failed: 'failed',
};

export interface DeliveryEventOutcome {
  readonly duplicate: boolean;
  readonly matchedDeliveries: number;
  readonly suppressed: boolean;
}

@Injectable()
export class DeliveryEventService {
  private readonly logger = new Logger(DeliveryEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly suppressions: SuppressionService,
    private readonly metrics: CommunicationMetricsService,
  ) {}

  async apply(payload: CommunicationsWebhookJobPayload): Promise<DeliveryEventOutcome> {
    const seenKey = `comm:webhook:seen:${createHash('sha256')
      .update(`${payload.provider}\n${payload.providerMessageId}\n${payload.event}`)
      .digest('hex')}`;
    const client = this.redisService.getClient();
    const first = await client.set(seenKey, '1', 'EX', SEEN_TTL_SECONDS, 'NX');
    if (first !== 'OK') {
      return { duplicate: true, matchedDeliveries: 0, suppressed: false };
    }

    try {
      const status = STATUS_FOR_EVENT[payload.event];
      let matchedDeliveries = 0;
      if (status) {
        const ownerId = await this.platformOwnerId();
        if (ownerId) {
          const result = await this.tenancyContextService.runInUserContext(
            ownerId,
            (tx) =>
              tx.communicationDelivery.updateMany({
                where: {
                  providerMessageId: payload.providerMessageId,
                  provider: payload.provider,
                },
                data: {
                  status,
                  ...(payload.reason ? { errorCode: payload.reason.slice(0, 200) } : {}),
                },
              }),
          );
          matchedDeliveries = result.count;
        } else {
          this.logger.warn(
            { provider: payload.provider, event: payload.event },
            'No platform owner account exists yet — delivery status not updated.',
          );
        }
      }

      let suppressed = false;
      if (payload.event === 'bounced' || payload.event === 'complained') {
        await this.suppressions.suppress({
          email: payload.recipientEmail,
          reason: payload.event === 'bounced' ? 'hard_bounce' : 'complaint',
          source: `webhook:${payload.provider}`,
          note: payload.reason?.slice(0, 500),
          expiresAt: null,
        });
        suppressed = true;
      }

      this.metrics.recordDeliveryEvent(payload.provider, payload.event);
      return { duplicate: false, matchedDeliveries, suppressed };
    } catch (error) {
      // Let BullMQ retry: release the marker so the retry is not treated as a duplicate.
      await client.del(seenKey).catch(() => undefined);
      throw error;
    }
  }

  private async platformOwnerId(): Promise<string | null> {
    const owner = await this.prisma.user.findFirst({
      where: { isPlatformOwner: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return owner?.id ?? null;
  }
}
