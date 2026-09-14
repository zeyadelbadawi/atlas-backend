/**
 * LiveProviderEventsRepository — the idempotency authority for inbound
 * provider events.
 *
 * `provider_event_id` is UNIQUE, and `tryInsert` reports whether THIS call
 * actually created the row. That distinction is the whole mechanism: a
 * redelivered webhook loses the insert and is skipped, without any
 * "have I seen this?" read that would race with itself.
 *
 * `live_provider_events` is PLATFORM-OWNED and carries no RLS — the same
 * position `payment_webhook_events` occupies, and for the same reason: a
 * webhook arrives with no tenant context at all (it is authenticated by
 * signature, not by session), so the row must be written before any tenant
 * is known. The academy is resolved FROM stored provider identifiers
 * afterwards, never from anything the request claimed.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LiveProviderEvent } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface RecordEventInput {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly summary?: Prisma.InputJsonValue;
}

@Injectable()
export class LiveProviderEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an inbound event.
   *
   * `createMany({ skipDuplicates })` compiles to INSERT ... ON CONFLICT DO
   * NOTHING, used here for the same reason `TrialEligibilityService` uses
   * it: a raised unique violation would poison the surrounding
   * transaction in Postgres, and no application-level catch could rescue
   * it. This never raises, so idempotency costs nothing.
   *
   * @returns `true` when this call recorded a genuinely new event.
   */
  async tryInsert(input: RecordEventInput): Promise<boolean> {
    const inserted = await this.prisma.liveProviderEvent.createMany({
      data: [
        {
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          status: 'received',
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }

  findByProviderEventId(providerEventId: string): Promise<LiveProviderEvent | null> {
    return this.prisma.liveProviderEvent.findUnique({ where: { providerEventId } });
  }

  /**
   * Marks how an event resolved.
   *
   * `unmatched` is a first-class outcome, not a failure: an event for a
   * meeting Atlas has no record of is stored and surfaced rather than
   * silently dropped, because silent discard is indistinguishable from a
   * bug when someone later asks why attendance is missing.
   */
  async markResolved(
    providerEventId: string,
    status: 'processed' | 'unmatched' | 'failed',
    context?: {
      readonly academyId?: string;
      readonly liveSessionId?: string;
      readonly failureReason?: string;
    },
  ): Promise<void> {
    await this.prisma.liveProviderEvent.updateMany({
      where: { providerEventId },
      data: {
        status,
        processedAt: new Date(),
        ...(context?.academyId ? { academyId: context.academyId } : {}),
        ...(context?.liveSessionId ? { liveSessionId: context.liveSessionId } : {}),
        // Provider-agnostic summary only — never a raw provider payload.
        ...(context?.failureReason ? { failureReason: context.failureReason } : {}),
      },
    });
  }
}
