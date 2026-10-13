/**
 * B0-OPS-01 — the `Release verify` configuration facts print what the
 * owner needs and nothing secret. The real `deploy/release-verify/remote.sh
 * config` runs against a fixture `.env` with a stubbed `docker` on PATH (no
 * database, no Docker): secret values and academy IDs never appear,
 * academy-ID lists print counts, secrets print set / not set, and the
 * Platform Owner authenticator section prints integers from a query that
 * reads no `user_two_factor` column but `confirmed_at`.
 */
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../deploy/release-verify/remote.sh');

const SECRET_VALUES = [
  'sentry-dsn-SECRET-1',
  'scrape-token-SECRET-2',
  'brevo-key-SECRET-3',
  'basic-video-signing-SECRET-4',
  'zoom-oauth-SECRET-5',
  'stream-token-SECRET-6',
];
const ACADEMY_IDS = [
  'acad-id-0001-aaaa',
  'acad-id-0002-bbbb',
  'acad-id-0003-cccc',
  'acad-id-0004-dddd',
];

const BASE_ENV = [
  'POSTGRES_USER=atlas',
  'POSTGRES_DB=atlas',
  'VIDEO_PROVIDER=r2_worker',
  'AUTH_PRIVILEGED_EMAIL_OTP_FLOOR=new_device',
  'EMAIL_PROVIDERS=brevo,resend',
  'FLAG_VIDEO_NORMAL_MODE=on',
  `FLAG_VIDEO_NORMAL_ACADEMY_IDS=${ACADEMY_IDS[0]},${ACADEMY_IDS[1]},${ACADEMY_IDS[2]}`,
  'FLAG_AUTH_EMAIL_OTP_ALLOWLIST=',
  `SURFACE_ENFORCE_ACADEMY_IDS=${ACADEMY_IDS[3]}`,
  `SENTRY_DSN=${SECRET_VALUES[0]}`,
  `METRICS_SCRAPE_TOKEN=${SECRET_VALUES[1]}`,
  `BREVO_API_KEY=${SECRET_VALUES[2]}`,
  `BASIC_VIDEO_SIGNING_KEY=${SECRET_VALUES[3]}`,
  `ZOOM_OAUTH_CLIENT_SECRET=${SECRET_VALUES[4]}`,
  `CLOUDFLARE_STREAM_API_TOKEN=${SECRET_VALUES[5]}`,
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-verify-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `remote.sh config`; the stubbed `docker` answers every query with `totp`. */
function run(envLines: string[], totp = '3|2') {
  writeFileSync(join(dir, '.env'), `${envLines.join('\n')}\n`);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(dir, 'docker.log')}"\nprintf '%s\\n' "$FAKE_TOTP"\n`,
  );
  chmodSync(docker, 0o755);
  const result = spawnSync('bash', [SCRIPT, 'config'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RELEASE_VERIFY_DIR: dir,
      FAKE_TOTP: totp,
    },
  });
  let queries = '';
  try {
    queries = readFileSync(join(dir, 'docker.log'), 'utf8');
  } catch {
    queries = '';
  }
  return { out: result.stdout, err: result.stderr, status: result.status, queries };
}

