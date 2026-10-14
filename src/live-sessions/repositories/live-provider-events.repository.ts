/**
 * LiveProviderEventsRepository — the idempotency authority for inbound
 * provider events.
 *
 * `provider_event_id` is UNIQUE, and `tryInsert` reports whether THIS call
 * actually created the row. That distinction is the whole mechanism: a
 * redelivered webhook loses the insert and is skipped, without any
 * "have I seen this?" read that would race with itself.
 *
 * `live_provider_events` is PLATFORM-OWNED. A webhook arrives with no
 * tenant context at all (it is authenticated by signature, not by
 * session), so the row must be written before any tenant is known. The
 * academy is resolved FROM stored provider identifiers afterwards, never
 * from anything the request claimed.
 *
 * B0-LIV-03 — the table now has FORCE RLS: INSERT is open, SELECT and
 * UPDATE are the Platform Owner's only. So `tryInsert` stays context-free
 * and the read and status update run under the platform-owner user
 * context, exactly as the communications dispatcher and the subscription
 * sweeps do.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LiveProviderEvent } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';

export interface RecordEventInput {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly summary?: Prisma.InputJsonValue;
}

@Injectable()
export class LiveProviderEventsRepository {
  private readonly logger = new Logger(LiveProviderEventsRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
  ) {}

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

  async findByProviderEventId(
    providerEventId: string,
  ): Promise<LiveProviderEvent | null> {
    return (
      (await this.asPlatformOwner((tx) =>
        tx.liveProviderEvent.findUnique({ where: { providerEventId } }),
      )) ?? null
    );
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
    await this.asPlatformOwner((tx) =>
      tx.liveProviderEvent.updateMany({
        where: { providerEventId },
        data: {
          status,
          processedAt: new Date(),
          ...(context?.academyId ? { academyId: context.academyId } : {}),
          ...(context?.liveSessionId ? { liveSessionId: context.liveSessionId } : {}),
          // Provider-agnostic summary only — never a raw provider payload.
          ...(context?.failureReason ? { failureReason: context.failureReason } : {}),
        },
      }),
    );
  }

  /**
   * Runs `work` as the Platform Owner — the only context the table's
   * SELECT/UPDATE policies admit. With no Platform Owner account (a fresh
   * install) the event stays as recorded and a warning says why.
   */
  private async asPlatformOwner<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | undefined> {
    const owner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!owner) {
      this.logger.warn(
        'No platform owner account exists yet — live provider events cannot be read or marked.',
      );
      return undefined;
    }
    return this.tenancyContextService.runInUserContext(owner.id, work);
  }
}
