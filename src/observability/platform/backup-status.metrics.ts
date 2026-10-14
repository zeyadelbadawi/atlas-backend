/**
 * B0-OPS-06 — backup freshness as Prometheus gauges.
 *
 * `deploy/backup.sh` (systemd timer, on the host) writes a small status
 * file only after a backup has been dumped, verified, uploaded and pruned:
 *
 *   timestamp=1760320800
 *   size_bytes=17203344
 *   file=atlas-20261013T030000Z.sql.gz
 *
 * The backend container mounts that directory read-only and reads the file
 * at scrape time. `AtlasBackupStale` fires when the last success is older
 * than 26 hours; `AtlasBackupStatusMissing` when there is no status at all.
 * Before this, a failing backup was silent until the next gated migration.
 *
 * A missing or unreadable file exposes NO sample (never a fake zero), which
 * is exactly what the `absent()` rule looks for.
 */
import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gauge } from '../metrics/learning-metrics.service';

/**
 * Labelled on purpose: prom-client renders a label-less gauge as `0` even
 * after `reset()`, which would turn "no status" into "last backup in 1970"
 * and keep `absent()` from ever firing. A labelled gauge with no value
 * renders no sample at all.
 */
const LABELS = { target: 'database' } as const;

export const DEFAULT_BACKUP_STATUS_FILE = '/var/lib/atlas/backup-status/last-success';

export interface BackupStatus {
  readonly timestampSeconds: number;
  readonly sizeBytes: number | null;
}

/** Parses the status file; `null` when it is missing a valid timestamp. */
export function parseBackupStatus(text: string): BackupStatus | null {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const timestamp = Number(fields.get('timestamp'));
  if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
  const size = Number(fields.get('size_bytes'));
  return {
    timestampSeconds: timestamp,
    sizeBytes: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

export async function readBackupStatus(path: string): Promise<BackupStatus | null> {
  try {
    return parseBackupStatus(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

@Injectable()
export class BackupStatusMetrics {
  readonly statusFile: string;

  constructor(configService: ConfigService) {
    this.statusFile =
      configService.get<string>('BACKUP_STATUS_FILE') || DEFAULT_BACKUP_STATUS_FILE;
    const lastSuccess = gauge(
      'atlas_backup_last_success_timestamp_seconds',
      'Unix time of the last fully successful database backup (dumped, verified, uploaded).',
      ['target'],
    );
    const lastSize = gauge(
      'atlas_backup_last_size_bytes',
      'Compressed size of the last successful database backup, in bytes.',
      ['target'],
    );
    const bind = (
      target: ReturnType<typeof gauge>,
      fill: (status: BackupStatus) => void,
    ): void => {
      (target as unknown as { collect?: () => Promise<void> }).collect = async () => {
        const status = await readBackupStatus(this.statusFile);
        target.reset();
        if (status) fill(status);
      };
    };
    bind(lastSuccess, (status) => lastSuccess.set(LABELS, status.timestampSeconds));
    bind(lastSize, (status) => {
      if (status.sizeBytes !== null) lastSize.set(LABELS, status.sizeBytes);
    });
  }
}
