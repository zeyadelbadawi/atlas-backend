/**
 * Platform Owner Observability Center — the one place that turns live probes,
 * Prometheus and Alertmanager into the frontend-safe contracts in
 * `observability.contract.ts`.
 *
 * HONESTY RULES (enforced here, relied on by the UI):
 *   - a value is only ever reported from a real source;
 *   - an unreachable source is `unavailable`, an unset one `not_configured`,
 *     and neither is ever rendered as a zero or a green badge;
 *   - history is reconstructed from Prometheus' own `ALERTS` series, so it
 *     reaches back exactly as far as Prometheus retention does, and says so;
 *   - affected tenants are only those NAMED by an alert's own labels.
 *
 * Authorization is the controller's (`PlatformOwnerGuard`, re-read from the
 * database per request). Tenant names are resolved in the caller's own
 * platform-owner RLS context, so the database agrees independently.
 */
import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { RedisService } from '../../redis/redis.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PlatformCommunicationsHealthService } from '../../communications/services/platform-communications-health.service';
import { VideoProviderRegistry } from '../../media/video/video-provider.registry';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../../media/storage/media-storage.interface';
import { HOSTED_VIDEO_PROVIDERS } from '../../media/video/hosted-video-providers';
import { Inject } from '@nestjs/common';
import { gauge } from '../metrics/learning-metrics.service';
import { SystemProbesService } from './system-probes.service';
import {
  MonitoringSourcesClient,
  type AmAlerts,
  type PromMatrix,
  type PromRule,
  type PromRuleGroups,
  type Sourced,
} from './monitoring-sources.client';
import { METRIC_CATALOG, RATE_TOKEN, type MetricEntry } from './metric-catalog';
import type {
  AffectedTenant,
  AlertItem,
  AlertRuleDetailResponse,
  AlertRuleInfo,
  AlertSeverity,
  AlertsResponse,
  ComponentDetail,
  ComponentHealth,
  MetricCatalogResponse,
  MetricDefinition,
  MetricRange,
  MetricSeriesResponse,
  MonitoringConfigurationResponse,
  Series,
  SourceState,
  SyntheticAlertState,
  SystemHealthResponse,
  TimelineEvent,
} from './observability.contract';

export const METRIC_RANGES: readonly MetricRange[] = ['1h', '6h', '24h', '7d', '30d'];

const RANGE_SECONDS: Readonly<Record<MetricRange, number>> = {
  '1h': 3_600,
  '6h': 21_600,
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
};

/** ~120-240 points per chart, and a rate window that always spans >= 4 scrapes. */
const STEP_SECONDS: Readonly<Record<MetricRange, number>> = {
  '1h': 30,
  '6h': 120,
  '24h': 300,
  '7d': 1_800,
  '30d': 7_200,
};

/** Prometheus retention (`--storage.tsdb.retention.time=15d` in compose). */
const HISTORY_RETENTION_SECONDS = 15 * 86_400;

const SYNTHETIC_KEY = 'atlas:observability:synthetic-alert';

const syntheticArmed = gauge(
  'atlas_synthetic_alert_armed',
  '1 while a Platform Owner has armed the synthetic end-to-end test alert.',
  [],
);

interface SyntheticRecord {
  readonly armedAt: string;
  readonly expiresAt: string;
  readonly armedBy: string;
}

@Injectable()
export class ObservabilityService {
  constructor(
    private readonly probes: SystemProbesService,
    private readonly sources: MonitoringSourcesClient,
    private readonly tenancyContextService: TenancyContextService,
    private readonly redis: RedisService,
    private readonly auditLogWriter: AuditLogWriterService,
    private readonly communicationsHealth: PlatformCommunicationsHealthService,
    private readonly videoProviders: VideoProviderRegistry,
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly publicStorage: MediaStorageProvider,
    private readonly configService: ConfigService,
  ) {
    // The synthetic gauge reads the shared Redis record at scrape time, so
    // every backend instance reports the same armed state.
    (syntheticArmed as unknown as { collect?: () => Promise<void> }).collect =
      async () => {
        const record = await this.readSynthetic().catch(() => null);
        syntheticArmed.set(record ? 1 : 0);
      };
  }

