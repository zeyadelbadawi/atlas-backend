/** FakeHttpsProbe (P63) — the probe would otherwise dial hostnames nothing serves; tests set what "the visitor experiences" per hostname. */
import type { HttpsProbeResult } from '../../src/domain/services/https-probe.service';

export class FakeHttpsProbe {
  private readonly results = new Map<string, HttpsProbeResult>();
  readonly probed: string[] = [];

  reset(): void {
    this.results.clear();
    this.probed.length = 0;
  }

  setReachable(hostname: string, value: boolean): void {
    this.results.set(hostname, {
      reachable: value,
      checkedAt: new Date(),
      ...(value ? { statusCode: 200 } : { failure: 'tls_or_connection_failed' }),
    });
  }

  /** P63d — the edge answered, with this status (a 5xx is what a visitor sees when the origin path is broken). */
  setEdgeStatus(hostname: string, statusCode: number): void {
    this.results.set(hostname, {
      reachable: statusCode < 500,
      checkedAt: new Date(),
      statusCode,
      ...(statusCode < 500 ? {} : { failure: 'origin_error' }),
    });
  }

  async probe(hostname: string): Promise<HttpsProbeResult> {
    this.probed.push(hostname);
    return (
      this.results.get(hostname) ?? {
        reachable: true,
        checkedAt: new Date(),
        statusCode: 200,
      }
    );
  }
}
