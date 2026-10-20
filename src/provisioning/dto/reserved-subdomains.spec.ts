/**
 * DL-57 — `isReservedSubdomain` refuses platform labels and their
 * look-alikes while leaving ordinary teacher labels free, and the database
 * guard (migration 20261122000000) embeds exactly the same lists, so the
 * two layers cannot drift apart. The e2e suite
 * (`test/reserved-subdomains.e2e-spec.ts`) runs the SQL function itself.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  PLATFORM_LOOKALIKE_WORDS,
  RESERVED_SUBDOMAINS,
  SUBDOMAIN_FILLER_WORDS,
  isReservedSubdomain,
} from './provisioning.constants';

const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations');

/** The newest migration that (re)defines `atlas_is_reserved_subdomain`. */
function latestGuardSql(): string {
  const dirs = readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    if (sql.includes('FUNCTION atlas_is_reserved_subdomain')) return sql;
  }
  throw new Error('no migration defines atlas_is_reserved_subdomain');
}

describe('isReservedSubdomain (DL-57)', () => {
  it.each([
    // Exact platform labels.
    'docs',
    'doc',
    'help',
    'www',
    'api',
    'video',
    'ssh',
    'learn',
    'academy',
    'demo',
    // Case and spacing.
    'DOCS',
    ' help ',
    // Digits and digit look-alikes.
    'docs-2',
    'docs2',
    'www1',
    'd0cs',
    'he1p',
    // Platform words joined with each other or with filler words.
    'help-center',
    'helpcenter',
    'apidocs',
    'api-docs',
    'support-desk',
    'status-page',
    'my-docs',
    'sign-in',
    'mail-hub',
    // The Atlas name anywhere, and admin-anything.
    'atlas-math',
    'my-atlas',
    'atlasacademy',
    '4tlas',
    'at1as',
    'admin-panel',
    'administrator',
    'adm1n',
  ])('refuses "%s"', (label) => {
    expect(isReservedSubdomain(label)).toBe(true);
  });

  it.each([
    'learn-english',
    'math-academy',
    'academy-online',
    'al-nour',
    'mo7amed-math',
    'english-with-sara',
    'ahmed-physics',
    'owner-123',
    'demo-school',
    'helpme',
    'statusquo',
    'webinar-hub',
    'home-page',
    'video-lessons',
    'ns3',
  ])('allows "%s"', (label) => {
    expect(isReservedSubdomain(label)).toBe(false);
  });

  it('every exact label is lowercase, unique and matches the subdomain format', () => {
    for (const list of [
      RESERVED_SUBDOMAINS,
      PLATFORM_LOOKALIKE_WORDS,
      SUBDOMAIN_FILLER_WORDS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe('database guard parity (migration atlas_is_reserved_subdomain)', () => {
  const sql = latestGuardSql();

  it('embeds the same exact reserved list', () => {
    const match = /ARRAY\[([\s\S]*?)\]::text\[\] AS reserved/.exec(sql);
    expect(match).not.toBeNull();
    const fromSql = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(fromSql).toEqual([...RESERVED_SUBDOMAINS]);
  });

  it('embeds the same look-alike and filler words', () => {
    const match = /'(\^[^']+\$)'::text AS lookalike/.exec(sql);
    expect(match).not.toBeNull();
    const groups = [...match![1].matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split('|'));
    // ^(F)*(L)(L|F)*$ — the first group is the fillers (plus digits), the
    // second the look-alike words.
    const fillers = groups[0].filter((w) => w !== '[0-9]+');
    const lookalikes = groups[1];
    expect([...fillers].sort()).toEqual([...SUBDOMAIN_FILLER_WORDS].sort());
    expect([...lookalikes].sort()).toEqual([...PLATFORM_LOOKALIKE_WORDS].sort());
  });

  it('applies the same impersonation and digit rules', () => {
    expect(sql).toContain("translate(replace(v, '-', ''), '013457', 'oleast')");
    expect(sql).toContain("translate(replace(v, '-', ''), '013457', 'oieast')");
    expect(sql).toMatch(/strpos\(j, 'atlas'\) > 0/);
    expect(sql).toMatch(/left\(j, 5\) = 'admin'/);
  });

  it('only refuses a label that changes, on both tables', () => {
    expect(sql).toMatch(/IF TG_OP = 'UPDATE' AND new_label IS NOT DISTINCT FROM/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF slug ON academies/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF subdomain ON subdomain_allocations/);
  });
});
