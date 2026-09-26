/**
 * Read-only clients for the internal Prometheus and Alertmanager.
 *
 * SSRF-safe by construction: both base URLs come from the deployment
 * environment (`PROMETHEUS_URL`, `ALERTMANAGER_URL`) — never from a request —
 * and every path is a fixed API path. The browser never talks to either
 * service; the Observability API normalises what they return.
 *
 * Every response is validated (zod). A timeout, a non-2xx answer or a
 * malformed body is reported as `unavailable`, never as data. An unset URL
 * is `not_configured`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const TIMEOUT_MS = 3_000;

export type Sourced<T> =
  | { readonly state: 'ok'; readonly data: T }
  | { readonly state: 'unavailable' | 'not_configured' };

const vectorSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('vector'),
    result: z.array(
      z.object({
        metric: z.record(z.string()),
        value: z.tuple([z.number(), z.string()]),
      }),
    ),
  }),
});

const matrixSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(
      z.object({
        metric: z.record(z.string()),
        values: z.array(z.tuple([z.number(), z.string()])),
      }),
    ),
  }),
});

const ruleAlertSchema = z.object({
  labels: z.record(z.string()),
  annotations: z.record(z.string()).default({}),
  state: z.string(),
  activeAt: z.string().optional(),
  value: z.string().optional(),
});

const rulesSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    groups: z.array(
      z.object({
        name: z.string(),
        rules: z.array(
          z.object({
            type: z.string(),
            name: z.string(),
            query: z.string(),
            duration: z.number().optional(),
            labels: z.record(z.string()).default({}),
            annotations: z.record(z.string()).default({}),
            alerts: z.array(ruleAlertSchema).default([]),
            health: z.string().optional(),
            lastError: z.string().optional(),
            lastEvaluation: z.string().optional(),
            state: z.string().optional(),
          }),
        ),
      }),
    ),
  }),
});

const amAlertsSchema = z.array(
  z.object({
    labels: z.record(z.string()),
    annotations: z.record(z.string()).default({}),
    startsAt: z.string(),
    endsAt: z.string().optional(),
    fingerprint: z.string(),
    status: z.object({ state: z.string() }),
  }),
);

const amStatusSchema = z.object({
  config: z.object({ original: z.string() }),
});

export type PromVector = z.infer<typeof vectorSchema>['data']['result'];
export type PromMatrix = z.infer<typeof matrixSchema>['data']['result'];
export type PromRuleGroups = z.infer<typeof rulesSchema>['data']['groups'];
export type PromRule = PromRuleGroups[number]['rules'][number];
export type AmAlerts = z.infer<typeof amAlertsSchema>;

@Injectable()
export class MonitoringSourcesClient {
  private readonly logger = new Logger(MonitoringSourcesClient.name);

  constructor(private readonly configService: ConfigService) {}

  private get prometheusUrl(): string | undefined {
    return this.configService.get<string>('PROMETHEUS_URL') || undefined;
  }

  private get alertmanagerUrl(): string | undefined {
    return this.configService.get<string>('ALERTMANAGER_URL') || undefined;
  }

  prometheusConfigured(): boolean {
    return this.prometheusUrl !== undefined;
  }

  alertmanagerConfigured(): boolean {
    return this.alertmanagerUrl !== undefined;
  }

  instant(expr: string, at?: Date): Promise<Sourced<PromVector>> {
    const params = new URLSearchParams({ query: expr });
    if (at) params.set('time', String(at.getTime() / 1000));
    return this.prometheus(`/api/v1/query?${params}`, vectorSchema, (b) => b.data.result);
  }

  range(
    expr: string,
    from: Date,
    to: Date,
    stepSeconds: number,
  ): Promise<Sourced<PromMatrix>> {
    const params = new URLSearchParams({
      query: expr,
      start: String(from.getTime() / 1000),
      end: String(to.getTime() / 1000),
      step: String(stepSeconds),
    });
    return this.prometheus(
      `/api/v1/query_range?${params}`,
      matrixSchema,
      (b) => b.data.result,
    );
  }

  rules(): Promise<Sourced<PromRuleGroups>> {
    return this.prometheus('/api/v1/rules?type=alert', rulesSchema, (b) => b.data.groups);
  }

  alerts(): Promise<Sourced<AmAlerts>> {
    return this.alertmanager(
      '/api/v2/alerts?active=true&silenced=true&inhibited=true',
      amAlertsSchema,
      (b) => b,
    );
  }

  /** Alertmanager's own config. Secrets are masked by Alertmanager itself (`<secret>`). */
  status(): Promise<Sourced<{ readonly original: string }>> {
    return this.alertmanager('/api/v2/status', amStatusSchema, (b) => b.config);
  }

  async ready(
    which: 'prometheus' | 'alertmanager',
  ): Promise<Sourced<{ latencyMs: number }>> {
    const base = which === 'prometheus' ? this.prometheusUrl : this.alertmanagerUrl;
    if (!base) return { state: 'not_configured' };
    const started = performance.now();
    try {
      const response = await fetch(`${base}/-/ready`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return { state: 'unavailable' };
      return {
        state: 'ok',
        data: { latencyMs: Math.round(performance.now() - started) },
      };
    } catch {
      return { state: 'unavailable' };
    }
  }

  private prometheus<S extends z.ZodTypeAny, T>(
    path: string,
    schema: S,
    pick: (body: z.infer<S>) => T,
  ): Promise<Sourced<T>> {
    return this.fetchJson(this.prometheusUrl, path, schema, pick);
  }

  private alertmanager<S extends z.ZodTypeAny, T>(
    path: string,
    schema: S,
    pick: (body: z.infer<S>) => T,
  ): Promise<Sourced<T>> {
    return this.fetchJson(this.alertmanagerUrl, path, schema, pick);
  }

  private async fetchJson<S extends z.ZodTypeAny, T>(
    base: string | undefined,
    path: string,
    schema: S,
    pick: (body: z.infer<S>) => T,
  ): Promise<Sourced<T>> {
    if (!base) return { state: 'not_configured' };
    try {
      const response = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn(
          { path: path.split('?')[0], status: response.status },
          'Monitoring source answered non-2xx.',
        );
        return { state: 'unavailable' };
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) {
        this.logger.warn(
          { path: path.split('?')[0] },
          'Monitoring source returned a malformed body.',
        );
        return { state: 'unavailable' };
      }
      return { state: 'ok', data: pick(parsed.data) };
    } catch (error) {
      this.logger.warn(
        {
          path: path.split('?')[0],
          error: error instanceof Error ? error.name : 'error',
        },
        'Monitoring source unreachable.',
      );
      return { state: 'unavailable' };
    }
  }
}
