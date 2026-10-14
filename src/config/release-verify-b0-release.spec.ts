/**
 * B0 release plan — `deploy/release-verify/remote.sh b0` proves after the
 * deploy that the five migrations of atlas-backend#46 are applied and that
 * their tables carry forced RLS with exactly the expected policies, and it
 * stays quiet (INFO, no failure) before the release is deployed. The real
 * script runs against a fixture `.env` with a stubbed `docker` that answers
 * each catalog query from the query text.
 */
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../deploy/release-verify/remote.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-verify-b0-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  /** Answer for each migration-state query, in order. */
  readonly migrations: string[];
  readonly rls?: string;
  readonly deletePolicies?: string;
}

function run(scenario: Scenario) {
  writeFileSync(join(dir, '.env'), 'POSTGRES_USER=atlas\nPOSTGRES_DB=atlas\n');
  writeFileSync(join(dir, 'migrations.txt'), `${scenario.migrations.join('\n')}\n`);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    [
      '#!/usr/bin/env bash',
      'q="$*"',
      'case "$q" in',
      `  *_prisma_migrations*) head -1 "${join(dir, 'migrations.txt')}"; sed -i 1d "${join(dir, 'migrations.txt')}" ;;`,
      `  *relrowsecurity*) echo '${scenario.rls ?? 'true,true'}' ;;`,
      `  *"cmd in ('DELETE','ALL')"*) echo '${scenario.deletePolicies ?? '0'}' ;;`,
      '  *policyname=*_insert*) echo INSERT ;;',
      '  *policyname=*_update*) echo UPDATE ;;',
      '  *policyname=*_select*) echo SELECT ;;',
      '  *pg_constraint*) echo 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(docker, 0o755);
  const result = spawnSync('bash', [SCRIPT, 'b0'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RELEASE_VERIFY_DIR: dir,
    },
  });
  return { out: result.stdout, status: result.status };
}

const ALL = Array(5).fill('applied') as string[];

describe('Release verify — B0 release migrations', () => {
  it('before the deploy: INFO, nothing fails', () => {
    const { out, status } = run({ migrations: Array(5).fill('absent') as string[] });
    expect(out).toContain(
      'INFO  B0 release not deployed yet: 0 of 5 migrations recorded',
    );
    expect(out).not.toContain('FAIL');
    expect(status).toBe(0);
  });

  it('after the deploy: every migration, forced RLS and the expected policies pass', () => {
    const { out, status } = run({ migrations: ALL });
    expect(out).toContain('PASS  all 5 B0 release migrations applied');
    for (const table of [
      'privacy_requests',
      'live_provider_events',
      'organization_platform_flags',
    ]) {
      expect(out).toContain(`PASS  ${table} RLS enabled and forced`);
    }
    expect(out).toContain(
      'PASS  policy privacy_requests_self_insert on privacy_requests is INSERT',
    );
    expect(out).toContain('PASS  no DELETE (or ALL) policy on the three B0 tables');
    expect(out).not.toContain('FAIL');
    expect(status).toBe(0);
  });

  it('a half-applied release fails', () => {
    const { out, status } = run({
      migrations: ['applied', 'applied', 'absent', 'absent', 'absent'],
    });
    expect(out).toContain('FAIL  B0 release half-applied: 2 of 5 migrations recorded');
    expect(status).not.toBe(0);
  });

  it('an unreadable database fails instead of reading as "not deployed"', () => {
    const { out, status } = run({ migrations: ['', '', '', '', ''] });
    expect(out).toContain('migration state could not be read');
    expect(out).not.toContain('not deployed yet');
    expect(status).not.toBe(0);
  });

  it('RLS not forced, or a DELETE policy, fails', () => {
    const notForced = run({ migrations: ALL, rls: 'true,false' });
    expect(notForced.out).toContain("FAIL  privacy_requests RLS state 'true,false'");
    expect(notForced.status).not.toBe(0);
    const withDelete = run({ migrations: ALL, deletePolicies: '1' });
    expect(withDelete.out).toContain('FAIL  1 DELETE/ALL policies on the B0 tables');
    expect(withDelete.status).not.toBe(0);
  });
});
