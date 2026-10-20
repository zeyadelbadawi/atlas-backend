/**
 * B1 F.5 — what the marketing beacon records, and the retention prune.
 *
 * `record` turns an already-parsed batch into daily aggregate increments;
 * `aggregate` is the read side (no HTTP endpoint yet — a Platform Owner
 * view is a later step); `prune` keeps MKT_RETENTION_MONTHS of history.
 */
import { Injectable } from '@nestjs/common';
import { retentionCutoff } from '../platform-contact/services/platform-contact-retention.service';
import { MarketingEventsRepository } from './marketing-events.repository';
import type { MarketingEventAggregateRow } from './marketing-events.repository';
import {
  aggregateMarketingEvents,
  utcDay,
  type MarketingEvent,
} from './marketing-events.util';
import { MKT_RETENTION_MONTHS } from './marketing-events.vocabulary';

export interface MarketingEventsPruneResult {
  readonly retentionMonths: number;
  readonly cutoff: string;
  readonly deleted: number;
}

@Injectable()
export class MarketingEventsService {
  constructor(private readonly repository: MarketingEventsRepository) {}

  /** Adds a parsed batch to today's (UTC) aggregate rows. */
  async record(
    events: readonly MarketingEvent[],
    now: Date = new Date(),
  ): Promise<number> {
    const rows = aggregateMarketingEvents(events);
    if (rows.length === 0) return 0;
    await this.repository.increment(utcDay(now), rows);
    return rows.reduce((sum, row) => sum + row.count, 0);
  }

  /** Summed counts over a range of UTC days (inclusive). */
  async aggregate(from: Date, to: Date): Promise<MarketingEventAggregateRow[]> {
    return this.repository.sumBetween(utcDay(from), utcDay(to));
  }

  /** Deletes aggregate rows for days older than MKT_RETENTION_MONTHS. Idempotent. */
  async prune(now: Date = new Date()): Promise<MarketingEventsPruneResult> {
    const cutoff = utcDay(retentionCutoff(now, MKT_RETENTION_MONTHS));
    const deleted = await this.repository.deleteBefore(cutoff);
    return {
      retentionMonths: MKT_RETENTION_MONTHS,
      cutoff: cutoff.toISOString().slice(0, 10),
      deleted,
    };
  }
}
