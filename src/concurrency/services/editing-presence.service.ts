/**
 * Who is editing what, right now.
 *
 * WHY REDIS AND NOT A TABLE. Presence is heartbeat-shaped: every open
 * editor refreshes every few seconds, and the value is worthless the moment
 * it stops being refreshed. Putting that in Postgres means a write per
 * editor per heartbeat against a table nobody ever reads historically, plus
 * a sweep job to delete rows whose owner closed a laptop lid. Redis expiry
 * IS the sweep — a key that stops being touched disappears on its own —
 * and this codebase already runs Redis for exactly this class of ephemeral
 * state (rate-limit counters, the public website cache, session activity).
 *
 * WHY THIS IS NOT A LOCK. A lock has to be released, and the one thing you
 * can rely on with browsers is that they do not reliably tell you when they
 * are gone. A crashed tab holding a lock means an Academy's page is frozen
 * until an operator intervenes, which is a worse failure than the one the
 * lock was preventing. So nothing here blocks a write: presence is
 * ADVISORY, shown to humans so they can coordinate, and the thing that
 * actually protects the data is the version check on save
 * (`StaleResourceVersionException`). Presence answers "should I start
 * typing?"; the version check answers "is it safe to commit?". Both are
 * needed, and only the second one is load-bearing.
 *
 * READS ARE NEVER BLOCKED. Viewing a resource records nothing and is
 * restricted by nothing — only opening an editor announces presence.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * How long a session survives without a heartbeat.
 *
 * Chosen against the client's own interval rather than picked round: the
 * editor heartbeats every 20s, so 60s tolerates two consecutive misses — a
 * backgrounded tab, a slow network, a brief reconnect — before declaring
 * someone gone. Shorter and presence flickers on a bad connection, which
 * trains people to ignore it. Much longer and a closed laptop keeps
 * claiming an editor for minutes after the person has left the building.
 */
export const EDITING_SESSION_TTL_SECONDS = 60;

/** The client's heartbeat cadence. Exported so the frontend cannot drift from the TTL above without the relationship being visible in one place. */
export const EDITING_HEARTBEAT_INTERVAL_SECONDS = 20;

export interface EditingParticipant {
  readonly userId: string;
  readonly name: string;
  /** The academy-membership role, so the UI can say "Ahmed (Manager)". */
  readonly role: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
}

interface StoredParticipant {
  readonly name: string;
  readonly role: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
}

/**
 * One key per resource, holding one field per participant.
 *
 * A hash rather than a key per participant so that listing everyone editing
 * a resource is a single `HGETALL` instead of a scan — scans are the thing
 * that quietly stops working once a system has real traffic.
 */
function presenceKey(resourceType: string, resourceId: string): string {
  return `editing:v1:${resourceType}:${resourceId}`;
}

@Injectable()
export class EditingPresenceService {
  private readonly logger = new Logger(EditingPresenceService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Records or refreshes this user's editing session and returns everyone
   * ELSE currently editing.
   *
   * One call does both because the client needs both on the same cadence,
   * and splitting them would double the request rate for no benefit.
   *
   * The TTL is re-applied on the whole key on every heartbeat: individual
   * hash fields cannot expire in Redis, so staleness is handled on read
   * (below) and the key-level expiry stops an abandoned resource from
   * living forever.
   */
  async heartbeat(
    resourceType: string,
    resourceId: string,
    participant: {
      readonly userId: string;
      readonly name: string;
      readonly role: string;
    },
  ): Promise<readonly EditingParticipant[]> {
    const client = this.redisService.getClient();
    const key = presenceKey(resourceType, resourceId);
    const now = new Date().toISOString();

    try {
      const existingRaw = await client.hget(key, participant.userId);
      // Preserve the original start time across heartbeats — "editing since
      // 14:02" is useful, "editing since 3 seconds ago" forever is not.
      const startedAt = existingRaw
        ? (JSON.parse(existingRaw) as StoredParticipant).startedAt
        : now;

      const stored: StoredParticipant = {
        name: participant.name,
        role: participant.role,
        startedAt,
        lastSeenAt: now,
      };

      await client
        .multi()
        .hset(key, participant.userId, JSON.stringify(stored))
        .expire(key, EDITING_SESSION_TTL_SECONDS)
        .exec();

      const all = await this.readParticipants(key);
      return all.filter((p) => p.userId !== participant.userId);
    } catch (error) {
      // Presence is advisory. If Redis is unavailable the editor must keep
      // working — degraded coordination is an inconvenience, a blocked save
      // is an outage. The version check still protects the data.
      this.logger.warn({ err: error, resourceType }, 'Editing presence unavailable');
      return [];
    }
  }

  /** Everyone currently editing, excluding `excludeUserId` when given. */
  async list(
    resourceType: string,
    resourceId: string,
    excludeUserId?: string,
  ): Promise<readonly EditingParticipant[]> {
    try {
      const all = await this.readParticipants(presenceKey(resourceType, resourceId));
      return excludeUserId ? all.filter((p) => p.userId !== excludeUserId) : all;
    } catch (error) {
      this.logger.warn({ err: error, resourceType }, 'Editing presence unavailable');
      return [];
    }
  }

  /**
   * Ends this user's session immediately.
   *
   * Best-effort: called when an editor is closed deliberately, so a
   * colleague sees the change at once instead of waiting out the TTL.
   * Never required for correctness — the TTL covers every case where this
   * call never happens, which is most of them.
   */
  async release(resourceType: string, resourceId: string, userId: string): Promise<void> {
    try {
      await this.redisService
        .getClient()
        .hdel(presenceKey(resourceType, resourceId), userId);
    } catch (error) {
      this.logger.warn({ err: error, resourceType }, 'Editing presence release failed');
    }
  }

  /**
   * Reads the hash, dropping anyone whose heartbeat has aged out.
   *
   * The filter matters because hash fields do not expire individually: a
   * resource someone is still actively editing keeps the key alive, and
   * without this a colleague who left an hour ago would be listed as
   * present for as long as anyone else keeps editing.
   */
  private async readParticipants(key: string): Promise<readonly EditingParticipant[]> {
    const raw = await this.redisService.getClient().hgetall(key);
    const cutoff = Date.now() - EDITING_SESSION_TTL_SECONDS * 1000;

    return Object.entries(raw ?? {}).flatMap(([userId, value]) => {
      try {
        const stored = JSON.parse(value) as StoredParticipant;
        if (new Date(stored.lastSeenAt).getTime() < cutoff) return [];
        return [{ userId, ...stored }];
      } catch {
        // A malformed field is not worth failing a presence read over.
        return [];
      }
    });
  }
}