  // ---------------------------------------------------------------------
  // System health
  // ---------------------------------------------------------------------

  async health(actorUserId: string): Promise<SystemHealthResponse> {
    const [snapshot, promReady, amReady, amAlerts, api, email, video, storage] =
      await Promise.all([
        this.probes.snapshot(),
        this.sources.ready('prometheus'),
        this.sources.ready('alertmanager'),
        this.sources.alerts(),
        this.apiHealth(),
        this.emailHealth(actorUserId),
        this.videoHealth(actorUserId),
        this.storageHealth(),
      ]);
    const checkedAt = snapshot.checkedAt.toISOString();

    const database: ComponentHealth = {
      key: 'database',
      status: snapshot.database.up ? 'healthy' : 'down',
      checkedAt,
      latencyMs: snapshot.database.latencyMs,
      details: [
        { key: 'probeLatencyMs', value: snapshot.database.latencyMs, unit: 'ms' },
      ],
      reason: snapshot.database.up ? null : 'probeFailed',
    };
    const redis: ComponentHealth = {
      key: 'redis',
      status: snapshot.redis.up ? 'healthy' : 'down',
      checkedAt,
      latencyMs: snapshot.redis.latencyMs,
      details: [
        { key: 'probeLatencyMs', value: snapshot.redis.latencyMs, unit: 'ms' },
        { key: 'usedMemoryBytes', value: snapshot.redis.usedMemoryBytes, unit: 'bytes' },
        {
          key: 'connectedClients',
          value: snapshot.redis.connectedClients,
          unit: 'count',
        },
      ],
      reason: snapshot.redis.up ? null : 'probeFailed',
    };

    const reachable = snapshot.queues.filter((q) => q.reachable);
    const sum = (field: 'waiting' | 'active' | 'failed' | 'delayed') =>
      reachable.reduce((total, q) => total + q[field], 0);
    const oldest = reachable.reduce<number | null>(
      (max, q) =>
        q.oldestWaitingSeconds === null
          ? max
          : Math.max(max ?? 0, q.oldestWaitingSeconds),
      null,
    );
    const queuesDown = reachable.length === 0;
    const backlog = oldest !== null && oldest > 900;
    const queues: ComponentHealth = {
      key: 'queues',
      status: queuesDown ? 'down' : backlog ? 'degraded' : 'healthy',
      checkedAt,
      latencyMs: null,
      details: [
        { key: 'waiting', value: queuesDown ? null : sum('waiting'), unit: 'count' },
        { key: 'active', value: queuesDown ? null : sum('active'), unit: 'count' },
        { key: 'delayed', value: queuesDown ? null : sum('delayed'), unit: 'count' },
        { key: 'failed', value: queuesDown ? null : sum('failed'), unit: 'count' },
        { key: 'oldestWaitingSeconds', value: oldest, unit: 'seconds' },
      ],
      reason: queuesDown ? 'probeFailed' : backlog ? 'backlog' : null,
    };

    const monitoringComponent = (
      key: 'prometheus' | 'alertmanager',
      ready: Sourced<{ latencyMs: number }>,
    ): ComponentHealth => ({
      key,
      status:
        ready.state === 'ok'
          ? 'healthy'
          : ready.state === 'not_configured'
            ? 'not_configured'
            : 'down',
      checkedAt: new Date().toISOString(),
      latencyMs: ready.state === 'ok' ? ready.data.latencyMs : null,
      details: [],
      reason:
        ready.state === 'ok'
          ? null
          : ready.state === 'not_configured'
            ? 'notConfigured'
            : 'probeFailed',
    });

    const components: ComponentHealth[] = [
      { ...api, checkedAt },
      database,
      redis,
      queues,
      email,
      video,
      storage,
      monitoringComponent('prometheus', promReady),
      monitoringComponent('alertmanager', amReady),
    ];

    const critical = components.some(
      (c) => ['api', 'database', 'redis'].includes(c.key) && c.status === 'down',
    );
    const degraded = components.some(
      (c) => c.status === 'down' || c.status === 'degraded',
    );

    const firing =
      amAlerts.state === 'ok'
        ? amAlerts.data.filter((a) => a.status.state === 'active')
        : [];
    const count = (severity: string) =>
      firing.filter((a) => a.labels.severity === severity).length;

    return {
      generatedAt: new Date().toISOString(),
      overall: critical ? 'outage' : degraded ? 'degraded' : 'operational',
      alerts: {
        source: amAlerts.state,
        active: firing.length,
        critical: count('critical'),
        warning: count('warning'),
        info: count('info'),
      },
      components,
    };
  }

