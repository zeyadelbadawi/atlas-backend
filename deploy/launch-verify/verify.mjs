/**
 * Atlas — Launch Stabilization (Plan A + A6) production verification.
 * docs/ATLAS_LAUNCH_STABILIZATION_PLAN.md §15–§16. Driven by the
 * `Launch verify` workflow; talks to the REAL public hosts (Cloudflare →
 * Caddy → backend), exactly as a browser does.
 *
 *   MODE=api      A6 (OTP + academy-scoped trust), A1 (surface refusals),
 *                 A4 (existing account joins another academy), A5
 *                 (scoped /users/me), A3 (password change ends sessions),
 *                 observability (metrics + audit).
 *   MODE=browser  Management sign-in with the email-code UI → dashboard;
 *                 academy website sign-in with the email-code UI → /my;
 *                 uncaught runtime errors captured on every page.
 *   MODE=smi      Smart academy join (generic 401s, join → emailed code →
 *                 session) and the member lookup's refusals; its metric.
 *   MODE=smi-browser  "Join with it" on Academy B's sign-up → password →
 *                 B's code → /my (EN desktop, AR mobile).
 *   MODE=deliverability  Email deliverability facts: sending domain DNS
 *                 (SPF, DKIM, DMARC, Public Suffix List), Brevo domain /
 *                 sender / plan and 7-day aggregates. Read-only.
 *   (docs/SMART_MEMBER_INVITE_AND_ACADEMY_JOIN.md; separate jobs because
 *   the emailed-code step shares the per-IP sign-in budget.)
 *
 * Test accounts are plus-addresses of the owner's own mailbox
 * (<mailbox>+atlas-lsv-<run>-<tag>@gmail.com) and are only ever ADDED as
 * learners / plain accounts — no academy or organization is created, nothing
 * is deleted. Sign-in codes come from remote.sh over the deploy identity and
 * are never printed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE || 'api';
const MGMT = process.env.MGMT_HOST || 'atlass.dpdns.org';
const MAILBOX = process.env.MAILBOX;
const RUN = process.env.RUN_TAG || String(Date.now());
const OUT = process.env.OUT || path.join(here, 'out');
if (!MAILBOX || !/^[a-z0-9._-]+$/.test(MAILBOX)) throw new Error('MAILBOX must be a Gmail local part');
mkdirSync(OUT, { recursive: true });
// Production is always https on the default port; a local dry run overrides both.
const ORIGIN = (host) => `${process.env.SCHEME || 'https'}://${host}${process.env.PORT_SUFFIX || ''}`;
const mail = (tag) => `${MAILBOX}+atlas-lsv-${RUN}-${tag}@gmail.com`;
const password = () => `Lsv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// --- server-side facts --------------------------------------------------------
function remote(...args) {
  // Local dry run only: a shim with the same commands against a local database.
  if (process.env.REMOTE_LOCAL_SCRIPT) {
    return execFileSync('bash', [process.env.REMOTE_LOCAL_SCRIPT, ...args]).toString().trim();
  }
  return execFileSync(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=accept-new', '-i', process.env.SSH_KEY_FILE,
      `${process.env.DEPLOY_USER}@${process.env.DEPLOY_HOST}`,
      `f=$(mktemp); cat > "$f"; bash "$f" ${args.map((a) => `'${a}'`).join(' ')} </dev/null; rc=$?; rm -f "$f"; exit $rc`,
    ],
    { input: readFileSync(path.join(here, 'remote.sh')) },
  ).toString().trim();
}
const facts = (...args) =>
  Object.fromEntries(remote(...args).split('\n').filter(Boolean).map((l) => {
    const [k, ...v] = l.split('|');
    return [k, v.join('|')];
  }));
async function code(email, previous) {
  for (let i = 0; i < 20; i += 1) {
    const c = remote('otp', email);
    if (/^\d{4,8}$/.test(c) && c !== previous) return c;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('no sign-in code arrived');
}

// --- reporting ----------------------------------------------------------------
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${MODE}] ${name}${detail ? ` — ${detail}` : ''}`);
};
const info = (msg) => console.log(`INFO  [${MODE}] ${msg}`);

// --- HTTP against the public hosts --------------------------------------------
async function call(host, method, p, { body, token, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = `atlas_trust=${encodeURIComponent(cookie)}`;
  const r = await fetch(`${ORIGIN(host)}/api/v1${p}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const trust = (r.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith('atlas_trust='));
  return {
    status: r.status,
    body: json,
    key: json?.error?.messageKey ?? '',
    trustCookie: trust ? decodeURIComponent(trust.split(';')[0].slice('atlas_trust='.length)) : null,
  };
}
const signIn = (host, email, pw, extra = {}, cookie) =>
  call(host, 'POST', '/auth/sign-in', { body: { email, password: pw, ...extra }, cookie });
const verify = (host, challengeId, c, rememberDevice, surface) =>
  call(host, 'POST', '/auth/otp/verify', { body: { challengeId, code: c, rememberDevice, surface } });

// ==============================================================================
async function apiMode() {
  const rel = facts('release');
  info(`backend image ${rel.backend_image}, started ${rel.backend_started}`);
  check('health: app + database + redis up', /^200 /.test(rel.health) && /"database":\{"status":"up"/.test(rel.health) && /"redis":\{"status":"up"/.test(rel.health), rel.health.slice(0, 160));
  check('migration 20261018000000_trusted_device_academy_scope applied', rel.migration === 'applied', rel.migration);
  check('trusted_devices.academy_id column + index exist', rel.column === 'text' && rel.index === '1', `${rel.column}/${rel.index}`);
  check('no pending/failed migrations', rel.pending_or_failed_migrations === '0', rel.pending_or_failed_migrations);
  check('no fatal/error log lines in the last 30m', rel.log_fatal_lines_30m === '0' && rel.log_error_lines_30m === '0', `error=${rel.log_error_lines_30m} fatal=${rel.log_fatal_lines_30m}`);
  info(`legacy academy trust rows (no academy, still live — fail closed by design): ${rel.legacy_academy_trust_live}; live management trust rows (unchanged): ${rel.management_trust_live}`);

  const acad = remote('academies').split('\n').filter(Boolean).map((l) => l.split('|'));
  if (acad.length < 2) { check('two open academies with a published website exist', false, `found ${acad.length}`); return; }
  const [A, B] = acad.map(([, id, host]) => ({ id, host }));
  info(`Academy A ${A.id} @ ${A.host}; Academy B ${B.id} @ ${B.host}`);

  // ---- learner L: new account at A --------------------------------------------
  const L = mail('l');
  const pw = password();
  let r = await call(A.host, 'POST', '/auth/register', { body: { name: 'Launch Verify', email: L, password: pw, academyId: A.id } });
  check('A4 new learner registers at Academy A → {account:new}', r.status === 201 && r.body?.account === 'new', `${r.status} ${r.key}`);

  // A6: password → code; wrong context refused; right context → session + trust.
  r = await signIn(A.host, L, pw, { surface: 'academy', academyId: A.id });
  check('A6 Academy A sign-in asks for an emailed code (no session yet)', r.status === 200 && r.body?.emailOtpRequired === true && !r.body?.accessToken, `${r.status}`);
  const chA = r.body?.challengeId;
  const cA = await code(L);
  r = await verify(B.host, chA, cA, false, 'academy');
  check('A6 Academy A code is refused on Academy B (generic, no session)', r.status === 401 && r.key === 'errors.auth.otpInvalid' && !r.body?.accessToken, `${r.status} ${r.key}`);
  r = await verify(MGMT, chA, cA, false, 'management');
  check('A6 Academy A code is refused on management (generic, no session)', r.status === 401 && r.key === 'errors.auth.otpInvalid' && !r.body?.accessToken, `${r.status} ${r.key}`);
  r = await verify(A.host, chA, cA, true, 'academy');
  check('A6 the same code works on Academy A and remembers the browser', r.status === 200 && !!r.body?.accessToken && !!r.trustCookie, `${r.status}`);
  const sA = r.body?.accessToken;
  const trustA = r.trustCookie;
  let f = facts('user', L, A.id, B.id);
  check('A6 trust row is scoped to Academy A', f.trust_A_live === '1' && f.trust_B_live === '0' && f.trust_null_academy === '0', `A=${f.trust_A_live} B=${f.trust_B_live} null=${f.trust_null_academy}`);
  check('A6 context mismatches are audited', Number(f.otp_context_mismatch_audit) >= 2, f.otp_context_mismatch_audit);

  const otpBefore = Number(f.otp_outbox);
  r = await signIn(A.host, L, pw, { surface: 'academy', academyId: A.id }, trustA);
  f = facts('user', L, A.id, B.id);
  check('A6 remembered browser skips the code on the SAME academy', r.status === 200 && !!r.body?.accessToken && Number(f.otp_outbox) === otpBefore, `${r.status} otp ${otpBefore}→${f.otp_outbox}`);

  // ---- A4: the same person joins Academy B with the same password -------------
  r = await call(B.host, 'POST', '/auth/register', { body: { name: 'Launch Verify', email: L, password: pw, academyId: B.id } });
  check('A4 existing account joins Academy B → {account:existing}', r.status === 201 && r.body?.account === 'existing', `${r.status} ${r.key}`);
  f = facts('user', L, A.id, B.id);
  check('A4 one user row, learner rows at A and B', f.users === '1' && f.learner_rows === '2' && f.learner_A !== '-' && f.learner_B !== '-', `users=${f.users} rows=${f.learner_rows} A=${f.learner_A} B=${f.learner_B}`);
  check('A4 security notification queued (account.academy.joined)', Number(f.joined_notice) >= 1, f.joined_notice);

  // ---- A6: A's trusted browser does not skip B's code ------------------------
  r = await signIn(B.host, L, pw, { surface: 'academy', academyId: B.id }, trustA);
  check("A6 Academy A's remembered browser does NOT skip Academy B's code", r.status === 200 && r.body?.emailOtpRequired === true && !r.body?.accessToken, `${r.status}`);
  const cB = await code(L, cA);
  r = await verify(B.host, r.body?.challengeId, cB, false, 'academy');
  check('A6 Academy B code works on Academy B', r.status === 200 && !!r.body?.accessToken, `${r.status}`);
  const sB = r.body?.accessToken;

  // ---- A5 ----------------------------------------------------------------------
  r = await call(B.host, 'GET', '/users/me', { token: sB });
  const ids = (r.body?.academies ?? []).map((x) => x.academyId);
  check('A5 academy /users/me exposes only the current academy, no organizations', r.status === 200 && ids.length === 1 && ids[0] === B.id && (r.body?.organizations ?? []).length === 0 && (r.body?.organizationMemberships ?? []).length === 0, `academies=${ids.length} orgs=${(r.body?.organizations ?? []).length}`);

  // ---- A1 ----------------------------------------------------------------------
  r = await call(MGMT, 'GET', `/academies/${A.id}`, { token: sB });
  check('A1 academy session refused on a management endpoint', r.status === 403 && r.key === 'errors.auth.managementSurfaceOnly', `${r.status} ${r.key}`);
  r = await call(MGMT, 'GET', '/platform/announcements', { token: sB });
  check('A1 academy session refused on a Platform Owner endpoint', r.status === 403, `${r.status} ${r.key}`);
  r = await call(MGMT, 'GET', '/users/me/deletion-plan', { token: sB });
  check('A1 academy session refused on account deletion', r.status === 403 && r.key === 'errors.auth.managementSurfaceOnly', `${r.status} ${r.key}`);
  r = await call(A.host, 'GET', '/learning/overview', { token: sB });
  check("A1 Academy B session refused on Academy A's learner endpoint", r.status === 403 && r.key === 'errors.auth.academyHostMismatch', `${r.status} ${r.key}`);
  r = await call(B.host, 'GET', '/learning/overview', { token: sB });
  check('A1 the same session still works on its own academy', r.status === 200, `${r.status}`);

  // ---- A6: a revoked trust requires the code again ----------------------------
  r = await call(A.host, 'GET', '/auth/trusted-devices', { token: sA, cookie: trustA });
  const items = r.body?.items ?? [];
  const devA = items.find((d) => d.current) ?? items.find((d) => d.surface === 'academy');
  if (devA) {
    const del = await call(A.host, 'DELETE', `/auth/trusted-devices/${devA.id}`, { token: sA });
    r = await signIn(A.host, L, pw, { surface: 'academy', academyId: A.id }, trustA);
    check('A6 a revoked trusted browser is asked for the code again', del.status < 300 && r.status === 200 && r.body?.emailOtpRequired === true, `${del.status}/${r.status}`);
  } else {
    check('A6 trusted device listed for revocation', false, `${r.status} items=${(r.body?.items ?? []).length}`);
  }

  // ---- A3: password change ends every session ---------------------------------
  const pw2 = password();
  r = await call(A.host, 'POST', '/users/me/password', { token: sA, body: { currentPassword: pw, newPassword: pw2 } });
  const after = [await call(A.host, 'GET', '/users/me', { token: sA }), await call(B.host, 'GET', '/users/me', { token: sB })];
  check('A3 password change ends every session immediately (both academies)', r.status === 200 && after.every((x) => x.status === 401), `${r.status} → ${after.map((x) => x.status).join('/')}`);
  f = facts('user', L, A.id, B.id);
  check('A3 revocation audited (auth.sessions.revoked, password_change)', /password_change:\d+/.test(f.revocation_audit), f.revocation_audit);
  check('A3 every trusted browser revoked', f.trust_live_total === '0', f.trust_live_total);

  // ---- A4 with a management account ---------------------------------------------
  const M = mail('m');
  const mpw = password();
  r = await call(MGMT, 'POST', '/auth/register', { body: { name: 'Launch Verify Staff', email: M, password: mpw } });
  check('management account registers', r.status === 201 && r.body?.account === 'new', `${r.status} ${r.key}`);
  const before = facts('user', M, A.id, B.id);
  r = await call(A.host, 'POST', '/auth/register', { body: { name: 'Launch Verify Staff', email: M, password: mpw, academyId: A.id } });
  const afterM = facts('user', M, A.id, B.id);
  check('A4 management account becomes a learner at A without a duplicate user; memberships unchanged', r.status === 201 && r.body?.account === 'existing' && afterM.users === '1' && afterM.learner_A !== '-' && afterM.org_memberships === before.org_memberships, `${r.status} users=${afterM.users} memberships ${before.org_memberships}→${afterM.org_memberships}`);

  // ---- observability -----------------------------------------------------------
  await new Promise((res) => setTimeout(res, 40000)); // one Prometheus scrape (30s)
  const m = facts('metrics');
  info(`atlas_auth_surface_denied_total: ${m.surface_denied}`);
  info(`atlas_auth_sessions_revoked_total: ${m.sessions_revoked}`);
  check('metrics: surface denials recorded per reason', ['management_route', 'platform_owner_route', 'account_action', 'academy_host_mismatch'].every((reason) => new RegExp(`${reason}=\\d`).test(m.surface_denied)), m.surface_denied);
  check('metrics: session revocation recorded (password_change)', /password_change=\d/.test(m.sessions_revoked), m.sessions_revoked);
}

// ==============================================================================
async function browserMode() {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const acad = remote('academies').split('\n').filter(Boolean).map((l) => l.split('|'));
  const A = { id: acad[0][1], host: acad[0][2] };
  const B = acad[1] ? { id: acad[1][1], host: acad[1][2] } : null;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  async function page(tag, { mobile = false, ar = false } = {}) {
    const ctx = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, locale: ar ? 'ar' : 'en-US',
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${tag}: ${e.message.slice(0, 160)}`));
    return { ctx, p };
  }
  const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
  async function accept(p) {
    const b = p.getByRole('button', { name: /accept all|قبول الكل/i });
    if (await b.count()) await b.first().click().catch(() => {});
  }
  async function uiSignIn(p, email, pw, signInUrl, landing) {
    await p.goto(signInUrl); await p.waitForLoadState('networkidle'); await accept(p);
    await p.fill('#email', email); await p.fill('#password', pw); await p.press('#password', 'Enter');
    await p.locator('#email-otp-code').waitFor({ timeout: 25000 });
    check(`${landing}: email-code screen shown after the password`, true);
    await p.fill('#email-otp-code', await code(email)); await p.press('#email-otp-code', 'Enter');
    await p.waitForURL((u) => !/sign-in/.test(u.pathname), { timeout: 25000 });
    await p.waitForTimeout(2500);
  }

  // Management: plain account → sign-in → email code → dashboard.
  const M = mail('bm');
  const mpw = password();
  let r = await call(MGMT, 'POST', '/auth/register', { body: { name: 'Launch Verify Browser', email: M, password: mpw } });
  check('management account registers (API)', r.status === 201, `${r.status} ${r.key}`);
  {
    const { ctx, p } = await page('management');
    try {
      await uiSignIn(p, M, mpw, `${ORIGIN(MGMT)}/auth/sign-in`, 'management');
      await shot(p, 'management-signed-in');
      check('management sign-in lands in the app', !/\/auth\//.test(new URL(p.url()).pathname), new URL(p.url()).pathname);
    } catch (e) { await shot(p, 'management-failed'); check('management sign-in journey', false, e.message.slice(0, 160)); }
    await ctx.close();
  }

  // Academy A website: learner → sign-in → email code → /my.
  const L = mail('bl');
  const lpw = password();
  r = await call(A.host, 'POST', '/auth/register', { body: { name: 'Launch Verify Browser', email: L, password: lpw, academyId: A.id } });
  check('academy learner registers (API)', r.status === 201, `${r.status} ${r.key}`);
  {
    const { ctx, p } = await page('academy-A');
    try {
      await p.goto(`${ORIGIN(A.host)}/`); await p.waitForLoadState('networkidle'); await accept(p);
      await shot(p, 'academy-A-home');
      check('Academy A website loads', (await p.title()).length > 0);
      await uiSignIn(p, L, lpw, `${ORIGIN(A.host)}/sign-in`, 'academy A');
      await shot(p, 'academy-A-signed-in');
      check('academy sign-in lands on the learner dashboard', new URL(p.url()).pathname.startsWith('/my'), new URL(p.url()).pathname);
      // Sign out locally (the httpOnly trust cookie stays, as in a real browser) and sign in again.
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await p.goto(`${ORIGIN(A.host)}/sign-in`); await p.waitForLoadState('networkidle'); await accept(p);
      await p.fill('#email', L); await p.fill('#password', lpw); await p.press('#password', 'Enter');
      const second = await Promise.race([
        p.locator('#email-otp-code').waitFor({ timeout: 20000 }).then(() => 'otp'),
        p.waitForURL((u) => !/sign-in/.test(u.pathname), { timeout: 20000 }).then(() => 'in'),
      ]);
      await p.waitForTimeout(1500); await shot(p, 'academy-A-trusted');
      check('academy remembered browser signs in again without a code', second === 'in' && new URL(p.url()).pathname.startsWith('/my'), `${second} ${new URL(p.url()).pathname}`);
    } catch (e) { await shot(p, 'academy-A-failed'); check('academy sign-in journey', false, e.message.slice(0, 160)); }
    await ctx.close();
  }
  for (const v of [{ tag: 'ar-mobile', ar: true, mobile: true }, { tag: 'en-mobile', ar: false, mobile: true }]) {
    const email = mail(`b${v.tag.replace('-', '')}`);
    const vpw = password();
    const reg = await call(A.host, 'POST', '/auth/register', { body: { name: 'Launch Verify Browser', email, password: vpw, academyId: A.id } });
    check(`[${v.tag}] academy learner registers (API)`, reg.status === 201, `${reg.status} ${reg.key}`);
    const prefix = v.ar ? '/ar' : '';
    const { ctx, p } = await page(`academy-A-${v.tag}`, v);
    try {
      await p.goto(`${ORIGIN(A.host)}${prefix}/`); await p.waitForLoadState('networkidle'); await accept(p);
      const home = await p.evaluate(() => ({ dir: document.documentElement.dir, ovf: document.documentElement.scrollWidth > window.innerWidth + 1 }));
      await shot(p, `academy-A-${v.tag}-home`);
      check(`[${v.tag}] academy website direction and layout`, home.dir === (v.ar ? 'rtl' : 'ltr') && !home.ovf, `dir=${home.dir} overflow=${home.ovf}`);
      await uiSignIn(p, email, vpw, `${ORIGIN(A.host)}${prefix}/sign-in`, `academy A ${v.tag}`);
      const after = await p.evaluate(() => ({ dir: document.documentElement.dir, ovf: document.documentElement.scrollWidth > window.innerWidth + 1, path: location.pathname }));
      await shot(p, `academy-A-${v.tag}-signed-in`);
      check(`[${v.tag}] academy sign-in lands on the learner dashboard (${v.ar ? 'RTL' : 'LTR'}, no overflow)`, after.path.startsWith(`${prefix}/my`) && after.dir === (v.ar ? 'rtl' : 'ltr') && !after.ovf, `${after.path} dir=${after.dir} overflow=${after.ovf}`);
    } catch (e) { await shot(p, `academy-A-${v.tag}-failed`); check(`[${v.tag}] academy sign-in journey`, false, e.message.slice(0, 160)); }
    await ctx.close();
  }
  if (B) {
    const { ctx, p } = await page('academy-B');
    await p.goto(`${ORIGIN(B.host)}/`); await p.waitForLoadState('networkidle');
    await shot(p, 'academy-B-home');
    check('Academy B website loads', (await p.title()).length > 0);
    await ctx.close();
  }
  await browser.close();
  check('no uncaught runtime errors on the critical journeys', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// ==============================================================================
// Smart member invitation / academy join (docs/SMART_MEMBER_INVITE_AND_ACADEMY_JOIN.md).
// Its own jobs: OTP verification shares the per-IP sign-in budget, and the
// Plan A modes above already use most of it.
async function smiMode() {
  const acad = remote('academies').split('\n').filter(Boolean).map((l) => l.split('|'));
  if (acad.length < 2) { check('two open academies with a published website exist', false, `found ${acad.length}`); return; }
  const [A, B] = acad.map(([, id, host, name]) => ({ id, host, name }));
  info(`Academy A ${A.id} @ ${A.host}; Academy B ${B.id} @ ${B.host}`);
  let r;
  let f;

  // ---- Smart academy join: an existing account joins B, answered like sign-in --
  const J = mail('sj');
  const jpw = password();
  r = await call(A.host, 'POST', '/auth/register', { body: { name: 'Launch Verify Join', email: J, password: jpw, academyId: A.id } });
  check('SMI join fixture: learner registers at Academy A', r.status === 201 && r.body?.account === 'new', `${r.status} ${r.key}`);
  const ghost = await call(B.host, 'POST', '/auth/academy-join', { body: { email: mail('ghost'), password: password(), academyId: B.id } });
  const wrong = await call(B.host, 'POST', '/auth/academy-join', { body: { email: J, password: 'not-the-password', academyId: B.id } });
  check('SMI join: unknown email and wrong password get the same generic 401 (no name, no oracle)',
    ghost.status === 401 && wrong.status === 401 && ghost.key === 'errors.auth.invalidCredentials' && wrong.key === ghost.key && !JSON.stringify(wrong.body).includes('Launch Verify Join'),
    `${ghost.status} ${ghost.key} / ${wrong.status} ${wrong.key}`);
  r = await call(B.host, 'POST', '/auth/academy-join', { body: { email: J, password: jpw, academyId: B.id } });
  check('SMI join: the right password joins Academy B, returns the name, mints no session',
    r.status === 200 && r.body?.account === 'existing' && r.body?.name === 'Launch Verify Join' && !r.body?.accessToken,
    `${r.status} ${r.key} status=${r.body?.status}`);
  f = facts('user', J, A.id, B.id);
  check('SMI join: one user, learner rows at A and B, owner notified (account.academy.joined)',
    f.users === '1' && f.learner_rows === '2' && f.learner_A !== '-' && f.learner_B !== '-' && Number(f.joined_notice) >= 1,
    `users=${f.users} rows=${f.learner_rows} notice=${f.joined_notice}`);
  r = await call(B.host, 'POST', '/auth/academy-join', { body: { email: J, password: jpw, academyId: B.id } });
  check('SMI join: joining again answers alreadyLearnerHere', r.status === 409 && r.key === 'errors.auth.alreadyLearnerHere', `${r.status} ${r.key}`);
  r = await signIn(B.host, J, jpw, { surface: 'academy', academyId: B.id });
  check('SMI join: continuation asks for Academy B\'s emailed code', r.status === 200 && r.body?.emailOtpRequired === true && !r.body?.accessToken, `${r.status}`);
  r = await verify(B.host, r.body?.challengeId, await code(J), false, 'academy');
  check('SMI join: Academy B code signs the joined account in', r.status === 200 && !!r.body?.accessToken, `${r.status}`);
  const sJ = r.body?.accessToken;
  r = await call(B.host, 'GET', '/auth/academy-join/summary', { token: sJ });
  check('SMI summary: after password + code, names the academy the account already uses (and only that)', r.status === 200 && Array.isArray(r.body?.otherAcademies) && r.body.otherAcademies.length === 1 && r.body.otherAcademies[0] === A.name, `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(A.host, 'GET', '/auth/academy-join/summary', { token: sJ });
  check("SMI summary: the same session on another academy's host is refused (A1)", r.status === 403 && r.key === 'errors.auth.academyHostMismatch', `${r.status} ${r.key}`);
  r = await call(B.host, 'GET', '/auth/academy-join/summary');
  check('SMI summary: no session, no answer (401)', r.status === 401, `${r.status}`);

  // ---- Smart member invitation: the staff email lookup refuses non-owners ------
  const lookupPath = `/academies/${A.id}/member-lookup?email=${encodeURIComponent(J)}&role=manager`;
  r = await call(MGMT, 'GET', lookupPath);
  check('SMI lookup: anonymous caller refused (401)', r.status === 401, `${r.status} ${r.key}`);
  r = await call(MGMT, 'GET', lookupPath, { token: sJ });
  check('SMI lookup: academy-website session refused (managementSurfaceOnly)', r.status === 403 && r.key === 'errors.auth.managementSurfaceOnly' && !JSON.stringify(r.body).includes('Launch Verify Join'), `${r.status} ${r.key}`);

  // A management session that owns nothing may not look anyone up.
  const M = mail('sm');
  const mpw = password();
  r = await call(MGMT, 'POST', '/auth/register', { body: { name: 'Launch Verify Staff', email: M, password: mpw } });
  check('SMI lookup fixture: management account registers', r.status === 201, `${r.status} ${r.key}`);
  r = await signIn(MGMT, M, mpw);
  if (r.body?.emailOtpRequired) r = await verify(MGMT, r.body.challengeId, await code(M), false, 'management');
  const sM = r.body?.accessToken;
  r = await call(MGMT, 'GET', `/academies/${A.id}/member-lookup?email=${encodeURIComponent(J)}&role=student`, { token: sM });
  check('SMI lookup: a management session that is not the owner is refused (403, nothing disclosed)', !!sM && r.status === 403 && !JSON.stringify(r.body).includes('Launch Verify Join'), `${r.status} ${r.key}`);

  await new Promise((res) => setTimeout(res, 40000)); // one Prometheus scrape (30s)
  const m = facts('metrics');
  info(`atlas_academy_join_total: ${m.academy_join}`);
  info(`atlas_member_lookup_total: ${m.member_lookup}`);
  check('metrics: academy joins recorded (joined, invalid_credentials, already_learner)', ['joined', 'invalid_credentials', 'already_learner'].every((x) => new RegExp(`(^|\\s)${x}=\\d`).test(m.academy_join)), m.academy_join);
}

async function smiBrowserMode() {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const acad = remote('academies').split('\n').filter(Boolean).map((l) => l.split('|'));
  if (acad.length < 2) { check('two open academies with a published website exist', false, `found ${acad.length}`); return; }
  const [A, B] = acad.map(([, id, host, name]) => ({ id, host, name }));
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  async function page(tag, { mobile = false, ar = false } = {}) {
    const ctx = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, locale: ar ? 'ar' : 'en-US',
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${tag}: ${e.message.slice(0, 160)}`));
    return { ctx, p };
  }
  const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
  async function accept(p) {
    const b = p.getByRole('button', { name: /accept all|قبول الكل/i });
    if (await b.count()) await b.first().click().catch(() => {});
  }
  // Smart academy join: an account of A signs UP at B with a different
  // password → "You already have an Atlas account" (email locked, Change
  // email, no new-account password fields, A NOT named) → its Atlas
  // password → B's emailed code → "You're all set" naming A → /my.
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const v of [{ tag: 'join-en-desktop', ar: false, mobile: false }, { tag: 'join-ar-mobile', ar: true, mobile: true }]) {
    const email = mail(`b${v.tag.replace(/-/g, '')}`);
    const jpw = password();
    const reg = await call(A.host, 'POST', '/auth/register', { body: { name: 'Launch Verify Join', email, password: jpw, academyId: A.id } });
    check(`[${v.tag}] join fixture: learner registers at Academy A (API)`, reg.status === 201, `${reg.status} ${reg.key}`);
    const prefix = v.ar ? '/ar' : '';
    const { ctx, p } = await page(`academy-B-${v.tag}`, v);
    try {
      await p.goto(`${ORIGIN(B.host)}${prefix}/sign-up`); await p.waitForLoadState('networkidle'); await accept(p);
      const other = password();
      await p.fill('#name', 'Launch Verify Join'); await p.fill('#email', email);
      await p.fill('#password', other); await p.fill('#confirmPassword', other);
      await p.getByRole('checkbox').first().click();
      await p.locator('form button[type=submit]').click();
      await p.locator('#academy-join-password').waitFor({ timeout: 20000 });
      const step = await p.evaluate(() => ({ dir: document.documentElement.dir, ovf: document.documentElement.scrollWidth > window.innerWidth + 1 }));
      await shot(p, `academy-B-${v.tag}-existing-account`);
      check(`[${v.tag}] "You already have an Atlas account" explains this academy runs on Atlas`, (await p.getByText(/You already have an Atlas account|لديك حساب على Atlas بالفعل/).count()) > 0 && (await p.getByText(new RegExp(escape(B.name))).count()) > 0);
      check(`[${v.tag}] email locked, "Change email" offered, no new-account password fields`,
        (await p.locator('#academy-join-email').evaluate((e) => e.readOnly)) && (await p.getByRole('button', { name: /Change email|تغيير البريد الإلكتروني/ }).count()) === 1 && (await p.locator('#confirmPassword').count()) === 0);
      check(`[${v.tag}] the other academy is NOT named before proof`, (await p.getByText(new RegExp(escape(A.name))).count()) === 0, A.name);
      check(`[${v.tag}] existing-account step layout (${v.ar ? 'RTL' : 'LTR'}, no overflow)`, step.dir === (v.ar ? 'rtl' : 'ltr') && !step.ovf, `dir=${step.dir} overflow=${step.ovf}`);
      if (!v.ar) {
        // Change email unlocks the address (back to the form, kept), then the
        // same account continues through "Join with it" — no second sign-up.
        await p.getByRole('button', { name: /Change email/ }).click();
        const back = await p.locator('#email').evaluate((e) => ({ readOnly: e.readOnly, value: e.value }));
        check(`[${v.tag}] "Change email" returns to an editable form keeping the address`, !back.readOnly && back.value === email, JSON.stringify(back));
        await p.getByRole('button', { name: /Join with it/ }).click();
        await p.fill('#academy-join-email', email);
      }
      await p.fill('#academy-join-password', jpw);
      await p.press('#academy-join-password', 'Enter');
      await p.locator('#email-otp-code').waitFor({ timeout: 25000 });
      check(`[${v.tag}] continues into Academy B's emailed code (A6), greeting by name`, (await p.getByText(/Launch Verify Join/).count()) > 0);
      await p.fill('#email-otp-code', await code(email)); await p.press('#email-otp-code', 'Enter');
      await p.getByText(new RegExp(escape(A.name))).first().waitFor({ timeout: 25000 });
      const welcome = await p.evaluate(() => ({ dir: document.documentElement.dir, ovf: document.documentElement.scrollWidth > window.innerWidth + 1 }));
      await shot(p, `academy-B-${v.tag}-welcome`);
      check(`[${v.tag}] after password + code: "You're all set" names the academy the account already uses`, (await p.getByText(new RegExp(escape(A.name))).count()) > 0 && !welcome.ovf, A.name);
      await p.getByRole('link', { name: /Go to my learning|الانتقال إلى تعلّمي/ }).click();
      await p.waitForURL((u) => u.pathname.startsWith(`${prefix}/my`), { timeout: 25000 });
      await p.waitForTimeout(1500); await shot(p, `academy-B-${v.tag}-join-my`);
      check(`[${v.tag}] joined account lands on /my`, new URL(p.url()).pathname.startsWith(`${prefix}/my`), new URL(p.url()).pathname);
      const jf = facts('user', email, A.id, B.id);
      check(`[${v.tag}] one user, learner at A and B, B's trust scoped to B`, jf.users === '1' && jf.learner_rows === '2' && jf.trust_A_live === '0', `users=${jf.users} rows=${jf.learner_rows} trustA=${jf.trust_A_live}`);
    } catch (e) { await shot(p, `academy-B-${v.tag}-failed`); check(`[${v.tag}] academy join journey`, false, e.message.slice(0, 160)); }
    await ctx.close();
  }
  await browser.close();
  check('no uncaught runtime errors on the join journeys', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// ==============================================================================
// Email deliverability facts (read-only). DNS is resolved from the runner (the
// public internet's view); Brevo facts come from the VPS (remote.sh mail).
// Reports facts; fails only on what the application controls or on missing
// authentication — inbox placement itself cannot be asserted from here.
async function deliverabilityMode() {
  const dns = (await import('node:dns')).promises;
  const txt = async (name) => {
    try { return (await dns.resolveTxt(name)).map((parts) => parts.join('')); } catch (e) { return [`<${e.code}>`]; }
  };
  const cname = async (name) => {
    try { return (await dns.resolveCname(name)).join(','); } catch (e) { return `<${e.code}>`; }
  };
  const m = facts('mail');
  for (const [k, v] of Object.entries(m)) info(`${k}: ${v}`);
  const domainLine = m.brevo_domain ?? '';
  const domain = domainLine.split('|')[0] || MGMT;
  check('mail: the platform sender is a no-reply address on the sending domain', /^no-reply@/.test(m.from ?? '') && (m.from ?? '').endsWith(`@${domain}`), m.from);
  check('mail: sending domain is verified AND authenticated in Brevo', /verified=true\|authenticated=true/.test(domainLine), domainLine);
  check('mail: the sender exists and is active in Brevo', /present active=true/.test(m.brevo_sender ?? ''), m.brevo_sender);

  const spf = (await txt(domain)).filter((x) => /^v=spf1/i.test(x));
  const dmarc = (await txt(`_dmarc.${domain}`)).filter((x) => /^v=DMARC1/i.test(x));
  info(`SPF ${domain}: ${spf.join(' | ') || 'none'}`);
  info(`DMARC _dmarc.${domain}: ${dmarc.join(' | ') || 'none'}`);
  check('dns: exactly one SPF record, including Brevo', spf.length === 1 && /include:spf\.brevo\.com/.test(spf[0]), spf.join(' | '));
  check('dns: a DMARC record is published', dmarc.length === 1, dmarc.join(' | '));
  for (const sel of ['brevo1', 'brevo2']) {
    const target = await cname(`${sel}._domainkey.${domain}`);
    const key = target.startsWith('<') ? [] : (await txt(target)).filter((x) => /p=/.test(x));
    check(`dns: DKIM ${sel} resolves to a published key`, key.length > 0, `${target} → ${key.length ? 'key present' : 'no key'}`);
  }
  // Which domain DMARC evaluates as "organizational" depends on the Public
  // Suffix List: if the parent is a public suffix, this domain IS the
  // organization, with its own (and only its own) sending reputation.
  const parent = domain.split('.').slice(1).join('.');
  try {
    const psl = await (await fetch('https://publicsuffix.org/list/public_suffix_list.dat')).text();
    const listed = psl.split('\n').some((l) => l.trim() === parent);
    info(`public suffix list: "${parent}" ${listed ? 'IS' : 'is NOT'} a public suffix (organizational domain = ${listed ? domain : parent})`);
  } catch (e) { info(`public suffix list: unavailable (${e.message})`); }
  info(`DMARC of parent _dmarc.${parent}: ${(await txt(`_dmarc.${parent}`)).join(' | ')}`);
  info(`MX ${domain}: ${await dns.resolveMx(domain).then((r) => r.map((x) => x.exchange).join(',')).catch((e) => `<${e.code}>`)}`);
  memberEmails();
}

/**
 * The academy member emails actually produced in production (last 48 h):
 * the stored academy name against the academy record, the delivery row, and
 * Brevo's own copy of what it sent. Reports only when such an email exists —
 * a member add is an owner action this workflow cannot perform.
 */
