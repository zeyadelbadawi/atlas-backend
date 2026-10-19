/**
 * B0-WEB-09 — `deploy/theme-retirement/remote.sh`, the server half of the
 * `Website theme retirement` workflow. The real script runs with a stubbed
 * `docker` that executes `compose exec -T backend <cmd>` locally, against a
 * fake `dist/scripts/retire-website-themes.js` that records its arguments
 * and writes a report the way the real one does.
 *
 *   - dry-run stores the plan on the host and prints counts, never names;
 *   - apply runs exactly the stored plan of the given dry run, under the
 *     host lock, and stores the apply report;
 *   - apply / rollback refuse without a stored input and write nothing;
 *   - a failing apply keeps its partial report (for a rollback) and fails;
 *   - run ids are digits only.
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
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../deploy/theme-retirement/remote.sh');

let dir: string;
let store: string;

const FAKE_SCRIPT = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
const out = args.find((a) => a.startsWith('--out=')).slice(6);
const apply = args.includes('--apply');
const plan = args.find((a) => a.startsWith('--plan='));
const rollback = args.find((a) => a.startsWith('--rollback='));
const entry = { academyId: 'a1', academyName: 'Secret Academy', academySlug: 'secret-slug', fromThemeKey: 'bold-creative', status: 'published', fingerprint: 'f' };
let report;
if (!apply) {
  report = { mode: 'dry-run', summary: { scanned: 3, toMove: 1, byTheme: { 'bold-creative': 1 }, published: 1 }, entries: [entry], outcomes: [{ academySlug: 'secret-slug', result: 'wouldMove' }], pendingProvisioningRequests: [] };
} else {
  const input = JSON.parse(fs.readFileSync((plan || rollback).split('=')[1], 'utf8'));
  fs.appendFileSync(process.env.CALLS, 'input-mode:' + input.mode + '\\n');
  report = { mode: plan ? 'apply' : 'rollback', summary: { moved: plan ? 1 : 0, restored: plan ? 0 : 1 }, entries: [], outcomes: [{ academySlug: 'secret-slug', result: plan ? 'moved' : 'restored' }], pendingProvisioningRequests: [] };
  if (process.env.FAIL_APPLY) report = { mode: 'apply', failed: 'Content changed while moving secret-slug; rolled back.', entries: [], outcomes: [{ academySlug: 'secret-slug', result: 'moved' }] };
}
fs.writeFileSync(out, JSON.stringify(report));
if (process.env.FAIL_APPLY && apply) process.exit(1);
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'theme-retirement-'));
  store = join(dir, 'store');
  mkdirSync(join(dir, 'dist/scripts'), { recursive: true });
  writeFileSync(join(dir, 'dist/scripts/retire-website-themes.js'), FAKE_SCRIPT);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // `docker compose ps -q backend` → an id; `docker compose exec -T backend
  // <cmd...>` → <cmd...> run here (the "container" is this directory).
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1 $2" = "compose ps" ]; then echo abc123; exit 0; fi',
      'if [ "$1 $2 $3 $4" = "compose exec -T backend" ]; then shift 4; exec "$@"; fi',
      'echo "unexpected docker call: $*" >&2; exit 99',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      THEME_RETIREMENT_DIR: dir,
      THEME_RETIREMENT_STORE: store,
      THEME_RETIREMENT_LOCK: join(dir, 'deploy.lock'),
      THEME_RETIREMENT_TMP: join(dir, 'container-tmp'),
      CALLS: join(dir, 'calls.log'),
      ...env,
    },
  });
  return { out: `${result.stdout}${result.stderr}`, status: result.status };
}

const calls = (): string =>
  existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';

describe('Website theme retirement — remote.sh (B0-WEB-09)', () => {
  it('dry-run stores the plan on the host and prints counts only', () => {
    const { out, status } = run(['dry-run', '111']);
    expect(status).toBe(0);
    expect(out).toContain('"toMove":1');
    expect(out).toContain('to move by website status: {"published":1}');
    expect(out).toContain('report stored: plan-111.json');
    expect(out).toContain('mode=apply, ref_run_id=111');
    expect(out).not.toMatch(/secret|Secret/);
    const plan = JSON.parse(readFileSync(join(store, 'plan-111.json'), 'utf8'));
    expect(plan.mode).toBe('dry-run');
    expect(calls()).not.toContain('--apply');
    // Nothing left behind in the "container".
    expect(existsSync(join(dir, 'container-tmp/plan.json'))).toBe(false);
  });

  it('apply runs exactly the stored plan of the given dry run and stores its report', () => {
    run(['dry-run', '111']);
    const { out, status } = run(['apply', '222', '111']);
    expect(status).toBe(0);
    expect(out).toContain('input: plan-111.json');
    expect(out).toContain('outcomes: {"moved":1}');
    expect(out).toContain('report stored: applied-222.json');
    expect(out).toContain('mode=rollback, ref_run_id=222');
    expect(out).not.toMatch(/secret|Secret/);
    expect(calls()).toContain('input-mode:dry-run');
    expect(calls()).toMatch(/"--apply","--plan=[^"]+input\.json"/);
    expect(existsSync(join(dir, 'container-tmp/input.json'))).toBe(false);
  });

  it('rollback runs the stored apply report with --apply --rollback', () => {
    run(['dry-run', '111']);
    run(['apply', '222', '111']);
    const { out, status } = run(['rollback', '333', '222']);
    expect(status).toBe(0);
    expect(calls()).toContain('input-mode:apply');
    expect(calls()).toMatch(/"--apply","--rollback=[^"]+input\.json"/);
    expect(out).toContain('report stored: rolled-back-333.json');
  });

  it('apply and rollback refuse without a stored input, and run nothing', () => {
    for (const args of [
      ['apply', '222', '999'],
      ['rollback', '333', '999'],
    ]) {
      const { out, status } = run(args);
      expect(status).toBe(1);
      expect(out).toContain('REFUSED');
      expect(out).toContain('Nothing was written');
    }
    expect(calls()).toBe('');
  });

  it('a failing apply keeps its partial report for a rollback, and fails the run', () => {
    run(['dry-run', '111']);
    const { out, status } = run(['apply', '222', '111'], { FAIL_APPLY: '1' });
    expect(status).toBe(1);
    expect(out).toContain('FAILED part-way');
    expect(out).toContain('report stored: applied-222.json');
    expect(out).toContain('mode=rollback with ref_run_id=222');
    expect(existsSync(join(store, 'applied-222.json'))).toBe(true);
  });

  it('refuses a run id that is not digits only', () => {
    for (const args of [
      ['dry-run', 'x;rm -rf /'],
      ['apply', '222', '../plan'],
      ['rollback'],
      ['bogus', '1'],
    ]) {
      expect(run(args).status).toBe(2);
    }
    expect(calls()).toBe('');
  });
});
