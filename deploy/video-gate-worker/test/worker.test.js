/**
 * Unit tests for the video gate Worker — THIS source, run under Node's own
 * test runner (`node --test`), with no dependencies and no network.
 *
 * What is real: `src/index.js`, `src/gate.js` and `src/authz.js`, exactly
 * as deployed, on Node's Web Crypto / fetch / Response globals.
 * What is faked: the R2 binding (an in-memory object store) and Atlas's
 * `POST /video-gate/authorize` (a stub `fetch` that verifies the Worker's
 * HMAC exactly as `VideoGateAuthorizationService.verifyCaller` does and
 * answers from a mutable revocation state). Time is simulated by replacing
 * `Date.now`.
 *
 * What this cannot prove (see README "Local validation"): Cloudflare's
 * real isolate lifecycle, real R2, real egress to the API.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import worker from '../src/index.js';
import {
  AUTHZ_MAX_CACHE_SECONDS,
  DecisionCache,
  authorizeWithAtlas,
  cacheWindowSeconds,
} from '../src/authz.js';

const SIGNING_SECRET = 'worker-test-signing-secret-not-real';
const AUTHZ_SECRET = 'worker-test-authz-secret-0123456789abcdef';
const AUTHZ_URL = 'https://api.atlas.test/api/v1/video-gate/authorize';
const ACADEMY = 'a-0001';
const OTHER_ACADEMY = 'a-0002';
const COURSE = 'c-0001';
const OTHER_COURSE = 'c-0002';
const KEY = `academies/${ACADEMY}/courses/${COURSE}/asset-1.mp4`;
const OTHER_COURSE_KEY = `academies/${ACADEMY}/courses/${OTHER_COURSE}/asset-2.mp4`;
const OTHER_ACADEMY_KEY = `academies/${OTHER_ACADEMY}/courses/c-0009/asset-3.mp4`;
const BYTES = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
const realNow = Date.now;
let nowMs = 1_800_000_000_000;
function advance(seconds) {
  nowMs += seconds * 1000;
}

// ---------------------------------------------------------------------------
// Fake Atlas (`VideoGateAuthorizationService`, reduced to its decisions)
// ---------------------------------------------------------------------------
const atlas = {
  revokedSessions: new Set(),
  revokedDevices: new Set(),
  deletedUsers: new Set(),
  /** 'up' | 'down' (network error) | 'error' (500) | 'hang' (never answers) */
  mode: 'up',
  calls: 0,
  rejectedCalls: 0,
};

function decide(token, objectKey) {
  const [payload, signature] = token.split('.');
  const expected = createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  if (expected !== signature) return { allow: false, reason: 'invalid_token' };
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (claims.e * 1000 <= nowMs) return { allow: false, reason: 'invalid_token' };
  if (claims.k !== objectKey) return { allow: false, reason: 'key_mismatch' };
  if (!claims.a || !claims.c || !claims.l) return { allow: false, reason: 'unscoped_token' };
  if (!objectKey.startsWith(`academies/${claims.a}/`)) {
    return { allow: false, reason: 'academy_mismatch' };
  }
  const course = /^academies\/[^/]+\/courses\/([^/]+)\//.exec(objectKey);
  if (course && course[1] !== claims.c) return { allow: false, reason: 'course_mismatch' };
  if (atlas.deletedUsers.has(claims.u)) return { allow: false, reason: 'account_inactive' };
  if (atlas.revokedSessions.has(claims.s)) return { allow: false, reason: 'session_revoked' };
  if (atlas.revokedDevices.has(claims.d)) return { allow: false, reason: 'device_revoked' };
  return { allow: true };
}

