/**
 * B0-OPS-08 — `deploy/media-backup.sh` (owner decision DL-47: payment proofs
 * and protected media daily, public media weekly, no Redis). The real script
 * runs against a stubbed `docker` whose `amazon/aws-cli` answers `s3 ls
 * --recursive` and `s3 sync` from local folders standing in for R2 buckets.
 *
 *   - daily copies proofs + protected, weekly copies public, into
 *     `objects/<bucket>/` of the backup bucket, with the dedicated token only;
 *   - a copy never deletes: an object removed at the source stays copied;
 *   - verify counts source vs copy and fails on a missing object, printing
 *     no object keys;
 *   - no token, or media and backup on different endpoints: refuses, copies
 *     nothing.
 */
import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../deploy/media-backup.sh');

let dir: string;
let r2: string;

const ENV = [
  'R2_BUCKET=atlas-media',
  'R2_ENDPOINT=https://acct.r2.example',
  'R2_ACCESS_KEY_ID=app-media-key',
  'R2_BACKUP_BUCKET=atlas-backups',
  'R2_BACKUP_ENDPOINT=https://acct.r2.example',
  'R2_BACKUP_ACCESS_KEY_ID=db-backup-key',
  'R2_BACKUP_SECRET_ACCESS_KEY=db-backup-secret',
  'R2_MEDIA_BACKUP_ACCESS_KEY_ID=media-backup-key',
  'R2_MEDIA_BACKUP_SECRET_ACCESS_KEY=media-backup-secret',
];

