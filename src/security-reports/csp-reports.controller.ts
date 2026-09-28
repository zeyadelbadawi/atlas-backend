/**
 * `POST /api/v1/security/csp-reports` — where browsers send Content-Security-
 * Policy violation reports (authentication audit, Decision 4).
 *
 * Unauthenticated by nature (the browser sends it, with no credentials) and
 * therefore treated as hostile input: parsed by the global JSON parser
 * (which `main.ts` also lets read the two report media types), rate-limited
 * by the global per-IP throttler, at most `MAX_REPORTS_PER_REQUEST` taken, normalised by `parseCspReports` (no URL query, fragment or free
 * text survives), logged at warn level and counted. It always answers 204 —
 * a reporter learns nothing, and a malformed report is simply dropped.
 */
import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { parseCspReports } from './csp-report.util';
import { recordCspViolation } from '../observability/metrics/csp-metrics';

@Controller('security/csp-reports')
export class CspReportsController {
  private readonly logger = new Logger(CspReportsController.name);

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(@Body() body: unknown): void {
    for (const violation of parseCspReports(body)) {
      recordCspViolation(violation);
      this.logger.warn({ csp: violation }, 'Content-Security-Policy violation reported.');
    }
  }
}