function memberEmails() {
  const lines = remote('member-email').split('\n').filter(Boolean);
  const rows = lines.filter((l) => l.startsWith('row|')).map((l) => {
    const [, id, key, locale, state, createdAt, storedName, role, academyName, match, provider, status, templateVersion, sentAt, messageId] = l.split('|');
    return { id, key, locale, state, createdAt, storedName, role, academyName, match, provider, status, templateVersion, sentAt, messageId };
  });
  const brevo = {};
  for (const l of lines.filter((x) => x.startsWith('brevo_'))) {
    const [k, ...v] = l.split('|');
    const m = k.match(/^brevo_(msg|subject|text)_(\d+)$/);
    if (!m) { info(l); continue; }
    (brevo[m[2]] ??= {})[m[1]] = v;
  }
  const byId = Object.fromEntries(Object.values(brevo).filter((b) => b.msg).map((b) => [b.msg[0], b]));
  if (!rows.length) { info('member emails (48 h): none — add a member from the dashboard to verify one'); return; }
  for (const r of rows) {
    info(`member email ${r.id}: key=${r.key} locale=${r.locale} role=${r.role} outbox=${r.state} created=${r.createdAt}`);
    info(`  stored academyName="${r.storedName}" | academy record name="${r.academyName}"`);
    info(`  delivery: provider=${r.provider} status=${r.status} template=${r.templateVersion} sent=${r.sentAt} messageId=${r.messageId}`);
    const b = byId[r.messageId];
    if (b) {
      info(`  brevo: ${b.msg.slice(1).join(' ')}`);
      info(`  brevo subject: ${b.subject?.join('|')}`);
      info(`  brevo text: ${b.text?.join('|')}`);
    }
  }
  // Only emails produced by the fixed code are judged: the fix shipped with
  // this release, and earlier rows are the bug it fixed.
  const latest = rows[0];
  const name = latest.academyName;
  check('member email: the stored academy name is the academy record\'s name', latest.match === 't' && name.trim() !== '', `"${latest.storedName}" vs "${name}"`);
  check('member email: handed to the provider', latest.messageId !== '-' && ['sent', 'delivered'].includes(latest.status), `${latest.provider} ${latest.status}`);
  const b = byId[latest.messageId];
  const subject = b?.subject?.join('|') ?? '';
  const text = b?.text?.join('|') ?? '';
  check('member email: Brevo\'s sent subject names the academy (no hole)', subject.includes(name) && !/\s{2,}|to\s+on /.test(subject), subject);
  check('member email: Brevo\'s sent body names the academy', text.includes(name), `${text.split(name).length - 1} occurrence(s)`);
  check('member email: Brevo recorded delivery', /delivered/.test(b?.msg?.join('|') ?? ''), b?.msg?.slice(1).join(' ') ?? 'no Brevo record');
}

try {
  if (MODE === 'browser') await browserMode();
  else if (MODE === 'smi') await smiMode();
  else if (MODE === 'smi-browser') await smiBrowserMode();
  else if (MODE === 'deliverability') await deliverabilityMode();
  else await apiMode();
} catch (e) {
  check('verification ran to completion', false, e.message.slice(0, 200));
}
console.log(fails === 0 ? `RESULT [${MODE}]: all checks passed` : `RESULT [${MODE}]: ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