  private async apiHealth(): Promise<Omit<ComponentHealth, 'checkedAt'>> {
    const details: ComponentDetail[] = [
      { key: 'uptimeSeconds', value: Math.round(process.uptime()), unit: 'seconds' },
    ];
    const [rate, errors, p95] = await Promise.all([
      this.scalar('sum(rate(atlas_http_requests_total[5m]))'),
      this.scalar(
        'sum(rate(atlas_http_requests_total{status_class="5xx"}[5m])) / clamp_min(sum(rate(atlas_http_requests_total[5m])), 1e-9)',
      ),
      this.scalar(
        'histogram_quantile(0.95, sum by (le) (rate(atlas_http_request_duration_seconds_bucket[5m])))',
      ),
    ]);
    details.push(
      { key: 'requestRate', value: rate, unit: 'count' },
      { key: 'errorRate5xx', value: errors, unit: 'percent' },
      {
        key: 'latencyP95Ms',
        value: p95 === null ? null : Math.round(p95 * 1000),
        unit: 'ms',
      },
    );
    // The API is answering this very request, so it is up; whether it is
    // HEALTHY needs Prometheus' window, and is `unknown` without it.
    const highErrors = errors !== null && errors > 0.05;
    const slow = p95 !== null && p95 > 2;
    return {
      key: 'api',
      status: rate === null ? 'unknown' : highErrors || slow ? 'degraded' : 'healthy',
      latencyMs: null,
      details,
      reason:
        rate === null
          ? 'sourceUnavailable'
          : highErrors
            ? 'highErrorRate'
            : slow
              ? 'highLatency'
              : null,
    };
  }