function put(bucket: string, key: string): void {
  const file = join(r2, bucket, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-backup-'));
  r2 = join(dir, 'r2');
  mkdirSync(join(dir, 'bin'));
  // docker run --rm [-i] -e AWS_ACCESS_KEY_ID=.. -e .. -e .. IMAGE --endpoint-url URL <s3|s3api> ...
  // Each call logs "<op> key=<access key id>" so a test can check which
  // credential did what. Buckets are folders under $R2.
  writeFileSync(
    join(dir, 'bin/docker'),
    `#!/usr/bin/env bash
set -euo pipefail
key=""
for a in "$@"; do case "$a" in AWS_ACCESS_KEY_ID=*) key="\${a#AWS_ACCESS_KEY_ID=}";; esac; done
while [ "$1" != "s3" ] && [ "$1" != "s3api" ]; do shift; done
tool="$1"; shift
path() { local u="\${1#s3://}"; echo "$R2/$u"; }
if [ "$tool" = s3api ]; then
  # list-objects-v2 --bucket B [--prefix P] --query .. --output text
  shift; bucket=""; prefix=""
  while [ $# -gt 0 ]; do case "$1" in --bucket) bucket="$2"; shift 2;; --prefix) prefix="$2"; shift 2;; *) shift;; esac; done
  echo "list key=$key bucket=$bucket" >> "$CALLS"
  [ -d "$R2/$bucket" ] || exit 254
  out=$(cd "$R2/$bucket" && find . -type f | sed 's#^\\./##' | grep "^$prefix" || true)
  if [ -z "$out" ]; then echo None; else echo "$out"; fi
  exit 0
fi
case "$1" in
  cp)
    if [ "$2" = - ]; then echo "write key=$key" >> "$CALLS"; f=$(path "$3"); mkdir -p "$(dirname "$f")"; cat > "$f"
    else echo "read key=$key" >> "$CALLS"; cat "$(path "$2")"; fi ;;
  *) exit 9 ;;
esac
`,
  );
  chmodSync(join(dir, 'bin/docker'), 0o755);
  put('atlas-media-payment-proofs', 'org1/proof-a.png');
  put('atlas-media-protected', 'academy1/lesson.pdf');
  put('atlas-media', 'public/logo.png');
  mkdirSync(join(r2, 'atlas-backups'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(mode: string, env: string[] = ENV) {
  writeFileSync(join(dir, '.env'), env.join('\n') + '\n');
  const result = spawnSync('bash', [SCRIPT, mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      MEDIA_BACKUP_DIR: dir,
      MEDIA_BACKUP_LOCK: join(dir, 'lock'),
      CALLS: join(dir, 'calls.log'),
      R2: r2,
    },
  });
  return { out: `${result.stdout}${result.stderr}`, status: result.status };
}

const calls = (): string =>
  existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
const copied = (bucket: string, key: string): boolean =>
  existsSync(join(r2, 'atlas-backups/objects', bucket, key));

describe('Media backup — media-backup.sh (B0-OPS-08)', () => {
  it('daily copies proofs and protected media: reads with the read-only media token, writes with the backup token', () => {
    const { out, status } = run('daily');
    expect(status).toBe(0);
    expect(copied('atlas-media-payment-proofs', 'org1/proof-a.png')).toBe(true);
    expect(copied('atlas-media-protected', 'academy1/lesson.pdf')).toBe(true);
    expect(copied('atlas-media', 'public/logo.png')).toBe(false);
    const log = calls();
    expect(log).not.toContain('app-media-key');
    expect(log).toMatch(/^read key=media-backup-key$/m);
    expect(log).toMatch(/^write key=db-backup-key$/m);
    expect(log).not.toMatch(/^write key=media-backup-key$/m);
    expect(log).toMatch(/^list key=media-backup-key bucket=atlas-media-payment-proofs$/m);
    expect(log).toMatch(/^list key=db-backup-key bucket=atlas-backups$/m);
    expect(out).toContain(
      'bucket=atlas-media-payment-proofs new_objects=1 copied=1 failed=0 already_in_copy=0',
    );
    expect(out).not.toMatch(/proof-a|lesson\.pdf/);
    expect(out).toContain('== Result: ok');
  });

  it('copies only what the copy does not have yet', () => {
    run('daily');
    put('atlas-media-payment-proofs', 'org1/proof-b.png');
    const { out } = run('daily');
    expect(out).toContain(
      'bucket=atlas-media-payment-proofs new_objects=1 copied=1 failed=0 already_in_copy=1',
    );
    expect(out).toContain(
      'bucket=atlas-media-protected new_objects=0 copied=0 failed=0 already_in_copy=1',
    );
  });

  it('an empty source bucket is not an error', () => {
    rmSync(join(r2, 'atlas-media-payment-proofs/org1/proof-a.png'));
    const { out, status } = run('daily');
    expect(status).toBe(0);
    expect(out).toContain('bucket=atlas-media-payment-proofs new_objects=0 copied=0');
  });

  it('an unreadable source bucket fails the run', () => {
    rmSync(join(r2, 'atlas-media-protected'), { recursive: true, force: true });
    const { out, status } = run('daily');
    expect(status).toBe(1);
    expect(out).toContain('FAIL  cannot list the source bucket (atlas-media-protected)');
  });

  it('weekly copies public media only', () => {
    const { status } = run('weekly');
    expect(status).toBe(0);
    expect(copied('atlas-media', 'public/logo.png')).toBe(true);
    expect(copied('atlas-media-payment-proofs', 'org1/proof-a.png')).toBe(false);
  });

  it('keeps a copied object after it is deleted at the source', () => {
    run('daily');
    rmSync(join(r2, 'atlas-media-payment-proofs/org1/proof-a.png'));
    put('atlas-media-payment-proofs', 'org1/proof-b.png');
    expect(run('daily').status).toBe(0);
    expect(copied('atlas-media-payment-proofs', 'org1/proof-a.png')).toBe(true);
    expect(copied('atlas-media-payment-proofs', 'org1/proof-b.png')).toBe(true);
  });

  it('verify reports counts per bucket, fails on a missing object, and prints no keys', () => {
    run('daily');
    run('weekly');
    let res = run('verify');
    expect(res.status).toBe(0);
    expect(res.out).toContain(
      'bucket=atlas-media-payment-proofs source=1 copy=1 missing_from_copy=0',
    );
    put('atlas-media-protected', 'academy1/new.pdf');
    res = run('verify');
    expect(res.status).toBe(1);
    expect(res.out).toContain(
      'bucket=atlas-media-protected source=2 copy=1 missing_from_copy=1',
    );
    expect(res.out).not.toMatch(/proof-a|lesson\.pdf|new\.pdf|logo\.png/);
  });

  it('restore-test reads a copied object back and compares it with the source', () => {
    run('daily');
    let res = run('restore-test');
    expect(res.status).toBe(0);
    expect(res.out).toContain('bucket=atlas-media-payment-proofs restore_test=match');
    expect(res.out).toContain(
      'bucket=atlas-media restore_test=skipped (no copied object yet)',
    );
    writeFileSync(
      join(r2, 'atlas-backups/objects/atlas-media-protected/academy1/lesson.pdf'),
      'tampered',
    );
    res = run('restore-test');
    expect(res.status).toBe(1);
    expect(res.out).toContain('bucket=atlas-media-protected restore_test=MISMATCH');
    expect(res.out).not.toMatch(/proof-a|lesson\.pdf/);
  });

  it('refuses without the read-only media token, and copies nothing', () => {
    const { out, status } = run(
      'daily',
      ENV.filter((l) => !l.startsWith('R2_MEDIA_BACKUP_')),
    );
    expect(status).toBe(1);
    expect(out).toContain('Nothing was copied');
    expect(calls()).toBe('');
  });

  it('refuses without the backup token, and copies nothing', () => {
    const { out, status } = run(
      'daily',
      ENV.filter((l) => !l.startsWith('R2_BACKUP_ACCESS_KEY_ID')),
    );
    expect(status).toBe(1);
    expect(out).toContain('R2_BACKUP_ACCESS_KEY_ID');
    expect(calls()).toBe('');
  });

  it('rejects an unknown mode', () => {
    expect(run('everything').status).toBe(2);
  });
});
