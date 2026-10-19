/**
 * B0-CAT-01 / B0-ANL-04 — `deploy/internal-org-tagging/remote.sh`, the
 * server half of the `Internal organization tagging` workflow, against real
 * Postgres. The script's SQL runs through a stubbed `docker` that forwards
 * `compose exec -T postgres psql ...` to local `psql` in a scratch schema
 * (`search_path`) holding copies of `organizations` and
 * `organization_platform_flags`, so no other suite's rows are touched.
 *
 *   - dry-run plans every organization existing now and writes nothing;
 *   - apply tags exactly the planned organizations not tagged yet (an
 *     organization created after the dry run is not tagged), records the
 *     changed ids on the host and prints counts only; a second apply
 *     changes nothing;
 *   - revert untags exactly what that apply tagged, leaving an organization
 *     that was tagged before untouched;
 *   - apply / revert refuse without a stored input.
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
import type { PrismaClient } from '@prisma/client';
import { createAdminPrisma } from './utils/db-admin';

const SCRIPT = resolve(__dirname, '../deploy/internal-org-tagging/remote.sh');

describe('Internal organization tagging — remote.sh (e2e, B0-CAT-01)', () => {
  let admin: PrismaClient;
  let dir: string;
  let store: string;
  const schema = `tagging_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  function run(args: string[]) {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        INTERNAL_TAGGING_DIR: dir,
        INTERNAL_TAGGING_STORE: store,
        // psql refuses Prisma's URL parameters (`schema`, `connection_limit`).
        TAGGING_DB_URL: (process.env.DATABASE_URL ?? '').split('?')[0],
        PGOPTIONS: `-c search_path=${schema}`,
      },
    });
    return { out: `${result.stdout}${result.stderr}`, status: result.status };
  }

  const flags = async (): Promise<Record<string, boolean>> => {
    const rows = await admin.$queryRawUnsafe<{ id: string; is_internal: boolean }[]>(
      `SELECT organization_id AS id, is_internal FROM "${schema}".organization_platform_flags`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.is_internal]));
  };
  const addOrg = (id: string, status = 'active') =>
    admin.$executeRawUnsafe(
      `INSERT INTO "${schema}".organizations (id, status) VALUES ($1, $2)`,
      id,
      status,
    );

  beforeAll(async () => {
    admin = createAdminPrisma();
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await admin.$executeRawUnsafe(
      `CREATE TABLE "${schema}".organizations (id text PRIMARY KEY, status text NOT NULL)`,
    );
    // Same columns and FK as migration 20261115000100.
    await admin.$executeRawUnsafe(`
      CREATE TABLE "${schema}".organization_platform_flags (
        organization_id text PRIMARY KEY REFERENCES "${schema}".organizations(id) ON DELETE CASCADE,
        is_internal boolean NOT NULL DEFAULT false,
        updated_by_user_id text,
        updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await addOrg('org-a');
    await addOrg('org-b');
    await addOrg('org-c', 'archived');
    await addOrg('org-tagged');
    await admin.$executeRawUnsafe(
      `INSERT INTO "${schema}".organization_platform_flags (organization_id, is_internal, updated_by_user_id) VALUES ('org-tagged', true, 'someone'), ('org-b', false, NULL)`,
    );

    dir = mkdtempSync(join(tmpdir(), 'internal-tagging-'));
    store = join(dir, 'store');
    writeFileSync(join(dir, '.env'), 'POSTGRES_USER=atlas\nPOSTGRES_DB=atlas\n');
    mkdirSync(join(dir, 'bin'));
    // `docker compose exec -T postgres psql -U <u> -d <d> <rest>` → local psql.
    writeFileSync(
      join(dir, 'bin/docker'),
      [
        '#!/usr/bin/env bash',
        'if [ "$1 $2 $3 $4 $5" != "compose exec -T postgres psql" ]; then echo "unexpected docker call: $*" >&2; exit 99; fi',
        'shift 9',
        'exec psql "$TAGGING_DB_URL" -v ON_ERROR_STOP=1 "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'bin/docker'), 0o755);
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('apply and revert refuse without a stored input', () => {
    for (const args of [
      ['apply', '20', '999'],
      ['revert', '30', '999'],
    ]) {
      const { out, status } = run(args);
      expect(status).toBe(1);
      expect(out).toContain('REFUSED');
    }
  });

  it('dry-run plans every organization existing now and writes nothing', async () => {
    const before = await flags();
    const { out, status } = run(['dry-run', '10']);
    expect(status).toBe(0);
    expect(out).toContain('organizations: status=active count=3 tagged internal=1');
    expect(out).toContain('organizations: status=archived count=1 tagged internal=0');
    expect(out).toContain(
      'planned: 4 organizations (every organization now); already tagged: 1',
    );
    expect(out).not.toMatch(/org-/);
    expect(readFileSync(join(store, 'plan-10.txt'), 'utf8').trim().split('\n')).toEqual([
      'org-a',
      'org-b',
      'org-c',
      'org-tagged',
    ]);
    expect(await flags()).toEqual(before);
  });

  it('apply tags exactly the planned, untagged organizations; a second apply changes nothing', async () => {
    await addOrg('org-after-plan');
    const { out, status } = run(['apply', '20', '10']);
    expect(status).toBe(0);
    expect(out).toContain('tagged now: 3 organizations');
    expect(out).toContain('organizations: status=active count=4 tagged internal=3');
    expect(out).not.toMatch(/org-/);
    expect(await flags()).toEqual({
      'org-a': true,
      'org-b': true,
      'org-c': true,
      'org-tagged': true,
    });
    expect(
      readFileSync(join(store, 'applied-20.txt'), 'utf8').trim().split('\n').sort(),
    ).toEqual(['org-a', 'org-b', 'org-c']);
    const rows = await admin.$queryRawUnsafe<{ id: string; by: string | null }[]>(
      `SELECT organization_id AS id, updated_by_user_id AS by FROM "${schema}".organization_platform_flags ORDER BY 1`,
    );
    expect(rows).toEqual([
      { id: 'org-a', by: null },
      { id: 'org-b', by: null },
      { id: 'org-c', by: null },
      { id: 'org-tagged', by: 'someone' },
    ]);

    const again = run(['apply', '21', '10']);
    expect(again.status).toBe(0);
    expect(again.out).toContain('tagged now: 0 organizations');
  });

  it('revert untags exactly what that apply tagged', async () => {
    const { out, status } = run(['revert', '30', '20']);
    expect(status).toBe(0);
    expect(out).toContain('untagged now: 3 organizations');
    expect(await flags()).toEqual({
      'org-a': false,
      'org-b': false,
      'org-c': false,
      'org-tagged': true,
    });
  });
});
