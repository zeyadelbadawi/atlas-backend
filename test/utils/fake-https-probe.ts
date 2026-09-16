/** FakeHttpsProbe (P63) — the probe would otherwise dial hostnames nothing serves; tests set what "the visitor experiences" per hostname. */
import type { HttpsProbeResult } from '../../src/domain/services/https-probe.service';

export class FakeHttpsProbe {
  private readonly reachable = new Map<string, boolean>();
  readonly probed: string[] = [];

  reset(): void {
    this.reachable.clear();
    this.probed.length = 0;
  }

  setReachable(hostname: string, value: boolean): void {
    this.reachable.set(hostname, value);
  }

  async probe(hostname: string): Promise<HttpsProbeResult> {
    this.probed.push(hostname);
    return { reachable: this.reachable.get(hostname) ?? true, checkedAt: new Date() };
  }
}
