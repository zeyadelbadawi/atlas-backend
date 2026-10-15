/**
 * `assertLocalDatabaseTarget` — refuse to run a destructive developer
 * script (the dev seed) anywhere but a local or CI database.
 *
 * `prisma/seed.ts` upserts a whole fixture graph, including a Platform
 * Owner, with one fixed, publicly known dev password. Pointed at a real
 * database by a mistyped `.env`, it would plant known-password accounts,
 * so it must refuse rather than trust the operator. Two independent
 * signals, either of which refuses:
 *   - `NODE_ENV=production`, the same check `prepare-journey-fixtures.ts`
 *     makes;
 *   - any configured database URL whose host is not loopback, the same
 *     rule `scripts/e2e-local-stack.sh` (`guard_local`) applies. Local
 *     development (`.env.example`) and CI (`backend-ci.yml`) both use
 *     `localhost`.
 *
 * There is deliberately no override flag: a local database is always
 * reachable on loopback. Error messages name only the host, never the
 * URL, because the URL carries the database password.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The URLs the seed connects with; unset optional ones are skipped. */
const DATABASE_URL_KEYS = ['DATABASE_URL', 'APP_DATABASE_URL'] as const;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function assertLocalDatabaseTarget(
  scriptName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(`${scriptName} refuses to run with NODE_ENV=production.`);
  }
  if (!env.DATABASE_URL) {
    throw new Error(`${scriptName} needs DATABASE_URL (a local or CI database).`);
  }
  for (const key of DATABASE_URL_KEYS) {
    const url = env[key];
    if (!url) continue;
    const host = hostOf(url);
    if (host === null) {
      throw new Error(`${scriptName} refuses to run: ${key} is not a valid URL.`);
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `${scriptName} refuses to run: ${key} points at host "${host}", ` +
          'not a local or CI database (localhost / 127.0.0.1 / ::1).',
      );
    }
  }
}
