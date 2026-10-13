/**
 * B0-OPS-07 — free space on the host filesystem that holds /opt/atlas.
 *
 * On 9 Oct 2026 the VPS disk filled (old images) and deploys failed with
 * nothing alerting first. There is no node exporter, so the backend
 * measures the disk itself: it already mounts a directory of the host's
 * /opt/atlas filesystem read-only (`backups/status`, B0-OPS-06), and
 * `statfs` on a path inside a bind mount reports the HOST filesystem it
 * lives on. Docker's data root is on the same filesystem on a single-disk
 * VPS; a separate Docker volume is NOT covered, as the observability guide
 * says.
 *
 * `AtlasDiskUsageHigh` (> 80 %) and `AtlasDiskUsageCritical` (> 90 %) read
 * these gauges. When the path does not exist (local development, an older
 * compose file) the gauges expose no sample rather than measuring the
 * container's own filesystem.
 */
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gauge } from '../metrics/learning-metrics.service';
import { DEFAULT_BACKUP_STATUS_FILE } from './backup-status.metrics';

/** Labelled so that "not measurable" renders no sample (a label-less gauge renders 0). */
const LABELS = { mount: 'atlas' } as const;

export interface HostDiskUsage {
  readonly sizeBytes: number;
  readonly availableBytes: number;
}

/** `statfs` of `path`, or `null` when it cannot be measured. Never throws. */
export async function readHostDisk(path: string): Promise<HostDiskUsage | null> {
  try {
    const stats = await statfs(path);
    const sizeBytes = Number(stats.blocks) * Number(stats.bsize);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
    return { sizeBytes, availableBytes: Math.max(0, availableBytes) };
  } catch {
    return null;
  }
}

@Injectable()
export class HostDiskMetrics {
  /** A directory on the host's /opt/atlas filesystem, mounted into the container. */
  readonly path: string;

  constructor(configService: ConfigService) {
    this.path = dirname(
      configService.get<string>('BACKUP_STATUS_FILE') || DEFAULT_BACKUP_STATUS_FILE,
    );
    const size = gauge(
      'atlas_host_filesystem_size_bytes',
      'Size of the host filesystem that holds /opt/atlas, in bytes.',
      ['mount'],
    );
    const available = gauge(
      'atlas_host_filesystem_avail_bytes',
      'Bytes available to unprivileged users on the host filesystem that holds /opt/atlas.',
      ['mount'],
    );
    const bind = (
      target: ReturnType<typeof gauge>,
      fill: (usage: HostDiskUsage) => void,
    ): void => {
      (target as unknown as { collect?: () => Promise<void> }).collect = async () => {
        const usage = await readHostDisk(this.path);
        target.reset();
        if (usage) fill(usage);
      };
    };
    bind(size, (usage) => size.set(LABELS, usage.sizeBytes));
    bind(available, (usage) => available.set(LABELS, usage.availableBytes));
  }
}
