// Atlas — Google Identity production verification (read-only probes + facts).
// Run by `.github/workflows/google-verify.yml`. Prints PASS/FAIL lines and
// non-secret facts only: never a client secret, code, state, nonce, handoff,
// token or cookie value. The only side effect of the probes is an unfinished
// flow row per authorize call, which expires in 10 minutes and is deleted by
// the flow retention after 24 h.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM = process.env.PLATFORM_HOST || 'atlass.dpdns.org';
// Local dry run only (never set in the workflow): plain HTTP to a proxy port.
const SCHEME = process.env.PROBE_SCHEME || 'https';
const PORT = process.env.PROBE_PORT ? `:${process.env.PROBE_PORT}` : '';
const CALLBACK = process.env.EXPECT_CALLBACK || `https://${PLATFORM}/api/v1/auth/google/callback`;
const CHECKS = (process.env.CHECKS || 'all').split(',').map((s) => s.trim());
const EXPECT_MODE = process.env.EXPECT_MODE || 'off';
/** `allowlist` mode: whether Atlas's own pages (platform host, management surface) offer Google. */
const EXPECT_PLATFORM = process.env.EXPECT_PLATFORM === 'on' ? 'on' : 'off';
const MANAGEMENT_ON = EXPECT_MODE === 'on' || (EXPECT_MODE === 'allowlist' && EXPECT_PLATFORM === 'on');
const ACADEMY_ID = process.env.ACADEMY_ID || '';
const want = (c) => CHECKS.includes('all') || CHECKS.includes(c);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const info = (s) => console.log(`INFO  ${s}`);