async function fakeAtlasFetch(url, init) {
  assert.equal(url, AUTHZ_URL);
  assert.equal(init.method, 'POST');
  atlas.calls += 1;
  if (atlas.mode === 'down') throw new TypeError('fetch failed');
  if (atlas.mode === 'hang') {
    // Node's `AbortSignal.timeout` timer is unref'd; hold the event loop
    // open until it fires, as a real pending socket would.
    const keepAlive = setInterval(() => {}, 1000);
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        reject(init.signal.reason);
      });
    });
  }
  if (atlas.mode === 'error') return new Response('{}', { status: 500 });
  // Caller authentication, exactly as the API checks it.
  const timestamp = init.headers['x-atlas-gate-timestamp'];
  const signature = init.headers['x-atlas-gate-signature'];
  const expected = createHmac('sha256', AUTHZ_SECRET)
    .update(`${timestamp}.${init.body}`)
    .digest('hex');
  const fresh = Math.abs(nowMs / 1000 - Number(timestamp)) <= 60;
  if (
    !fresh ||
    typeof signature !== 'string' ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    atlas.rejectedCalls += 1;
    return new Response('{}', { status: 401 });
  }
  const { token, objectKey } = JSON.parse(init.body);
  const decision = decide(token, objectKey);
  return Response.json({ ...decision, ttlSeconds: AUTHZ_MAX_CACHE_SECONDS });
}

// ---------------------------------------------------------------------------
// Fake R2 binding
// ---------------------------------------------------------------------------
const bucket = {
  objects: new Map([
    [KEY, BYTES],
    [OTHER_COURSE_KEY, BYTES],
    [OTHER_ACADEMY_KEY, BYTES],
  ]),
  async head(key) {
    const body = this.objects.get(key);
    return body
      ? { size: body.length, httpMetadata: { contentType: 'video/mp4' }, httpEtag: '"e1"' }
      : null;
  },
  async get(key, options) {
    const body = this.objects.get(key);
    if (!body) return null;
    const range = options && options.range;
    return {
      body: range ? body.slice(range.offset, range.offset + range.length) : body,
    };
  },
};

