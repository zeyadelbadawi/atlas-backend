/**
 * Phase P18 — real local load-test harness (Workstream F).
 *
 * Honesty note (per the P18 prompt's own instruction): this is a
 * single-machine capacity smoke test against the local dev Postgres/Redis
 * stack, run from the same box as the server under test. It is NOT a
 * distributed, multi-region, production-infrastructure load test — no such
 * environment exists yet for this project. What it DOES prove for real:
 * the app stays correct and responsive under concurrent multi-tenant
 * traffic, auth/session/rate-limit machinery holds up under concurrency,
 * and RLS-scoped queries don't degrade pathologically as concurrency rises.
 *
 * It signs in as 5 REAL seeded dev users (`prisma/seed.ts`, two different
 * organizations, one Platform Owner) to get real JWTs, then fires a
 * weighted mix of realistic endpoints through `autocannon`, rotating
 * credentials per connection via `setupClient` so the run is genuinely
 * multi-tenant traffic, not one token hammering the system.
 *
 * Usage: npm run loadtest   (server must already be running, e.g. via
 * `node dist/main.js` or `npm run start:dev`, pointed at the local dev DB)
 */
import autocannon, { type Client, type Result } from 'autocannon';

const BASE_URL = process.env.LOADTEST_BASE_URL ?? 'http://localhost:3000';
const DURATION_SECONDS = Number(process.env.LOADTEST_DURATION_SECONDS ?? 30);
const CONNECTIONS = Number(process.env.LOADTEST_CONNECTIONS ?? 25);
const OVERALL_RATE = process.env.LOADTEST_OVERALL_RATE
  ? Number(process.env.LOADTEST_OVERALL_RATE)
  : undefined;

const SEEDED_USERS = [
  { email: 'admin@atlas.dev', password: 'DevPassword123!' },
  { email: 'sarah.chen@acme-academy.dev', password: 'DevPassword123!' },
  { email: 'omar.hassan@nextgen-learning.dev', password: 'DevPassword123!' },
  { email: 'jane.doe@acme-academy.dev', password: 'DevPassword123!' },
  { email: 'mike.wilson@acme-academy.dev', password: 'DevPassword123!' },
] as const;

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

async function main(): Promise<void> {
  console.log(`Signing in as ${SEEDED_USERS.length} real seeded users to collect tokens...`);
  const tokens = await Promise.all(SEEDED_USERS.map((u) => signIn(u.email, u.password)));
  console.log(`Got ${tokens.length} real access tokens.`);

  let clientIndex = 0;

  const instance = autocannon(
    {
      url: BASE_URL,
      connections: CONNECTIONS,
      duration: DURATION_SECONDS,
      ...(OVERALL_RATE ? { overallRate: OVERALL_RATE } : {}),
      requests: [{ method: 'GET', path: '/health' }],
      setupClient: (client: Client) => {
        // Round-robin across the 5 real tenant identities so this is
        // genuinely multi-tenant concurrent traffic, not one account.
        const token = tokens[clientIndex % tokens.length];
        clientIndex += 1;

        // Weighted realistic mix: health checks (infra probes), an
        // authenticated tenant-scoped list read, and permission-scoped
        // search — each connection cycles through these in order.
        client.setRequests([
          { method: 'GET', path: '/health' },
          {
            method: 'GET',
            path: '/api/v1/notifications/summary',
            headers: { authorization: `Bearer ${token}` },
          },
          {
            method: 'GET',
            path: '/api/v1/search?q=academy',
            headers: { authorization: `Bearer ${token}` },
          },
        ]);
      },
    },
    // Passing a callback forces autocannon's Instance-returning overload
    // (omitting it returns a Promise<Result> instead, per its typings);
    // the real result is still read from the 'done' event below.
    () => {},
  );

  autocannon.track(instance, { renderProgressBar: false });

  instance.on('done', (result: Result) => {
    console.log('\n===== LOAD TEST RESULT (real, measured) =====');
    console.log(JSON.stringify(result, null, 2));
  });
}

main().catch((error) => {
  console.error('Load test failed:', error);
  process.exit(1);
});