describe('Release verify configuration facts (B0-OPS-01)', () => {
  it('never prints a secret value or an academy ID', () => {
    const { out, err } = run([
      ...BASE_ENV,
      'PLATFORM_OWNER_TOTP_REQUIRED_FROM=2999-01-01T00:00:00.000Z',
    ]);
    for (const value of [...SECRET_VALUES, ...ACADEMY_IDS]) {
      expect(out).not.toContain(value);
      expect(err).not.toContain(value);
    }
  });

  it('prints academy-ID lists as counts and secrets as set / not set', () => {
    const { out } = run([
      ...BASE_ENV,
      'PLATFORM_OWNER_TOTP_REQUIRED_FROM=2999-01-01T00:00:00.000Z',
    ]);
    expect(out).toContain('INFO  FLAG_VIDEO_NORMAL_ACADEMY_IDS entries=3');
    expect(out).toContain('INFO  FLAG_AUTH_EMAIL_OTP_ALLOWLIST entries=0');
    expect(out).toContain('INFO  SURFACE_ENFORCE_ACADEMY_IDS entries=1');
    expect(out).toContain('INFO  FLAG_VIDEO_NORMAL_MODE=on');
    expect(out).toContain('INFO  SENTRY_DSN: set');
    expect(out).toContain('INFO  METRICS_SCRAPE_TOKEN: set');
    expect(out).toContain('INFO  BASIC_VIDEO_SIGNING_KEY: set');
    expect(out).toContain('INFO  ZOOM_OAUTH_CLIENT_SECRET: set');
    expect(out).toContain('INFO  CLOUDFLARE_STREAM_API_TOKEN: set');
    expect(out).toContain('INFO  RESEND_API_KEY: not set in .env');
    expect(out).toContain('INFO  ALERT_SLACK_WEBHOOK_URL: not set in .env');
  });

  it('prints the host-only settings by value', () => {
    const { out } = run(BASE_ENV);
    expect(out).toContain('INFO  VIDEO_PROVIDER=r2_worker');
    expect(out).toContain('INFO  AUTH_PRIVILEGED_EMAIL_OTP_FLOOR=new_device');
    expect(out).toContain('INFO  EMAIL_PROVIDERS=brevo,resend');
    expect(out).toContain('INFO  WATERMARK_RETENTION_DAYS=<unset>');
  });

  it('reads only confirmed_at from user_two_factor and prints integers only', () => {
    const { out, queries } = run([
      ...BASE_ENV,
      'PLATFORM_OWNER_TOTP_REQUIRED_FROM=2999-01-01T00:00:00.000Z',
    ]);
    expect(queries).toContain('count(t.confirmed_at)');
    expect(queries).not.toMatch(/encrypted_secret|last_time_step|recovery|email/);
    const section = out.split('== Platform Owner authenticator (counts only)')[1];
    expect(section).toBeDefined();
    expect(section).toContain('2 of 3 Platform Owner(s) have a confirmed authenticator');
    for (const line of section.trim().split('\n')) {
      expect(line).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  it('passes when every Platform Owner has a confirmed authenticator', () => {
    const { out, status } = run(BASE_ENV, '2|2');
    expect(out).toContain(
      'PASS  every Platform Owner has a confirmed authenticator (2 of 2)',
    );
    expect(status).toBe(0);
  });

  it('only reports a shortfall before enforcement, and fails it after', () => {
    const before = run([
      ...BASE_ENV,
      'PLATFORM_OWNER_TOTP_REQUIRED_FROM=2999-01-01T00:00:00.000Z',
    ]);
    expect(before.out).toContain(
      'INFO  PLATFORM_OWNER_TOTP_REQUIRED_FROM=2999-01-01T00:00:00.000Z (overrides the default 2026-10-24T00:00:00.000Z)',
    );
    expect(before.status).toBe(0);

    const after = run([
      ...BASE_ENV,
      'PLATFORM_OWNER_TOTP_REQUIRED_FROM=2000-01-01T00:00:00.000Z',
    ]);
    expect(after.out).toContain(
      'FAIL  2 of 3 Platform Owner(s) have a confirmed authenticator, and enforcement began 2000-01-01T00:00:00.000Z',
    );
    expect(after.status).not.toBe(0);
  });

  it('names the effective enforcement setting: default, explicit default, never', () => {
    expect(run(BASE_ENV, '1|1').out).toContain(
      'INFO  PLATFORM_OWNER_TOTP_REQUIRED_FROM=default (2026-10-24T00:00:00.000Z)',
    );
    expect(
      run(
        [...BASE_ENV, 'PLATFORM_OWNER_TOTP_REQUIRED_FROM=2026-10-24T00:00:00.000Z'],
        '1|1',
      ).out,
    ).toContain(
      'INFO  PLATFORM_OWNER_TOTP_REQUIRED_FROM=default (2026-10-24T00:00:00.000Z, set explicitly)',
    );
    const never = run([...BASE_ENV, 'PLATFORM_OWNER_TOTP_REQUIRED_FROM=never'], '3|1');
    expect(never.out).toContain(
      'INFO  PLATFORM_OWNER_TOTP_REQUIRED_FROM=never (not enforced)',
    );
    expect(never.status).toBe(0);
  });

  it('fails when the counts cannot be read', () => {
    const { out, status } = run(BASE_ENV, 'ERROR: relation does not exist');
    expect(out).toContain('FAIL  Platform Owner authenticator counts could not be read');
    expect(status).not.toBe(0);
  });
});
