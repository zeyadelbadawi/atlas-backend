import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { METRICS_REGISTRY as registry } from '../metrics/learning-metrics.service';
import {
  BackupStatusMetrics,
  parseBackupStatus,
  readBackupStatus,
} from './backup-status.metrics';

describe('backup status metrics (B0-OPS-06)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-backup-status-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses the file backup.sh writes', () => {
    expect(
      parseBackupStatus(
        'timestamp=1760320800\nsize_bytes=17203344\nfile=atlas-20261013T030000Z.sql.gz\n',
      ),
    ).toEqual({ timestampSeconds: 1760320800, sizeBytes: 17203344 });
  });

  it('refuses a file without a valid timestamp (no fake zero)', () => {
    expect(parseBackupStatus('')).toBeNull();
    expect(parseBackupStatus('timestamp=\nsize_bytes=10\n')).toBeNull();
    expect(parseBackupStatus('timestamp=yesterday\n')).toBeNull();
    expect(parseBackupStatus('timestamp=-5\n')).toBeNull();
  });

  it('keeps the timestamp when the size is unreadable', () => {
    expect(parseBackupStatus('timestamp=1760320800\nsize_bytes=lots\n')).toEqual({
      timestampSeconds: 1760320800,
      sizeBytes: null,
    });
  });

  it('reads nothing from a missing file', async () => {
    await expect(readBackupStatus(join(dir, 'missing'))).resolves.toBeNull();
  });

  it('exposes the last success at scrape time, and no sample when the file is gone', async () => {
    const file = join(dir, 'last-success');
    new BackupStatusMetrics({
      get: () => file,
    } as unknown as ConfigService);

    writeFileSync(file, 'timestamp=1760320800\nsize_bytes=2048\nfile=x.sql.gz\n');
    let text = await registry.metrics();
    expect(text).toMatch(
      /^atlas_backup_last_success_timestamp_seconds\{target="database"\} 1760320800$/m,
    );
    expect(text).toMatch(/^atlas_backup_last_size_bytes\{target="database"\} 2048$/m);

    rmSync(file);
    text = await registry.metrics();
    expect(text).not.toMatch(/^atlas_backup_last_success_timestamp_seconds[{ ]/m);
    expect(text).not.toMatch(/^atlas_backup_last_size_bytes[{ ]/m);
  });
});
