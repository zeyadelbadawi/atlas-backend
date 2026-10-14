/**
 * B0-MED-11 / B0-OC-34 — `deploy/release-verify/remote.sh video` reports the
 * Normal-tier readiness without printing a secret, a bucket name or an
 * academy ID, and never writes to storage. The real script runs against a
 * fixture `.env` with a stubbed `docker` on PATH: the in-container probe is
 * answered with canned lines, the SQL with canned rows.
 */
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../deploy/release-verify/remote.sh');

const SECRETS = ['protected-key-SECRET-1', 'signing-SECRET-2'];
const BUCKET = 'bucket-name-PRIVATE';
const ACADEMY_IDS = ['acad-id-0001-aaaa', 'acad-id-0002-bbbb'];

const BASE_ENV = [
  'POSTGRES_USER=atlas',
  'POSTGRES_DB=atlas',
  'VIDEO_PROVIDER=r2_worker',
  'FLAG_VIDEO_NORMAL_MODE=off',
  `FLAG_VIDEO_NORMAL_ACADEMY_IDS=${ACADEMY_IDS.join(',')}`,
  `R2_PROTECTED_BUCKET=${BUCKET}`,
  `R2_PROTECTED_ACCESS_KEY_ID=${SECRETS[0]}`,
  `BASIC_VIDEO_SIGNING_SECRET=${SECRETS[1]}`,
  'PLATFORM_BASE_DOMAIN=atlass.example',
];

const PROBE_OK = [
  'INFO  bucket CORS rules: 1',
  'PASS  preflight PUT origin=https://atlass.example status=200 allow-origin=https://atlass.example',
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-verify-video-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(envLines: string[], probe: string[]) {
  writeFileSync(join(dir, '.env'), `${envLines.join('\n')}\n`);
  writeFileSync(join(dir, 'probe.txt'), `${probe.join('\n')}\n`);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> "${join(dir, 'docker.log')}"`,
      'case "$*" in',
      `  *"backend node"*) cat "${join(dir, 'probe.txt')}" ;;`,
      "  *media_assets*) echo 'videos|4|2|1|1|123456789|1800' ;;",
      "  *plans*) printf 'limits|starter|active|600|5\\n' ;;",
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(docker, 0o755);
  const result = spawnSync('bash', [SCRIPT, 'video'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RELEASE_VERIFY_DIR: dir,
    },
  });
  return {
    out: result.stdout,
    err: result.stderr,
    status: result.status,
    calls: readFileSync(join(dir, 'docker.log'), 'utf8'),
  };
}

describe('Release verify Normal-tier video readiness (B0-MED-11)', () => {
  it('never prints a secret, the bucket name or an academy ID', () => {
    const { out, err } = run(BASE_ENV, PROBE_OK);
    for (const value of [...SECRETS, BUCKET, ...ACADEMY_IDS]) {
      expect(out).not.toContain(value);
      expect(err).not.toContain(value);
    }
    expect(out).toContain('INFO  R2_PROTECTED_BUCKET: set (name not printed)');
    expect(out).toContain('INFO  R2_PROTECTED_ACCESS_KEY_ID: set');
    expect(out).toContain('INFO  BASIC_VIDEO_SIGNING_SECRET: set');
    expect(out).toContain('INFO  FLAG_VIDEO_NORMAL_ACADEMY_IDS entries=2');
    expect(out).toContain('INFO  FLAG_VIDEO_NORMAL_MODE=off');
  });

  it('reports usage as counts and the plan video limits', () => {
    const { out, status } = run(BASE_ENV, PROBE_OK);
    expect(out).toContain(
      'INFO  protected videos=4 ready=2 in-progress=1 failed=1 bytes=123456789 seconds=1800',
    );
    expect(out).toContain(
      'INFO  plan starter (active): videoStorageMinutes=600 videoStorage=5',
    );
    expect(out).toContain(
      'INFO  BASIC_VIDEO_DELIVERY_HOST unset: no delivery Worker configured',
    );
    expect(status).toBe(0);
  });

  it('fails when the dashboard origin is refused by the bucket', () => {
    const { out, status } = run(BASE_ENV, [
      'FAIL  preflight PUT origin=https://atlass.example status=403 allow-origin=-',
    ]);
    expect(out).toContain('FAIL  preflight PUT origin=https://atlass.example status=403');
    expect(status).not.toBe(0);
  });

  it('only reads: the probe sends OPTIONS and never a PUT', () => {
    const { calls } = run(BASE_ENV, PROBE_OK);
    // The in-container script is multi-line: everything after `node -e`
    // up to the first SQL call.
    const start = calls.indexOf('backend node -e');
    const probe = calls.slice(start, calls.indexOf('psql', start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(probe).toContain('method: "OPTIONS"');
    expect(probe).toContain('GetBucketCorsCommand');
    expect(probe).not.toMatch(/method:\s*"PUT"/);
    expect(probe).not.toMatch(/send\(new PutObjectCommand/);
    expect(probe).not.toMatch(/PutBucketCors|DeleteBucketCors|DeleteObject/);
  });
});