function remote(...args) {
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
const lines = (text) => text.split('\n').filter(Boolean).map((l) => l.split('|'));
const facts = (...args) => Object.fromEntries(lines(remote(...args)).map(([k, ...v]) => [k, v.join('|')]));
const printFacts = (label, text) => { for (const l of text.split('\n').filter(Boolean)) info(`${label} ${l}`); };

// Local dry run only: "fromSuffix=toSuffix" maps the stored host names onto a local proxy.
const [REWRITE_FROM, REWRITE_TO] = (process.env.HOST_SUFFIX_REWRITE || '=').split('=');
const hostFor = (h) => (REWRITE_FROM && h.endsWith(REWRITE_FROM) ? h.slice(0, -REWRITE_FROM.length) + REWRITE_TO : h);

async function call(host, method, p, opts = {}) {
  try {
    return await callOnce(hostFor(host), method, p, opts);
  } catch (error) {
    // An unreachable host (DNS, TLS) is a failed check, never a crashed run.
    return { status: 0, json: null, key: `unreachable: ${error.cause?.code || error.message}`, headers: new Headers(), text: '' };
  }
}

async function callOnce(host, method, p, { body, origin, headers = {} } = {}) {
  const r = await fetch(`${SCHEME}://${host}${PORT}/api/v1${p}`, {
    method,
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(origin !== null ? { origin: origin ?? `${SCHEME}://${host}${PORT}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    // A dead host (e.g. a custom domain whose DNS moved) must fail fast.
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, key: json?.error?.messageKey ?? '', headers: r.headers, text };
}

async function main() {
  // ---------------------------------------------------------------- config
  let config = {};
  if (want('config')) {
    config = facts('config');
    printFacts('config', Object.entries(config).map(([k, v]) => `${k}|${v}`).join('\n'));
    check('backend healthy', /^200 /.test(config.health || ''), (config.health || '').slice(0, 80));
    check('Google migration applied', config.migration === 'applied', config.migration);
    check('no pending/failed migrations', config.pending_or_failed_migrations === '0', config.pending_or_failed_migrations);
    check('identity + flow tables exist', config.tables === 'auth_oauth_flows,user_auth_identities', config.tables);
    check('refresh_tokens.auth_method exists', config.refresh_tokens_auth_method === 'auth_method', config.refresh_tokens_auth_method);
    check('auth_oauth_flows FORCE RLS', config.flows_force_rls === 't', config.flows_force_rls);
    check('NODE_ENV=production', config.node_env === 'production', config.node_env);
    check(`PLATFORM_BASE_DOMAIN=${PLATFORM}`, config.platform_base_domain === PLATFORM, config.platform_base_domain);
    check('no fake-provider (GOOGLE_OIDC_*) override in the running process', config.fake_provider_overrides === 'none', config.fake_provider_overrides);
    const mode = config.mode.startsWith('(unset') ? 'off' : config.mode;
    check(`running mode is the expected "${EXPECT_MODE}"`, mode === EXPECT_MODE, config.mode);
    if (EXPECT_MODE !== 'off') {
      check('client id present and shaped like a Google web client id', config.client_id_present === 'true' && config.client_id_shape_ok === 'true');
      check('client secret present (value never printed)', config.client_secret_present === 'true', `length ${config.client_secret_length}`);
      check('redirect URI is exactly the central callback', config.redirect_uri === CALLBACK, config.redirect_uri);
    }
    if (EXPECT_MODE === 'allowlist') {
      const expectedIds = [ACADEMY_ID, ...(process.env.ALSO_ACADEMY_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)].sort().join(',');
      check('allowlist names exactly the verified academies', config.academy_ids.split(',').map((x) => x.trim()).sort().join(',') === expectedIds, config.academy_ids);
      const platform = (config.platform || '').startsWith('(unset') ? 'off' : config.platform;
      check(`platform switch is the expected "${EXPECT_PLATFORM}"`, platform === EXPECT_PLATFORM, config.platform);
    }
    check('no error/fatal log lines in the last 30m', config.log_error_lines_30m === '0' && config.log_fatal_lines_30m === '0', `error=${config.log_error_lines_30m} fatal=${config.log_fatal_lines_30m}`);
  }

  // ---------------------------------------------------------------- academy
  let academyHost = '';
  if (want('academy') && ACADEMY_ID) {
    const text = remote('academy', ACADEMY_ID);
    printFacts('academy', text);
    const rows = lines(text);
    const a = rows.find((r) => r[0] === 'academy');
    const sub = rows.find((r) => r[0] === 'subdomain');
    const site = rows.find((r) => r[0] === 'website');
    academyHost = sub?.[2] ?? '';
    check('academy exists with that exact UUID', !!a && a[1] === ACADEMY_ID);
    check('academy is not archived or suspended', !!a && a[5] === '-' && !['archived', 'suspended'].includes(a[4]), a ? `${a[4]} archived=${a[5]}` : 'missing');
    check('academy subdomain assigned', sub?.[1] === 'assigned', sub?.join(' '));
    check('academy website published', site?.[1] === 'published', site?.[1]);
    info(`academy registration policy: ${a?.[6]}`);
  }

  // ---------------------------------------------------------------- probes
  if (want('probe')) {
    const hostsText = remote('hosts');
    const allHosts = lines(hostsText).filter((r) => r[0] === 'host').map(([, id, name, policy, host]) => ({ id, name, policy, host }));
    // The allowlisted academies first (they must be probed), then the newest others.
    const listed = (process.env.ALSO_ACADEMY_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const first = new Set([ACADEMY_ID, ...listed].filter(Boolean));
    const hosts = [...allHosts.filter((h) => first.has(h.id)), ...allHosts.filter((h) => !first.has(h.id))].filter((h) => h.host);
    for (const h of hosts.slice(0, 8)) info(`host ${h.id} ${h.host} policy=${h.policy}`);
    const customs = lines(hostsText).filter((r) => r[0] === 'custom').map(([, id, host]) => ({ id, host }));
    if (!academyHost && ACADEMY_ID) academyHost = hosts.find((h) => h.id === ACADEMY_ID)?.host ?? '';

    const options = await call(PLATFORM, 'GET', '/auth/options', { origin: null });
    check('platform /auth/options answers', options.status === 200, `${options.status}`);
    check(`platform (management) offers Google = ${MANAGEMENT_ON} (mode ${EXPECT_MODE}, platform ${EXPECT_PLATFORM})`, options.json?.google === MANAGEMENT_ON, JSON.stringify(options.json));

    for (const h of hosts.slice(0, 8)) {
      const o = await call(h.host, 'GET', '/auth/options', { origin: null });
      const expected = EXPECT_MODE === 'on' || (EXPECT_MODE === 'allowlist' && first.has(h.id));
      check(`${h.host} offers Google = ${expected}`, o.status === 200 && o.json?.google === expected, `${o.status} ${JSON.stringify(o.json)}`);
    }
    for (const c of customs.slice(0, 4)) {
      const o = await call(c.host, 'GET', '/auth/options', { origin: null }).catch((e) => ({ status: 0, json: null, e }));
      const expected = EXPECT_MODE === 'on' || (EXPECT_MODE === 'allowlist' && first.has(c.id));
      check(`custom domain ${c.host} offers Google = ${expected}`, o.status === 200 && o.json?.google === expected, `${o.status} ${JSON.stringify(o.json)}`);
    }

    const mgmt = await call(PLATFORM, 'POST', '/auth/google/authorize', { body: { intent: 'sign_up', returnTo: '/auth/register' } });
    if (MANAGEMENT_ON) {
      check('platform authorize works', mgmt.status === 200, `${mgmt.status} ${mgmt.key}`);
      if (mgmt.status === 200) {
        const q = new URL(mgmt.json.authorizationUrl).searchParams;
        check('platform flow: exact central redirect URI, PKCE S256, state and nonce', q.get('redirect_uri') === CALLBACK && q.get('code_challenge_method') === 'S256' && (q.get('state') || '').length >= 40 && (q.get('nonce') || '').length >= 40);
      }
      const foreignPlatform = await call(PLATFORM, 'POST', '/auth/google/authorize', { body: { intent: 'sign_in' }, origin: 'https://evil.example' });
      check('a foreign Origin cannot start a platform flow', foreignPlatform.status === 403, `${foreignPlatform.status} ${foreignPlatform.key}`);
    } else {
      check('platform (management) authorize is refused (404)', mgmt.status === 404, `${mgmt.status} ${mgmt.key}`);
    }

    if (EXPECT_MODE !== 'off' && academyHost) {
      const foreign = await call(academyHost, 'POST', '/auth/google/authorize', { body: { intent: 'sign_in' }, origin: 'https://evil.example' });
      check('a foreign Origin cannot start a flow', foreign.status === 403 && foreign.key === 'errors.auth.googleOriginRefused', `${foreign.status} ${foreign.key}`);

      const started = await call(academyHost, 'POST', '/auth/google/authorize', { body: { intent: 'sign_in', returnTo: '/sign-in' } });
      check(`authorize on ${academyHost} answers 200`, started.status === 200, `${started.status} ${started.key}`);
      if (started.status === 200) {
        const u = new URL(started.json.authorizationUrl);
        const q = u.searchParams;
        check('authorization URL is Google’s', u.origin === 'https://accounts.google.com' && u.pathname === '/o/oauth2/v2/auth', `${u.origin}${u.pathname}`);
        check('redirect_uri is exactly the central callback', q.get('redirect_uri') === CALLBACK, q.get('redirect_uri'));
        check('response_type=code, scope=openid email profile', q.get('response_type') === 'code' && q.get('scope') === 'openid email profile');
        check('PKCE S256 with a challenge', q.get('code_challenge_method') === 'S256' && (q.get('code_challenge') || '').length >= 43);
        check('state and nonce present (values not printed)', (q.get('state') || '').length >= 40 && (q.get('nonce') || '').length >= 40);
        check('prompt=select_account', q.get('prompt') === 'select_account');
        check('client_id shaped like a Google web client id (not printed)', /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(q.get('client_id') || ''));
        const cookie = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('atlas_google_binder=')) || '';
        const attrs = cookie.split(';').slice(1).map((s) => s.trim().toLowerCase());
        check('binder cookie: HttpOnly, Secure, SameSite=Lax, host-only, flow path', attrs.includes('httponly') && attrs.includes('secure') && attrs.includes('samesite=lax') && !attrs.some((a) => a.startsWith('domain=')) && attrs.includes('path=/api/v1/auth/google'), attrs.join(';'));

        // Does GOOGLE accept this client + redirect URI? A misconfigured
        // client answers with an error page or an error redirect.
        const g = await fetch(started.json.authorizationUrl, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
        const loc = g.headers.get('location') || '';
        const body = g.status >= 400 ? await g.text() : '';
        const locUrl = loc ? new URL(loc, 'https://accounts.google.com') : null;
        const bad = /redirect_uri_mismatch|invalid_client|unauthorized_client|deleted_client|disabled_client|authError/i;
        check('Google accepts the client and the redirect URI (no OAuth error)', [200, 302, 303].includes(g.status) && !bad.test(loc) && !bad.test(body), `${g.status} → ${locUrl ? locUrl.origin + locUrl.pathname : '-'}`);
      }

      const cbOnAcademy = await call(academyHost, 'GET', '/auth/google/callback?state=probe&code=probe', { origin: null });
      check('callback is not served on an academy host (404)', cbOnAcademy.status === 404, `${cbOnAcademy.status}`);
      const cbBogus = await call(PLATFORM, 'GET', '/auth/google/callback?state=probe-not-a-flow&code=probe', { origin: null });
      check('platform callback with an unknown state is a dead end (400, no redirect)', cbBogus.status === 400 && !cbBogus.headers.get('location'), `${cbBogus.status}`);
      const done = await call(academyHost, 'POST', '/auth/google/complete', { body: { handoff: 'probe-not-a-handoff' } });
      check('completing an unknown handoff is refused generically', done.status === 401 && done.key === 'errors.auth.googleSignInExpired', `${done.status} ${done.key}`);
    } else if (EXPECT_MODE === 'off') {
      const a = hosts[0]?.host;
      if (a) {
        const r = await call(a, 'POST', '/auth/google/authorize', { body: { intent: 'sign_in' } });
        check(`mode off: authorize on ${a} is 404`, r.status === 404, `${r.status}`);
        const c = await call(PLATFORM, 'GET', '/auth/google/callback?state=x&code=y', { origin: null });
        check('mode off: the callback is a dead end', c.status >= 400 && c.status < 500 && !c.headers.get('location'), `${c.status}`);
      }
    }
  }

  // ---------------------------------------------------------------- data / logs / metrics / backup
  if (want('data')) {
    const d = remote('data');
    printFacts('data', d);
    const f = Object.fromEntries(lines(d).filter((r) => r.length === 2));
    check('no flow row kept past retention (24 h)', f.flows_past_retention === '0', f.flows_past_retention);
    check('no duplicate Google subject', f.identity_dup_subjects === '0');
    check('no account with two Google identities', f.identity_dup_users === '0');
    check('no orphan identity', f.identity_orphans === '0');
    check('no identity left on a deleted account', f.identity_on_deleted === '0', f.identity_on_deleted);
    check('no duplicate user email', f.duplicate_user_emails === '0', f.duplicate_user_emails);
  }
  if (want('logs')) {
    const l = facts('logs', process.env.LOG_HOURS || '24');
    printFacts('logs', Object.entries(l).map(([k, v]) => `${k}|${v}`).join('\n'));
    check('every callback log line carrying a code shows it redacted', l.callback_lines_with_code === l.callback_lines_redacted, `${l.callback_lines_redacted}/${l.callback_lines_with_code} (of ${l.callback_lines} callback lines)`);
    check('no raw code/state in any callback log line', l.callback_raw_code_or_state === '0' && l.callback_raw_query_json === '0');
    check('no client secret in logs (literal or GOCSPX-shaped)', l.client_secret_shaped === '0' && ['0', 'n/a'].includes(l.client_secret_literal));
    check('no JWT / Google access token shaped value in logs', l.jwt_shaped === '0' && l.google_access_token_shaped === '0');
    check('no handoff/pending/setup token in logs', l.handoff_or_pending_body === '0');
    check('flow retention sweep has not failed', l.google_retention_sweep_failures === '0');
  }
  if (want('metrics')) {
    const m = facts('metrics');
    printFacts('metrics', Object.entries(m).map(([k, v]) => `${k}|${v}`).join('\n'));
    check('Google alert rules loaded in Prometheus', (m.google_rules_loaded || '').includes('AtlasGoogleSignInProviderErrors'), m.google_rules_loaded);
  }
  if (want('backup')) {
    const b = facts('backup');
    printFacts('backup', Object.entries(b).map(([k, v]) => `${k}|${v}`).join('\n'));
    check('a database backup from the last 26 h exists', Number(b.backup_age_hours) <= 26, `${b.backup_file} age ${b.backup_age_hours}h`);
    check('backup passes gzip integrity and contains the users table', b.backup_gzip === 'ok' && b.backup_has_users_table === '1');
  }
  if (CHECKS.includes('recent')) {
    printFacts('recent', remote('recent'));
  }
  if (want('user') && process.env.USER_EMAIL) {
    printFacts('user', remote('user', process.env.USER_EMAIL, process.env.MAILBOX));
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL  verification crashed — ${e.message}`); process.exit(1); });
