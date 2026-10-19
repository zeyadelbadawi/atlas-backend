/**
 * B0-OC-16 / B0-CAT-01 / B0-COM-03 / B0-ORG-03 / B0-ORG-05 / B0-WEB-09 —
 * `deploy/release-verify/remote.sh counts` reports the saved read-only
 * production counts as INFO lines and never fails a run. The real script runs
 * against a fixture `.env` with a stubbed `docker` that answers each query
 * from its text. The theme and slug lists the script embeds are compared with
 * the code's own constants so they cannot drift apart.
 */
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { RESERVED_SUBDOMAINS } from '../provisioning/dto/provisioning.constants';
import {
  RETIRED_WEBSITE_THEME_KEYS,
  SELECTABLE_WEBSITE_THEME_KEYS,
} from '../website/constants/website.constants';

const SCRIPT = resolve(__dirname, '../../deploy/release-verify/remote.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-verify-counts-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Answers = Partial<
  Record<
    | 'subs'
    | 'overlimit'
    | 'orgs'
    | 'emptytext'
    | 'themes'
    | 'retired'
    | 'slugs'
    | 'owners'
    | 'rls'
    | 'notForced'
    | 'noRls'
    | 'paymodes',
    string
  >
>;

function run(answers: Answers) {
  writeFileSync(join(dir, '.env'), 'POSTGRES_USER=atlas\nPOSTGRES_DB=atlas\n');
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const docker = join(bin, 'docker');
  const a = (k: keyof Answers) => answers[k] ?? '';
  writeFileSync(
    docker,
    [
      '#!/usr/bin/env bash',
      'q="$*"',
      'case "$q" in',
      `  *"'subs_all'"*) printf '%s\\n' ${quote(a('subs'))} ;;`,
      `  *"'overlimit'"*) printf '%s\\n' ${quote(a('overlimit'))} ;;`,
      `  *"'orgs'"*) printf '%s\\n' ${quote(a('orgs'))} ;;`,
      `  *"'emptytext'"*) echo '${a('emptytext')}' ;;`,
      `  *"'themes'"*) printf '%s\\n' ${quote(a('themes'))} ;;`,
      `  *"'retired_published'"*) echo '${a('retired')}' ;;`,
      `  *"'slugs'"*) echo '${a('slugs')}' ;;`,
      `  *"'owners'"*) echo '${a('owners')}' ;;`,
      `  *"'rls'"*) echo '${a('rls')}' ;;`,
      `  *"not c.relforcerowsecurity"*) echo '${a('notForced')}' ;;`,
      `  *"not c.relrowsecurity"*) echo '${a('noRls')}' ;;`,
      `  *"'paymodes'"*) printf '%s\\n' ${quote(a('paymodes'))} ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(docker, 0o755);
  const result = spawnSync('bash', [SCRIPT, 'counts'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RELEASE_VERIFY_DIR: dir,
    },
  });
  return { out: result.stdout, status: result.status };
}

/** Newline-separated rows as separate single-quoted printf arguments. */
function quote(rows: string): string {
  return rows === ''
    ? "''"
    : rows
        .split('\n')
        .map((r) => `'${r}'`)
        .join(' ');
}

function scriptList(name: string): string[] {
  const text = readFileSync(SCRIPT, 'utf8');
  const match = new RegExp(`^${name}="([^"]*)"`, 'm').exec(text);
  if (!match) throw new Error(`${name} not found in remote.sh`);
  return match[1].split(/\s+/).filter((v) => v && !v.startsWith('$'));
}

describe('Release verify — B0 read-only counts (OC-16)', () => {
  it('reports every count as INFO, with retired and unknown theme keys labelled', () => {
    const { out, status } = run({
      subs: 'subs_all|growth|active|1\nsubs_all|starter|trialing|4',
      overlimit: 'overlimit|growth|5|2|0|1',
      orgs: 'orgs|active|9|2\norgs|archived|1|0',
      emptytext: 'emptytext|0|3',
      themes:
        'themes|atelier|published|1\nthemes|bold-creative|draft|2\nthemes|mystery|draft|1',
      retired: 'retired_published|0|0',
      slugs: 'slugs|0|1',
      owners: 'owners|12|1|2',
      rls: 'rls|140|131|129',
      noRls: 'plans, trial_redemption_history',
      notForced: 'audit_log_entries, sessions',
      paymodes: 'paymodes|academy_manual|3\npaymodes|unconfigured|6',
    });
    for (const line of [
      'INFO  subscriptions: plan=growth status=active count=1',
      'INFO  subscriptions: plan=starter status=trialing count=4',
      'INFO  CAT-01: live subscriptions on growth=5; over the current limit: academies=2 courses=0 active students=1',
      'INFO  organizations: status=active count=9 tagged internal=2',
      'INFO  organizations: status=archived count=1 tagged internal=0',
      'INFO  empty text lessons: created after 20261009000000=0 before=3',
      'INFO  websites: theme=atelier status=published count=1',
      'INFO  websites: theme=bold-creative (retired) status=draft count=2',
      'INFO  websites: theme=mystery (unknown key) status=draft count=1',
      'INFO  WEB-09: published websites on a retired theme=0, on an unknown theme key=0',
      'INFO  academy slugs: reserved=0 candidate (preview, staging, docs, blog, help, learn)=1',
      'INFO  ORG-03: live academies=12, with no active owner row=1, whose organization owner has no academy-owner row=2',
      'INFO  ORG-05: public tables=140, RLS enabled=131, RLS forced=129',
      'INFO  ORG-05: tables without RLS: plans, trial_redemption_history',
      'INFO  ORG-05: RLS enabled but not forced: audit_log_entries, sessions',
      'INFO  COM-03: organizations with payment_collection_mode=academy_manual: 3',
      'INFO  COM-03: organizations with payment_collection_mode=unconfigured: 6',
    ]) {
      expect(out).toContain(line);
    }
    expect(out).not.toMatch(/^(FAIL|PASS)/m);
    expect(status).toBe(0);
  });

  it('an unreadable database prints unknowns, never zeros, and still does not gate', () => {
    const { out, status } = run({});
    expect(out).toContain(
      'INFO  empty text lessons: created after 20261009000000=? before=?',
    );
    expect(out).toContain(
      'INFO  WEB-09: published websites on a retired theme=?, on an unknown theme key=?',
    );
    expect(out).toContain('INFO  ORG-03: live academies=?, with no active owner row=?');
    expect(out).toContain('INFO  ORG-05: public tables=?, RLS enabled=?, RLS forced=?');
    expect(out).not.toMatch(/^(FAIL|PASS)/m);
    expect(status).toBe(0);
  });

  it('embeds the same theme and reserved-slug lists as the code', () => {
    expect(scriptList('RETIRED_THEME_KEYS')).toEqual([...RETIRED_WEBSITE_THEME_KEYS]);
    expect(scriptList('KNOWN_THEME_KEYS')).toEqual([...SELECTABLE_WEBSITE_THEME_KEYS]);
    expect(scriptList('RESERVED_SLUGS')).toEqual([...RESERVED_SUBDOMAINS]);
  });

  it('never reads a personal-data or storage column', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const body = text.slice(text.indexOf('b0_counts_facts() {'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).not.toMatch(
      /\bemail\b|\bphone\b|\bfull_name\b|storage_key|manual_instructions/,
    );
  });
});
