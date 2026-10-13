/**
 * B0-OPS-07 — host disk gauges: size and available bytes of the filesystem
 * behind the backups/status mount; no sample when the path is missing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { METRICS_REGISTRY as registry } from '../metrics/learning-metrics.service';
import { HostDiskMetrics, readHostDisk } from './host-disk.metrics';

function metricsFor(statusFile: string | undefined): HostDiskMetrics {
  return new HostDiskMetrics({
    get: () => statusFile,
  } as unknown as ConfigService);
}

async function scrape(): Promise<string> {
  return `${await registry.getSingleMetricAsString('atlas_host_filesystem_size_bytes')}\n${await registry.getSingleMetricAsString('atlas_host_filesystem_avail_bytes')}`;
}

describe('host disk metrics (B0-OPS-07)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-host-disk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures the filesystem of an existing directory', async () => {
    const usage = await readHostDisk(dir);
    expect(usage).not.toBeNull();
    expect(usage!.sizeBytes).toBeGreaterThan(0);
    expect(usage!.availableBytes).toBeGreaterThanOrEqual(0);
    expect(usage!.availableBytes).toBeLessThanOrEqual(usage!.sizeBytes);
  });

  it('returns null for a path that does not exist', async () => {
    await expect(readHostDisk(join(dir, 'missing'))).resolves.toBeNull();
  });

  it('measures the directory holding the backup status file', async () => {
    const metrics = metricsFor(join(dir, 'last-success'));
    expect(metrics.path).toBe(dir);
    const text = await scrape();
    expect(text).toMatch(/atlas_host_filesystem_size_bytes\{mount="atlas"\} [1-9]\d*/);
    expect(text).toMatch(/atlas_host_filesystem_avail_bytes\{mount="atlas"\} \d+/);
  });

  it('exposes no sample when the mount is absent (never the container filesystem)', async () => {
    metricsFor(join(dir, 'missing', 'last-success'));
    const text = await scrape();
    expect(text).not.toContain('{mount="atlas"}');
  });

  it('defaults to the production mount path', () => {
    expect(metricsFor(undefined).path).toBe('/var/lib/atlas/backup-status');
  });
});
