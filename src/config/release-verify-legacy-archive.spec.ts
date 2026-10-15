/**
 * OD-18 — `deploy/release-verify/remote.sh archive` reports the legacy
 * academy `archived_at` backfill as counts, before and after migration
 * 20261118000100, and never fails a run (INFO only). The real script runs
 * against a fixture `.env` with a stubbed `docker` that answers each query
 * from its text. (The classification SQL itself is exercised against real
 * Postgres by test/legacy-archived-at-backfill.e2e-spec.ts.)
 */
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../deploy/release-verify/remote.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-verify-archive-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  readonly classification: string;
  readonly migration?: string;
  readonly table?: string;
  readonly backfill?: string;
  readonly env?: string;
}

function run(scenario: Scenario) {
  writeFileSync(
    join(dir, '.env'),
    `POSTGRES_USER=atlas\nPOSTGRES_DB=atlas\n${scenario.env ?? ''}`,
  );
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    [
      '#!/usr/bin/env bash',
      'q="$*"',
      'case "$q" in',
      `  *"'legacyarchive'"*) echo '${scenario.classification}' ;;`,
      `  *_prisma_migrations*) echo '${scenario.migration ?? 'absent'}' ;;`,
      `  *to_regclass*) echo '${scenario.table ?? 'f'}' ;;`,
      `  *"'legacybackfill'"*) echo '${scenario.backfill ?? ''}' ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(docker, 0o755);
  const result = spawnSync('bash', [SCRIPT, 'archive'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RELEASE_VERIFY_DIR: dir,
    },
  });
  return { out: result.stdout, status: result.status };
}

const BEFORE = 'legacyarchive|3|2|1|1|2|1|5|1|4|0|7|1';

describe('Release verify — legacy academy archived_at backfill (OD-18)', () => {
  it('before the migration: the classification as counts, INFO only', () => {
    const { out, status } = run({ classification: BEFORE });
    expect(out).toContain(
      'INFO  legacy archive: eligible for the backfill=3 (dated by the account.deleted audit row=2, by users.deleted_at=1)',
    );
    expect(out).toContain(
      'INFO  legacy archive: ambiguous, never changed=4 (owner deletion marker partial=1, normal-archive evidence=2, archive write outside the deletion window=1)',
    );
    expect(out).toContain(
      'INFO  legacy archive: archived_at already recorded=5 (owner deleted=1); archived without archived_at under a live owner (out of scope)=4; live academies of deleted owners=0',
    );
    expect(out).toContain(
      'INFO  legacy archive: eligible academies hold media assets (active/archived)=7, a connected custom hostname=1',
    );
    expect(out).toContain(
      'INFO  legacy archive: FLAG_MEDIA_ARCHIVE_PURGE_MODE=dry_run (default)',
    );
    expect(out).toContain(
      'INFO  legacy archive backfill: migration 20261118000100_legacy_academy_archived_at_backfill absent (nothing stamped yet)',
    );
    expect(out).not.toMatch(/^(FAIL|PASS)/m);
    expect(status).toBe(0);
  });

  it('after the migration: what was stamped, when the grace ends, and whether media was purged', () => {
    const { out, status } = run({
      classification: 'legacyarchive|0|0|0|1|2|1|8|4|4|0|0|0',
      migration: 'applied',
      table: 't',
      backfill: 'legacybackfill|3|1|3|2026-12-18|7|0',
      env: 'FLAG_MEDIA_ARCHIVE_PURGE_MODE=on\n',
    });
    expect(out).toContain('INFO  legacy archive: eligible for the backfill=0');
    expect(out).toContain('INFO  legacy archive: FLAG_MEDIA_ARCHIVE_PURGE_MODE=on');
    expect(out).toContain(
      'INFO  legacy archive backfill: migration applied; academies stamped=3 (runs=1, still carrying the stamp=3); media grace ends no earlier than 2026-12-18',
    );
    expect(out).toContain(
      'INFO  legacy archive backfill: media assets of stamped academies present=7, tombstoned=0',
    );
    expect(out).not.toMatch(/^(FAIL|PASS)/m);
    expect(status).toBe(0);
  });

  it('an unreadable database is reported, never as "nothing to do", and still does not gate', () => {
    const { out, status } = run({ classification: '' });
    expect(out).toContain('INFO  legacy archive counts could not be read');
    expect(out).not.toContain('eligible for the backfill');
    expect(out).not.toMatch(/^(FAIL|PASS)/m);
    expect(status).toBe(0);
  });

  it('prints counts and one date only — never an id, name or email', () => {
    const { out } = run({
      classification: BEFORE,
      migration: 'applied',
      table: 't',
      backfill: 'legacybackfill|3|1|3|2026-12-18|7|0',
    });
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(out).not.toMatch(/@/);
  });
});