  private async emailHealth(actorUserId: string): Promise<ComponentHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const health = await this.communicationsHealth.getHealth(actorUserId, 1);
      const oldest = health.outbox.oldestPendingSeconds;
      const failure = health.deliveries.failureRatio;
      const stalled = oldest !== null && oldest > 600;
      const failing = failure > 0.2;
      return {
        key: 'email',
        status: stalled || failing ? 'degraded' : 'healthy',
        checkedAt,
        latencyMs: null,
        details: [
          { key: 'outboxOldestPendingSeconds', value: oldest, unit: 'seconds' },
          { key: 'deliveryFailureRatio', value: failure, unit: 'percent' },
        ],
        reason: stalled ? 'stalled' : failing ? 'deliveryFailures' : null,
      };
    } catch {
      return {
        key: 'email',
        status: 'unknown',
        checkedAt,
        latencyMs: null,
        details: [],
        reason: 'probeFailed',
      };
    }
  }

  private async videoHealth(actorUserId: string): Promise<ComponentHealth> {
    const checkedAt = new Date().toISOString();
    const normal = this.videoProviders.isTierAvailable('normal');
    const premium = this.videoProviders.isTierAvailable('premium');
    const details: ComponentDetail[] = [
      { key: 'providerNormalConfigured', value: normal ? 'yes' : 'no', unit: 'text' },
      { key: 'providerStreamConfigured', value: premium ? 'yes' : 'no', unit: 'text' },
    ];
    if (!normal && !premium) {
      return {
        key: 'video',
        status: 'not_configured',
        checkedAt,
        latencyMs: null,
        details,
        reason: 'notConfigured',
      };
    }
    const stalled = await this.tenancyContextService
      .runInUserContext(actorUserId, (tx) =>
        tx.mediaAsset.count({
          where: {
            provider: { in: [...HOSTED_VIDEO_PROVIDERS] },
            processingStatus: { in: ['pending', 'processing'] },
            updatedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
          },
        }),
      )
      .catch(() => null);
    details.push({ key: 'stalledProcessing', value: stalled, unit: 'count' });
    return {
      key: 'video',
      status: stalled === null ? 'unknown' : stalled > 0 ? 'degraded' : 'healthy',
      checkedAt,
      latencyMs: null,
      details,
      reason: stalled === null ? 'probeFailed' : stalled > 0 ? 'stalled' : null,
    };
  }

  private async storageHealth(): Promise<ComponentHealth> {
    const checkedAt = new Date().toISOString();
    const started = performance.now();
    try {
      // A HEAD for a key that never exists: proves the bucket answers,
      // touches no customer object.
      await this.publicStorage.objectExists('__atlas_health_probe__');
      const latencyMs = Math.round(performance.now() - started);
      return {
        key: 'storage',
        status: 'healthy',
        checkedAt,
        latencyMs,
        details: [{ key: 'publicBucketReachable', value: 'yes', unit: 'text' }],
        reason: null,
      };
    } catch {
      return {
        key: 'storage',
        status: 'down',
        checkedAt,
        latencyMs: null,
        details: [{ key: 'publicBucketReachable', value: 'no', unit: 'text' }],
        reason: 'probeFailed',
      };
    }
  }

  // ---------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------

  async alerts(
    actorUserId: string,
    filter: {
      readonly status: 'all' | 'active' | 'resolved';
      readonly severity?: AlertSeverity;
      readonly rule?: string;
      readonly range: MetricRange;
    },
  ): Promise<AlertsResponse> {
    const now = new Date();
    const { from, historyFrom } = this.historyWindow(filter.range, now);
    const [am, rules, history] = await Promise.all([
      this.sources.alerts(),
      this.sources.rules(),
      this.sources.range('ALERTS', from, now, STEP_SECONDS[filter.range]),
    ]);

    let items = this.buildAlertItems(am, rules, history, STEP_SECONDS[filter.range], now);
    if (filter.status === 'active') items = items.filter((i) => i.status !== 'resolved');
    if (filter.status === 'resolved')
      items = items.filter((i) => i.status === 'resolved');
    if (filter.severity) items = items.filter((i) => i.severity === filter.severity);
    if (filter.rule) items = items.filter((i) => i.rule === filter.rule);
    items = await this.withTenants(actorUserId, items);

    return {
      generatedAt: now.toISOString(),
      sources: {
        alertmanager: am.state,
        prometheus: worst(rules.state, history.state),
      },
      historyFrom: historyFrom.toISOString(),
      items,
    };
  }

  async ruleDetail(
    actorUserId: string,
    ruleName: string,
    range: MetricRange,
  ): Promise<AlertRuleDetailResponse> {
    const now = new Date();
    const rules = await this.sources.rules();
    if (rules.state !== 'ok') {
      throw new ServiceUnavailableException({
        messageKey: 'errors.observability.sourceUnavailable',
      });
    }
    const found = findRule(rules.data, ruleName);
    if (!found) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const { from } = this.historyWindow(range, now);
    const step = STEP_SECONDS[range];
    const [am, history, current, series, lastWindow] = await Promise.all([
      this.sources.alerts(),
      this.sources.range(`ALERTS{alertname="${ruleName}"}`, from, now, step),
      this.sources.instant(found.rule.query),
      this.sources.range(found.rule.query, from, now, step),
      this.lastTriggerWindow(ruleName, now),
    ]);

    let instances = this.buildAlertItems(am, rules, history, step, now).filter(
      (i) => i.rule === ruleName,
    );
    instances = await this.withTenants(actorUserId, instances);

    const timeline: TimelineEvent[] = [];
    for (const instance of instances) {
      timeline.push({
        at: instance.startsAt,
        kind: instance.status === 'pending' ? 'pending' : 'triggered',
        alertId: instance.id,
      });
      if (instance.endsAt)
        timeline.push({ at: instance.endsAt, kind: 'resolved', alertId: instance.id });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    return {
      generatedAt: now.toISOString(),
      sources: { alertmanager: am.state, prometheus: worst(history.state, series.state) },
      rule: toRuleInfo(found.group, found.rule, lastWindow),
      currentValues:
        current.state === 'ok'
          ? current.data.map((r) => ({
              labels: cleanLabels(r.metric),
              value: toNumber(r.value[1]),
            }))
          : [],
      instances,
      timeline,
      expressionSeries: series.state === 'ok' ? toSeries(series.data) : [],
    };
  }

  private buildAlertItems(
    am: Sourced<AmAlerts>,
    rules: Sourced<PromRuleGroups>,
    history: Sourced<PromMatrix>,
    stepSeconds: number,
    now: Date,
  ): AlertItem[] {
    const annotationsByRule = new Map<string, { group: string; rule: PromRule }>();
    if (rules.state === 'ok') {
      for (const group of rules.data) {
        for (const rule of group.rules)
          annotationsByRule.set(rule.name, { group: group.name, rule });
      }
    }
    const items: AlertItem[] = [];
    const current = new Set<string>();

    // 1. Current: Alertmanager is authoritative for firing/silenced.
    if (am.state === 'ok') {
      for (const alert of am.data) {
        const labels = cleanLabels(alert.labels);
        const key = seriesKey(labels);
        current.add(key);
        const meta = annotationsByRule.get(labels.alertname ?? '');
        items.push(
          this.item(labels, alert.annotations, meta?.group ?? null, {
            status: alert.status.state === 'suppressed' ? 'silenced' : 'firing',
            startsAt: new Date(alert.startsAt),
            endsAt: null,
            now,
          }),
        );
      }
    }
    // 2. Current, from Prometheus: pending always; firing when Alertmanager
    //    is not reachable (so the page still shows what is firing).
    if (rules.state === 'ok') {
      for (const group of rules.data) {
        for (const rule of group.rules) {
          for (const alert of rule.alerts) {
            const labels = cleanLabels({ ...alert.labels, alertname: rule.name });
            const key = seriesKey(labels);
            if (current.has(key)) continue;
            if (
              alert.state === 'pending' ||
              (alert.state === 'firing' && am.state !== 'ok')
            ) {
              current.add(key);
              items.push(
                this.item(labels, alert.annotations, group.name, {
                  status: alert.state === 'pending' ? 'pending' : 'firing',
                  startsAt: alert.activeAt ? new Date(alert.activeAt) : now,
                  endsAt: null,
                  now,
                }),
              );
            }
          }
        }
      }
    }
    // 3. History: resolved firing intervals from Prometheus' own ALERTS series.
    if (history.state === 'ok') {
      for (const series of history.data) {
        if (series.metric.alertstate !== 'firing') continue;
        const labels = cleanLabels(series.metric);
        const key = seriesKey(labels);
        const meta = annotationsByRule.get(labels.alertname ?? '');
        for (const interval of toIntervals(series.values, stepSeconds)) {
          const endedAt = new Date((interval.end + stepSeconds) * 1000);
          const stillOpen = now.getTime() - interval.end * 1000 <= stepSeconds * 2000;
          if (stillOpen && current.has(key)) continue; // represented as current above
          if (stillOpen) continue; // ended between samples: not yet provably resolved
          items.push(
            this.item(labels, meta?.rule.annotations ?? {}, meta?.group ?? null, {
              status: 'resolved',
              startsAt: new Date(interval.start * 1000),
              endsAt: endedAt,
              now,
            }),
          );
        }
      }
    }
    return items.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  }

  private item(
    labels: Record<string, string>,
    annotations: Record<string, string>,
    group: string | null,
    at: { status: AlertItem['status']; startsAt: Date; endsAt: Date | null; now: Date },
  ): AlertItem {
    const rule = labels.alertname ?? 'unknown';
    const endMs = (at.endsAt ?? at.now).getTime();
    return {
      id: `${createHash('sha256').update(seriesKey(labels)).digest('hex').slice(0, 16)}-${at.startsAt.getTime()}`,
      rule,
      severity: toSeverity(labels.severity),
      status: at.status,
      summary: annotations.summary ?? null,
      description: annotations.description ?? null,
      service: labels.service ?? serviceFromGroup(group),
      labels,
      startsAt: at.startsAt.toISOString(),
      endsAt: at.endsAt ? at.endsAt.toISOString() : null,
      durationSeconds: Math.max(0, Math.round((endMs - at.startsAt.getTime()) / 1000)),
      affectedTenants: [],
    };
  }

  /** Names ONLY the tenants an alert's labels name, read in the caller's platform-owner context. */
  private async withTenants(
    actorUserId: string,
    items: AlertItem[],
  ): Promise<AlertItem[]> {
    const orgIds = new Set<string>();
    const academyIds = new Set<string>();
    for (const item of items) {
      const org = item.labels.organization_id ?? item.labels.organizationId;
      const academy = item.labels.academy_id ?? item.labels.academyId;
      if (org && isUuid(org)) orgIds.add(org);
      if (academy && isUuid(academy)) academyIds.add(academy);
    }
    if (orgIds.size === 0 && academyIds.size === 0) return items;
    const names = await this.tenancyContextService.runInUserContext(
      actorUserId,
      async (tx) => {
        const [orgs, academies] = await Promise.all([
          tx.organization.findMany({
            where: { id: { in: [...orgIds] } },
            select: { id: true, name: true },
          }),
          tx.academy.findMany({
            where: { id: { in: [...academyIds] } },
            select: { id: true, name: true, organizationId: true },
          }),
        ]);
        return { orgs, academies };
      },
    );
    return items.map((item) => {
      const org = item.labels.organization_id ?? item.labels.organizationId;
      const academy = item.labels.academy_id ?? item.labels.academyId;
      const tenants: AffectedTenant[] = [];
      if (academy) {
        const found = names.academies.find((a) => a.id === academy);
        tenants.push({
          organizationId: found?.organizationId ?? null,
          academyId: academy,
          name: found?.name ?? null,
        });
      } else if (org) {
        const found = names.orgs.find((o) => o.id === org);
        tenants.push({ organizationId: org, academyId: null, name: found?.name ?? null });
      }
      return { ...item, affectedTenants: tenants };
    });
  }

  private historyWindow(
    range: MetricRange,
    now: Date,
  ): { from: Date; historyFrom: Date } {
    const seconds = Math.min(RANGE_SECONDS[range], HISTORY_RETENTION_SECONDS);
    const from = new Date(now.getTime() - seconds * 1000);
    return { from, historyFrom: from };
  }

  private async lastTriggerWindow(
    ruleName: string,
    now: Date,
  ): Promise<{ lastTriggeredAt: string | null; lastResolvedAt: string | null }> {
    const from = new Date(now.getTime() - HISTORY_RETENTION_SECONDS * 1000);
    const history = await this.sources.range(
      `ALERTS{alertname="${ruleName}",alertstate="firing"}`,
      from,
      now,
      300,
    );
    if (history.state !== 'ok') return { lastTriggeredAt: null, lastResolvedAt: null };
    let lastStart: number | null = null;
    let lastEnd: number | null = null;
    for (const series of history.data) {
      for (const interval of toIntervals(series.values, 300)) {
        if (lastStart === null || interval.start > lastStart) lastStart = interval.start;
        const open = now.getTime() - interval.end * 1000 <= 600_000;
        if (!open && (lastEnd === null || interval.end > lastEnd))
          lastEnd = interval.end + 300;
      }
    }
    return {
      lastTriggeredAt:
        lastStart === null ? null : new Date(lastStart * 1000).toISOString(),
      lastResolvedAt: lastEnd === null ? null : new Date(lastEnd * 1000).toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------

  async metricCatalog(): Promise<MetricCatalogResponse> {
    const present = await this.presentSeries();
    return {
      generatedAt: new Date().toISOString(),
      source: present.state,
      metrics: METRIC_CATALOG.map((entry) => this.definition(entry, present)),
    };
  }

  async metricSeries(
    metricId: string,
    range: MetricRange,
  ): Promise<MetricSeriesResponse> {
    const entry = METRIC_CATALOG.find((m) => m.id === metricId);
    if (!entry) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const now = new Date();
    const from = new Date(now.getTime() - RANGE_SECONDS[range] * 1000);
    const step = STEP_SECONDS[range];
    const rateWindow = `${Math.max(step * 4, 120)}s`;
    const [present, result] = await Promise.all([
      this.presentSeries(),
      this.sources.range(entry.expr.split(RATE_TOKEN).join(rateWindow), from, now, step),
    ]);
    return {
      generatedAt: now.toISOString(),
      source: result.state,
      metric: this.definition(entry, present),
      from: from.toISOString(),
      to: now.toISOString(),
      stepSeconds: step,
      series: result.state === 'ok' ? toSeries(result.data) : [],
    };
  }

  private definition(
    entry: MetricEntry,
    present: Sourced<Set<string>>,
  ): MetricDefinition {
    return {
      id: entry.id,
      domain: entry.domain,
      unit: entry.unit,
      available: present.state === 'ok' && present.data.has(entry.requires),
    };
  }

  private async presentSeries(): Promise<Sourced<Set<string>>> {
    const names = await this.sources.instant(
      'count by (__name__) ({__name__=~"atlas_.+|process_.+|nodejs_.+|alertmanager_notifications.+"})',
    );
    if (names.state !== 'ok') return names;
    return {
      state: 'ok',
      data: new Set(names.data.map((r) => r.metric.__name__).filter(Boolean)),
    };
  }

  // ---------------------------------------------------------------------
  // Configuration + synthetic alert
  // ---------------------------------------------------------------------

  async configuration(): Promise<MonitoringConfigurationResponse> {
    const now = new Date();
    const [rules, status, sent, failed, synthetic] = await Promise.all([
      this.sources.rules(),
      this.sources.status(),
      this.scalarSourced(
        'sum(increase(alertmanager_notifications_total{integration="slack"}[24h]))',
      ),
      this.scalarSourced(
        'sum(increase(alertmanager_notifications_failed_total{integration="slack"}[24h]))',
      ),
      this.syntheticState(),
    ]);
    const ruleInfos: AlertRuleInfo[] = [];
    if (rules.state === 'ok') {
      const windows = await Promise.all(
        rules.data.flatMap((g) =>
          g.rules.map((r) => this.lastTriggerWindow(r.name, now)),
        ),
      );
      let i = 0;
      for (const group of rules.data) {
        for (const rule of group.rules)
          ruleInfos.push(toRuleInfo(group.name, rule, windows[i++]));
      }
    }
    return {
      generatedAt: now.toISOString(),
      sources: { alertmanager: status.state, prometheus: rules.state },
      scrapeAuthentication: this.configService.get<string>('METRICS_SCRAPE_TOKEN')
        ? 'token'
        : 'platform_owner_only',
      rules: ruleInfos,
      channels: [
        {
          kind: 'slack',
          // Alertmanager reports its config with secrets masked; only the
          // PRESENCE of a Slack receiver is read, never a URL.
          configured:
            status.state === 'ok' && /slack_configs:/.test(status.data.original),
          source: status.state,
          sent24h: sent.state === 'ok' ? sent.data : null,
          failed24h: failed.state === 'ok' ? failed.data : null,
        },
      ],
      syntheticAlert: synthetic,
    };
  }

  async armSynthetic(actorUserId: string, minutes: number): Promise<SyntheticAlertState> {
    const now = new Date();
    const record: SyntheticRecord = {
      armedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      armedBy: actorUserId,
    };
    await this.redis
      .getClient()
      .set(SYNTHETIC_KEY, JSON.stringify(record), 'PX', minutes * 60_000);
    await this.audit(actorUserId, 'observability.synthetic_alert.armed', { minutes });
    return this.syntheticState();
  }

  async disarmSynthetic(actorUserId: string): Promise<SyntheticAlertState> {
    const removed = await this.redis.getClient().del(SYNTHETIC_KEY);
    if (removed > 0)
      await this.audit(actorUserId, 'observability.synthetic_alert.resolved', {});
    return this.syntheticState();
  }

  private async syntheticState(): Promise<SyntheticAlertState> {
    const record = await this.readSynthetic().catch(() => null);
    if (!record) return { armed: false, armedAt: null, expiresAt: null, armedBy: null };
    return {
      armed: true,
      armedAt: record.armedAt,
      expiresAt: record.expiresAt,
      armedBy: record.armedBy,
    };
  }

  private async readSynthetic(): Promise<SyntheticRecord | null> {
    const raw = await this.redis.getClient().get(SYNTHETIC_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SyntheticRecord;
    } catch {
      return null;
    }
  }

  private async audit(
    actorUserId: string,
    action: string,
    context: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.auditLogWriter.write(tx, {
        actorUserId,
        role: 'platform_owner',
        action,
        targetType: 'observability',
        targetId: 'synthetic-alert',
        context,
      }),
    );
  }

  // ---------------------------------------------------------------------

  private async scalar(expr: string): Promise<number | null> {
    const result = await this.scalarSourced(expr);
    return result.state === 'ok' ? result.data : null;
  }

  private async scalarSourced(expr: string): Promise<Sourced<number | null>> {
    const result = await this.sources.instant(expr);
    if (result.state !== 'ok') return result;
    const first = result.data[0];
    return { state: 'ok', data: first ? toNumber(first.value[1]) : null };
  }
}

// ---------------------------------------------------------------------------

function findRule(
  groups: PromRuleGroups,
  name: string,
): { group: string; rule: PromRule } | null {
  for (const group of groups) {
    const rule = group.rules.find((r) => r.name === name);
    if (rule) return { group: group.name, rule };
  }
  return null;
}

function toRuleInfo(
  group: string,
  rule: PromRule,
  window: { lastTriggeredAt: string | null; lastResolvedAt: string | null },
): AlertRuleInfo {
  const state =
    rule.state === 'firing' || rule.state === 'pending' ? rule.state : 'inactive';
  return {
    name: rule.name,
    group,
    expression: rule.query,
    forSeconds: rule.duration ?? 0,
    severity: toSeverity(rule.labels.severity),
    service: rule.labels.service ?? serviceFromGroup(group),
    summary: rule.annotations.summary ?? null,
    description: rule.annotations.description ?? null,
    threshold: rule.annotations.threshold ?? null,
    state,
    health: rule.health === 'ok' ? 'ok' : rule.health === 'err' ? 'err' : 'unknown',
    lastError: rule.lastError || null,
    lastEvaluation: rule.lastEvaluation ?? null,
    lastTriggeredAt: window.lastTriggeredAt,
    lastResolvedAt: window.lastResolvedAt,
    editable: false,
  };
}

function toSeries(matrix: PromMatrix): Series[] {
  return matrix.map((s) => ({
    labels: cleanLabels(s.metric),
    points: s.values.map(([t, v]) => ({
      t: new Date(t * 1000).toISOString(),
      v: toNumber(v),
    })),
  }));
}

function toIntervals(
  values: readonly (readonly [number, string])[],
  stepSeconds: number,
): { start: number; end: number }[] {
  const intervals: { start: number; end: number }[] = [];
  for (const [t] of values) {
    const last = intervals[intervals.length - 1];
    if (last && t - last.end <= stepSeconds * 1.5) last.end = t;
    else intervals.push({ start: t, end: t });
  }
  return intervals;
}

function cleanLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === '__name__' || key === 'alertstate') continue;
    out[key] = value;
  }
  return out;
}

function seriesKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function toSeverity(value: string | undefined): AlertSeverity {
  return value === 'critical' || value === 'warning' || value === 'info'
    ? value
    : 'unknown';
}

function serviceFromGroup(group: string | null): string | null {
  if (!group) return null;
  return group.replace(/^atlas-/, '') || null;
}

function toNumber(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function worst(a: SourceState, b: SourceState): SourceState {
  if (a === 'unavailable' || b === 'unavailable') return 'unavailable';
  if (a === 'not_configured' || b === 'not_configured') return 'not_configured';
  return 'ok';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
