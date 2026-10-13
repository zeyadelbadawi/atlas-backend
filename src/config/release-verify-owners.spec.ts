/**
 * B0-OC-01 — `deploy/release-verify/remote.sh owners` lists the Platform
 * Owner accounts (masked) and every row still referencing them, read-only,
 * and fails closed when the inventory cannot be read. The real script runs
 * against a fixture `.env` with a stubbed `docker` that answers each query
 * from its text.
 */
import { spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../deploy/release-verify/remote.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-verify-owners-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(owners: string, refs: string) {
  writeFileSync(join(dir, '.env'), 'POSTGRES_USER=atlas\nPOSTGRES_DB=atlas\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'owners.txt'), owners);
  writeFileSync(join(dir, 'refs.txt'), refs);
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/usr/bin/env bash',
      'q="${@: -1}"',
      'case "$q" in',
      `  *pg_constraint*) cat "${join(dir, 'refs.txt')}" ;;`,
      `  *is_platform_owner*) cat "${join(dir, 'owners.txt')}" ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const result = spawnSync('bash', [SCRIPT, 'owners'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RELEASE_VERIFY_DIR: dir,
    },
  });
  return { out: result.stdout, status: result.status };
}

describe('Release verify — Platform Owner inventory', () => {
  it('lists each owner and the rows that reference it', () => {
    const { out, status } = run(
      'po|1|cf47d4fb|ad…(5)@example.org|active|live|2026-01-02|2026-10-12|password|no-google|totp-confirmed|10|1|email-verified\n' +
        'po|2|027b2256|op…(8)@example.org|active|live|2026-02-03|never|no-password|google|no-totp|0|0|email-verified\n',
      'ref|1|audit_log_entries.actor_user_id|r|117\nref|2|organizations.owner_user_id|r|1\n',
    );
    expect(out).toContain(
      'INFO  owner|1|cf47d4fb|ad…(5)@example.org|active|live|2026-01-02|2026-10-12|password|no-google|totp-confirmed|10|1|email-verified',
    );
    expect(out).toContain('INFO  owner|2|027b2256|op…(8)@example.org');
    expect(out).toContain('INFO  ref|1|audit_log_entries.actor_user_id|r|117');
    expect(out).toContain('INFO  ref|2|organizations.owner_user_id|r|1');
    expect(out).not.toContain('FAIL');
    expect(status).toBe(0);
  });

  it('fails closed when the inventory cannot be read', () => {
    const { out, status } = run('', '');
    expect(out).toContain('FAIL  Platform Owner inventory could not be read');
    expect(status).not.toBe(0);
  });

  it('queries inside a READ ONLY transaction and selects no secret column', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const body = src.slice(
      src.indexOf('owners_facts() {'),
      src.indexOf('\n}\n', src.indexOf('owners_facts() {')),
    );
    expect(body.match(/BEGIN READ ONLY;/g)).toHaveLength(2);
    for (const secret of [
      'encrypted_secret',
      'code_hash',
      'token_hash',
      'password_hash',
      'u.name',
    ]) {
      expect(body).not.toContain(secret);
    }
  });
});
