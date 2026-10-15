/**
 * `assertLocalDatabaseTarget` — the dev seed's production guard. It must
 * refuse production and any non-loopback database, keep local and CI
 * seeding working, and never echo a URL (it carries the password).
 */
import { assertLocalDatabaseTarget } from './local-database-guard';

const CI_URL = 'postgresql://atlas:ci-placeholder@localhost:5432/atlas_ci?schema=public';
const CI_APP_URL =
  'postgresql://atlas_app:ci-placeholder@localhost:5432/atlas_ci?schema=public';

describe('assertLocalDatabaseTarget', () => {
  it('allows the local and CI shapes (localhost, 127.0.0.1, ::1)', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) {
      const url = `postgresql://atlas:x@${host}:5432/atlas_dev`;
      expect(() =>
        assertLocalDatabaseTarget('seed', { NODE_ENV: 'development', DATABASE_URL: url }),
      ).not.toThrow();
    }
    expect(() =>
      assertLocalDatabaseTarget('seed', {
        NODE_ENV: 'test',
        DATABASE_URL: CI_URL,
        APP_DATABASE_URL: CI_APP_URL,
      }),
    ).not.toThrow();
    // NODE_ENV unset is a plain local shell.
    expect(() =>
      assertLocalDatabaseTarget('seed', { DATABASE_URL: CI_URL }),
    ).not.toThrow();
  });

  it('refuses NODE_ENV=production even against a local database', () => {
    expect(() =>
      assertLocalDatabaseTarget('seed', { NODE_ENV: 'production', DATABASE_URL: CI_URL }),
    ).toThrow(/NODE_ENV=production/);
  });

  it('refuses a remote DATABASE_URL and names only the host, never the password', () => {
    const remote = 'postgresql://atlas:sup3r-s3cret@db.example.com:5432/atlas';
    let message = '';
    try {
      assertLocalDatabaseTarget('seed', {
        NODE_ENV: 'development',
        DATABASE_URL: remote,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('db.example.com');
    expect(message).not.toContain('sup3r-s3cret');
  });

  it('refuses when only APP_DATABASE_URL is remote', () => {
    expect(() =>
      assertLocalDatabaseTarget('seed', {
        DATABASE_URL: CI_URL,
        APP_DATABASE_URL: 'postgresql://atlas_app:x@10.0.0.5:5432/atlas',
      }),
    ).toThrow(/APP_DATABASE_URL points at host "10.0.0.5"/);
  });

  it('refuses a host that merely starts with "localhost"', () => {
    expect(() =>
      assertLocalDatabaseTarget('seed', {
        DATABASE_URL: 'postgresql://atlas:x@localhost.attacker.example:5432/atlas',
      }),
    ).toThrow(/localhost\.attacker\.example/);
  });

  it('refuses a missing or unparsable DATABASE_URL', () => {
    expect(() => assertLocalDatabaseTarget('seed', {})).toThrow(/needs DATABASE_URL/);
    expect(() =>
      assertLocalDatabaseTarget('seed', { DATABASE_URL: 'not a url' }),
    ).toThrow(/not a valid URL/);
  });
});
