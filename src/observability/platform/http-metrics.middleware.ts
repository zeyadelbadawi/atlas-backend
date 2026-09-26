/**
 * Real HTTP request metrics for the Observability Center (API request rate,
 * 4xx/5xx error rate, latency percentiles). Recorded on the response's
 * `finish`, so requests refused by guards (401/403), validation (400) and
 * unmatched routes (404) are counted too — an interceptor would miss them.
 *
 * `route` is the Express route TEMPLATE (`/api/v1/courses/:id`), never the
 * concrete URL, so ids and query strings can never become label values
 * (bounded cardinality, and no identifiers leak into metrics).
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { counter, histogram } from '../metrics/learning-metrics.service';

const requests = counter(
  'atlas_http_requests_total',
  'HTTP requests handled, by method, route template and status class.',
  ['method', 'route', 'status_class'],
);

const duration = histogram(
  'atlas_http_request_duration_seconds',
  'HTTP request duration in seconds, by method and route template.',
  ['method', 'route'],
  [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    response.on('finish', () => {
      try {
        const template = (request.route as { path?: string } | undefined)?.path;
        const route = template ? `${request.baseUrl ?? ''}${template}` : 'unmatched';
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        requests.inc({
          method: request.method,
          route,
          status_class: `${Math.floor(response.statusCode / 100)}xx`,
        });
        duration.observe({ method: request.method, route }, seconds);
      } catch {
        // A metrics failure must never affect the request it describes.
      }
    });
    next();
  }
}
