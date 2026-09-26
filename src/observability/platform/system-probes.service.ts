/**
 * Live dependency probes — database, Redis and every BullMQ queue — shared
 * by the System Health page (on demand) and `/metrics` (scrape-time gauges),
 * so Prometheus history and the live page read the SAME measurement.
 *
 * Probes are cached for a few seconds so a scrape and a page load arriving
 * together cost one round-trip each, not two.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { gauge } from '../metrics/learning-metrics.service';
import { CERTIFICATE_JOBS_QUEUE } from '../../certificates/queue/certificate-jobs.types';
import { PASSWORD_RESET_EMAIL_QUEUE } from '../../identity/queue/password-reset-email.types';
import { TENANT_USAGE_RECOMPUTE_QUEUE } from '../../plans/queue/tenant-usage-recompute.types';
import { SUBSCRIPTION_SWEEP_QUEUE } from '../../plans/queue/subscription-sweep.types';
import { ANNOUNCEMENT_FANOUT_QUEUE } from '../../community/queue/announcement-fanout.types';
import { COMMUNICATIONS_QUEUE } from '../../communications/queue/communications.types';
import { LIVE_SESSION_SWEEP_QUEUE } from '../../live-sessions/queue/live-session-sweep.types';
import { LIVE_PROVIDER_EVENT_QUEUE } from '../../live-sessions/queue/live-provider-event.types';
import { VIDEO_RETENTION_QUEUE } from '../../retention/queue/video-retention.types';
import { MEDIA_PROCESSING_QUEUE } from '../../media/queue/media-processing.types';
import { PAYMENT_WEBHOOK_QUEUE } from '../../billing/queue/payment-webhook.types';
import { PROVISIONING_QUEUE } from '../../provisioning/queue/provisioning.types';
import { QUIZ_DEADLINE_QUEUE } from '../../learning/queue/quiz-deadline.types';
import { DOMAIN_VERIFICATION_SWEEP_QUEUE } from '../../domain/queue/domain-verification-sweep.types';
import { PHASE2_MAINTENANCE_QUEUE } from '../../learning/queue/phase2-maintenance.types';

export const OBSERVED_QUEUES: readonly string[] = [
  COMMUNICATIONS_QUEUE,
  CERTIFICATE_JOBS_QUEUE,
  PASSWORD_RESET_EMAIL_QUEUE,
  TENANT_USAGE_RECOMPUTE_QUEUE,
  SUBSCRIPTION_SWEEP_QUEUE,
  ANNOUNCEMENT_FANOUT_QUEUE,
  LIVE_SESSION_SWEEP_QUEUE,
  LIVE_PROVIDER_EVENT_QUEUE,
  VIDEO_RETENTION_QUEUE,
  MEDIA_PROCESSING_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
  PROVISIONING_QUEUE,
  QUIZ_DEADLINE_QUEUE,
  DOMAIN_VERIFICATION_SWEEP_QUEUE,
  PHASE2_MAINTENANCE_QUEUE,
];

export interface DependencyProbe {
  readonly up: boolean;
  readonly latencyMs: number | null;
}

export interface QueueProbe {
  readonly name: string;
  readonly reachable: boolean;
  readonly waiting: number;
  readonly active: number;
  readonly failed: number;
  readonly delayed: number;
  readonly oldestWaitingSeconds: number | null;
}

export interface ProbeSnapshot {
  readonly checkedAt: Date;
  readonly database: DependencyProbe;
  readonly redis: DependencyProbe & {
    readonly usedMemoryBytes: number | null;
    readonly connectedClients: number | null;
  };
  readonly queues: readonly QueueProbe[];
}

const CACHE_MS = 5_000;

@Injectable()
export class SystemProbesService {
  private readonly logger = new Logger(SystemProbesService.name);
  private cached: { readonly at: number; readonly value: Promise<ProbeSnapshot> } | null =
    null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.registerGauges();
  }

  snapshot(): Promise<ProbeSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    const value = this.probe().catch((error: unknown) => {
      this.cached = null;
      throw error;
    });
    this.cached = { at: now, value };
    return value;
  }

  private async probe(): Promise<ProbeSnapshot> {
    const [database, redis, queues] = await Promise.all([
      this.probeDatabase(),
      this.probeRedis(),
      Promise.all(OBSERVED_QUEUES.map((name) => this.probeQueue(name))),
    ]);
    return { checkedAt: new Date(), database, redis, queues };
  }

  private async probeDatabase(): Promise<DependencyProbe> {
    const started = performance.now();
    try {
      // No tenant table is touched: a round-trip, not a read of anyone's data.
      await this.prisma.$queryRaw`SELECT 1`;
      return { up: true, latencyMs: round(performance.now() - started) };
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, 'Database probe failed.');
      return { up: false, latencyMs: null };
    }
  }

  private async probeRedis(): Promise<ProbeSnapshot['redis']> {
    const client = this.redis.getClient();
    const started = performance.now();
    try {
      await client.ping();
      const latencyMs = round(performance.now() - started);
      const info = await client.info();
      return {
        up: true,
        latencyMs,
        usedMemoryBytes: infoNumber(info, 'used_memory'),
        connectedClients: infoNumber(info, 'connected_clients'),
      };
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, 'Redis probe failed.');
      return {
        up: false,
        latencyMs: null,
        usedMemoryBytes: null,
        connectedClients: null,
      };
    }
  }

  private async probeQueue(name: string): Promise<QueueProbe> {
    try {
      const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
      const counts = await queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
      const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
      return {
        name,
        reachable: true,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        oldestWaitingSeconds: oldest
          ? Math.max(0, (Date.now() - oldest.timestamp) / 1000)
          : null,
      };
    } catch (error) {
      this.logger.warn(
        { queue: name, error: errorMessage(error) },
        'Queue probe failed.',
      );
      return {
        name,
        reachable: false,
        waiting: 0,
        active: 0,
        failed: 0,
        delayed: 0,
        oldestWaitingSeconds: null,
      };
    }
  }

  /**
   * Scrape-time gauges. Each `collect` reads the (cached) snapshot, so what
   * Prometheus stores is exactly what the health page shows.
   */
  private registerGauges(): void {
    const up = gauge('atlas_dependency_up', '1 when the dependency answered its probe.', [
      'dependency',
    ]);
    const latency = gauge(
      'atlas_dependency_latency_seconds',
      'Round-trip of the dependency probe, in seconds.',
      ['dependency'],
    );
    const queueJobs = gauge('atlas_queue_jobs', 'BullMQ jobs by queue and state.', [
      'queue',
      'state',
    ]);
    const oldestWaiting = gauge(
      'atlas_queue_oldest_waiting_seconds',
      'Age of the oldest waiting job per queue (0 when none are waiting).',
      ['queue'],
    );
    const redisMemory = gauge('atlas_redis_used_memory_bytes', 'Redis used_memory.', []);
    const redisClients = gauge(
      'atlas_redis_connected_clients',
      'Redis connected_clients.',
      [],
    );

    // Each gauge collects from the SAME cached snapshot. prom-client may
    // read metrics concurrently, so no gauge may rely on another's collector.
    const bind = (
      target: ReturnType<typeof gauge>,
      fill: (snapshot: ProbeSnapshot) => void,
    ): void => {
      (target as unknown as { collect?: () => Promise<void> }).collect = async () => {
        const snapshot = await this.snapshot().catch(() => null);
        target.reset();
        if (snapshot) fill(snapshot);
      };
    };
    bind(up, (s) => {
      up.set({ dependency: 'database' }, s.database.up ? 1 : 0);
      up.set({ dependency: 'redis' }, s.redis.up ? 1 : 0);
    });
    bind(latency, (s) => {
      if (s.database.latencyMs !== null) {
        latency.set({ dependency: 'database' }, s.database.latencyMs / 1000);
      }
      if (s.redis.latencyMs !== null) {
        latency.set({ dependency: 'redis' }, s.redis.latencyMs / 1000);
      }
    });
    bind(redisMemory, (s) => {
      if (s.redis.usedMemoryBytes !== null) redisMemory.set(s.redis.usedMemoryBytes);
    });
    bind(redisClients, (s) => {
      if (s.redis.connectedClients !== null) redisClients.set(s.redis.connectedClients);
    });
    bind(queueJobs, (s) => {
      for (const q of s.queues) {
        if (!q.reachable) continue;
        for (const state of ['waiting', 'active', 'failed', 'delayed'] as const) {
          queueJobs.set({ queue: q.name, state }, q[state]);
        }
      }
    });
    bind(oldestWaiting, (s) => {
      for (const q of s.queues) {
        if (q.reachable)
          oldestWaiting.set({ queue: q.name }, q.oldestWaitingSeconds ?? 0);
      }
    });
  }
}

function infoNumber(info: string, field: string): number | null {
  const match = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
  return match ? Number(match[1]) : null;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