function env(overrides = {}) {
  return {
    GATE_SIGNING_SECRET: SIGNING_SECRET,
    GATE_AUTHZ_SECRET: AUTHZ_SECRET,
    ATLAS_AUTHZ_URL: AUTHZ_URL,
    VIDEO_BUCKET: bucket,
    ALLOWED_ORIGINS: '',
    ENFORCE_ORIGIN: 'true',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tokens, minted the way `BasicVideoProvider.issuePlaybackToken` mints them
// ---------------------------------------------------------------------------
let serial = 0;
function mint(overrides = {}, secret = SIGNING_SECRET) {
  serial += 1;
  const claims = {
    k: KEY,
    e: Math.floor(nowMs / 1000) + 600,
    u: `user-${serial}`,
    s: `session-${serial}`,
    d: `device-${serial}`,
    a: ACADEMY,
    c: COURSE,
    l: 'lesson-1',
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return { token: `${payload}.${signature}`, claims };
}

function play(token, { key = KEY, range, workerEnv = env(), method = 'GET' } = {}) {
  const url = `https://video.atlas.test/v/${encodeURIComponent(key)}?t=${token}`;
  const headers = range ? { Range: range } : {};
  return worker.fetch(new Request(url, { method, headers }), workerEnv);
}

const denyOf = (response) => response.headers.get('x-atlas-gate-deny');

beforeEach(() => {
  Date.now = () => nowMs;
  globalThis.__realFetch ??= globalThis.fetch;
  globalThis.fetch = fakeAtlasFetch;
  atlas.revokedSessions.clear();
  atlas.revokedDevices.clear();
  atlas.deletedUsers.clear();
  atlas.mode = 'up';
  atlas.calls = 0;
  atlas.rejectedCalls = 0;
  // Every test starts well clear of the previous one's cache windows.
  advance(3600);
});

afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = globalThis.__realFetch;
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
test('a valid, unrevoked token plays — whole object and a ranged seek', async () => {
  const { token } = mint();
  const full = await play(token);
  assert.equal(full.status, 200);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), BYTES);
  assert.equal(full.headers.get('cache-control'), 'private, no-store');

  const ranged = await play(token, { range: 'bytes=100-199' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), BYTES.slice(100, 200));
  // One authorization call served both requests (cache), and it was signed.
  assert.equal(atlas.calls, 1);
  assert.equal(atlas.rejectedCalls, 0);
});

test('concurrent range requests on a cold cache share one authorization call', async () => {
  const { token } = mint();
  const responses = await Promise.all(
    [0, 1, 2, 3].map((i) => play(token, { range: `bytes=${i * 100}-${i * 100 + 99}` })),
  );
  for (const response of responses) assert.equal(response.status, 206);
  assert.equal(atlas.calls, 1);
});

// ---------------------------------------------------------------------------
// Expiry and binding — decided by gate.js before Atlas is asked
// ---------------------------------------------------------------------------
test('an expired token is refused without asking Atlas', async () => {
  const { token } = mint({ e: Math.floor(nowMs / 1000) - 1 });
  const response = await play(token);
  assert.equal(response.status, 403);
  assert.equal(denyOf(response), 'expired');
  assert.equal(atlas.calls, 0);
});

test('a token that expires while cached is refused at its expiry, not at the end of the cache window', async () => {
  const { token } = mint({ e: Math.floor(nowMs / 1000) + 10 });
  assert.equal((await play(token)).status, 200);
  advance(11);
  const response = await play(token);
  assert.equal(denyOf(response), 'expired');
});

test('cross-course reuse: a token for one course’s video cannot fetch another course’s video', async () => {
  const { token } = mint();
  const response = await play(token, { key: OTHER_COURSE_KEY });
  assert.equal(response.status, 403);
  assert.equal(denyOf(response), 'key_mismatch');
  assert.equal(atlas.calls, 0);
});

test('cross-academy reuse: a token for one academy cannot fetch another academy’s video', async () => {
  const { token } = mint();
  const response = await play(token, { key: OTHER_ACADEMY_KEY });
  assert.equal(denyOf(response), 'key_mismatch');
  assert.equal(atlas.calls, 0);
});

test('re-scoping is impossible: editing the academy or course claim breaks the signature', async () => {
  const { token } = mint();
  const [payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  for (const edit of [{ a: OTHER_ACADEMY }, { c: OTHER_COURSE }, { k: OTHER_COURSE_KEY }]) {
    const forged = Buffer.from(JSON.stringify({ ...claims, ...edit })).toString('base64url');
    const response = await play(`${forged}.${signature}`, {
      key: edit.k ?? KEY,
    });
    assert.equal(denyOf(response), 'bad_signature');
  }
  assert.equal(atlas.calls, 0);
});

test('a genuinely signed token whose scope names another academy or course is refused by Atlas', async () => {
  // Defence in depth: Atlas cross-checks the signed scope against the key.
  const wrongAcademy = mint({ a: OTHER_ACADEMY });
  const response = await play(wrongAcademy.token);
  assert.equal(response.status, 403);
  assert.equal(denyOf(response), 'revoked');
  const wrongCourse = mint({ c: OTHER_COURSE });
  assert.equal(denyOf(await play(wrongCourse.token)), 'revoked');
});

// ---------------------------------------------------------------------------
// Revocation — within the bound
// ---------------------------------------------------------------------------
for (const [label, revoke] of [
  ['session (sign-out / revoke-session / takeover)', (c) => atlas.revokedSessions.add(c.s)],
  ['device (device removed)', (c) => atlas.revokedDevices.add(c.d)],
  ['account (account deleted)', (c) => atlas.deletedUsers.add(c.u)],
]) {
  test(`revoked ${label}: refused within ${AUTHZ_MAX_CACHE_SECONDS} s, at every request after`, async () => {
    const { token, claims } = mint();
    assert.equal((await play(token)).status, 200);
    revoke(claims);
    // Inside the window the cached allow may still serve — that IS the bound.
    advance(AUTHZ_MAX_CACHE_SECONDS - 1);
    assert.equal((await play(token, { range: 'bytes=0-9' })).status, 206);
    // At the bound, the next request asks again and is refused.
    advance(1);
    const refused = await play(token, { range: 'bytes=10-19' });
    assert.equal(refused.status, 403);
    assert.equal(denyOf(refused), 'revoked');
    // A replay of the very same URL stays refused, cached or not.
    assert.equal(denyOf(await play(token)), 'revoked');
    advance(AUTHZ_MAX_CACHE_SECONDS + 1);
    assert.equal(denyOf(await play(token)), 'revoked');
  });
}

test('a token first presented AFTER its session was revoked is refused immediately', async () => {
  const { token, claims } = mint();
  atlas.revokedSessions.add(claims.s);
  const response = await play(token);
  assert.equal(denyOf(response), 'revoked');
  // HEAD is gated identically.
  assert.equal(denyOf(await play(token, { method: 'HEAD' })), 'revoked');
});

test('AUTHZ_CACHE_TTL_SECONDS=0 asks Atlas on every request: revocation is immediate', async () => {
  const workerEnv = env({ AUTHZ_CACHE_TTL_SECONDS: '0' });
  const { token, claims } = mint();
  assert.equal((await play(token, { workerEnv })).status, 200);
  atlas.revokedSessions.add(claims.s);
  assert.equal(denyOf(await play(token, { workerEnv })), 'revoked');
  assert.equal(atlas.calls, 2);
});

test('the cache window can be shortened but never lengthened past 30 s', () => {
  assert.equal(cacheWindowSeconds({}), 30);
  assert.equal(cacheWindowSeconds({ AUTHZ_CACHE_TTL_SECONDS: '10' }), 10);
  assert.equal(cacheWindowSeconds({ AUTHZ_CACHE_TTL_SECONDS: '3600' }), 30);
  assert.equal(cacheWindowSeconds({ AUTHZ_CACHE_TTL_SECONDS: '-5' }), 0);
  assert.equal(cacheWindowSeconds({ AUTHZ_CACHE_TTL_SECONDS: 'nonsense' }), 30);
});

test('Atlas cannot widen the window either: a ttlSeconds above 30 is clamped', async () => {
  const cache = new DecisionCache();
  const { token, claims } = mint();
  const generous = async () => Response.json({ allow: true, ttlSeconds: 86400 });
  const verdict = await authorizeWithAtlas({
    token,
    objectKey: KEY,
    claims,
    env: env(),
    cache,
    nowMs,
    fetchImpl: generous,
  });
  assert.equal(verdict.ok, true);
  const entry = cache.entries.get(`${KEY}\n${token}`);
  assert.equal(entry.expiresAtMs - nowMs, AUTHZ_MAX_CACHE_SECONDS * 1000);
});

test('the decision cache is bounded in size', () => {
  const cache = new DecisionCache(3);
  for (let i = 0; i < 10; i += 1) {
    cache.set(`k${i}`, { allow: true, reason: null, expiresAtMs: nowMs + 1000 });
  }
  assert.equal(cache.entries.size, 3);
  assert.deepEqual([...cache.entries.keys()], ['k7', 'k8', 'k9']);
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------
for (const mode of ['down', 'error', 'hang']) {
  test(`Atlas ${mode}: refused 503 authz_unavailable, nothing cached, recovers on the next request`, async () => {
    const workerEnv = env({ AUTHZ_TIMEOUT_MS: '20' });
    const { token } = mint();
    atlas.mode = mode;
    const refused = await play(token, { workerEnv });
    assert.equal(refused.status, 503);
    assert.equal(denyOf(refused), 'authz_unavailable');
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    atlas.mode = 'up';
    assert.equal((await play(token, { workerEnv })).status, 200);
  });
}

test('no stale authorization: once a positive answer’s window closes, an Atlas outage refuses', async () => {
  const { token } = mint();
  assert.equal((await play(token)).status, 200);
  atlas.mode = 'down';
  advance(AUTHZ_MAX_CACHE_SECONDS);
  assert.equal(denyOf(await play(token)), 'authz_unavailable');
});

test('a Worker whose authorization secret does not match Atlas’s is refused by Atlas, and fails closed', async () => {
  const { token } = mint();
  const response = await play(token, {
    workerEnv: env({ GATE_AUTHZ_SECRET: 'some-other-secret-0123456789abcdefgh' }),
  });
  assert.equal(response.status, 503);
  assert.equal(denyOf(response), 'authz_unavailable');
  assert.equal(atlas.rejectedCalls, 1);
});

test('missing or non-HTTPS authorization settings refuse every request (gate_misconfigured)', async () => {
  for (const overrides of [
    { ATLAS_AUTHZ_URL: undefined },
    { GATE_AUTHZ_SECRET: undefined },
    { ATLAS_AUTHZ_URL: 'http://api.atlas.test/api/v1/video-gate/authorize' },
  ]) {
    const response = await play(mint().token, { workerEnv: env(overrides) });
    assert.equal(response.status, 503);
    assert.equal(denyOf(response), 'gate_misconfigured');
  }
  assert.equal(atlas.calls, 0);
});

test('the Worker never logs the token', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const { token, claims } = mint();
    atlas.revokedSessions.add(claims.s);
    await play(token);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(!line.includes(token.split('.')[1]));
    assert.match(lines.at(-1), /"detail":"session_revoked"/);
  } finally {
    console.log = original;
  }
});
