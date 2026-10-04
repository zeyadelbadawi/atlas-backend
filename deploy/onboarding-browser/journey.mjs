/**
 * Atlas — New Customer Onboarding browser journey (docs/NEW_CUSTOMER_ONBOARDING.md §7).
 *
 * Drives the REAL product in Chromium and prints PASS/FAIL lines plus
 * non-personal facts. Screenshots go to $OUT for the workflow artifact.
 *
 *   JOURNEY=A  EN desktop — trial path end to end: Start for Free → one-page
 *              signup → sign in → OTP → /onboarding → Academy → Branding →
 *              Website → First course → Summary → Finish → Dashboard, with a
 *              refresh-persistence check and "Finish disabled while required
 *              steps are open".
 *   JOURNEY=B  AR mobile — the same mailbox again (trial already used): Plan
 *              step → existing checkout → payment → Back to setup → awaiting
 *              confirmation → Finish for now → dashboard setup card; the test
 *              payment is then cancelled so nothing reaches the review queue.
 *
 * The sign-in code is fetched by `code()` (server-side helper over the deploy
 * identity in production, local psql otherwise) and is never logged.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const API = process.env.API_URL || `${BASE}/api/v1`;
const JOURNEY = process.env.JOURNEY || 'A';
const EMAIL = process.env.JOURNEY_EMAIL;
const OUT = process.env.OUT || path.join(here, 'out');
const LANG = JOURNEY === 'B' ? 'ar' : 'en';
const VIEWPORT = JOURNEY === 'B' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const PASSWORD = `Verify-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
// W4: organization and academy names are unique platform-wide, so every run
// names its verification organization and academy with its own run tag.
const RUN = process.env.RUN_TAG || String(Date.now());
if (!BASE || !EMAIL) throw new Error('BASE_URL and JOURNEY_EMAIL are required');
mkdirSync(OUT, { recursive: true });

// --- server-side facts (never personal data, never printed codes) -----------
function remote(cmd) {
  if (process.env.REMOTE === 'local') {
    return execFileSync('bash', [process.env.REMOTE_LOCAL_SCRIPT, cmd, EMAIL]).toString().trim();
  }
  return execFileSync(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=accept-new', '-i', process.env.SSH_KEY_FILE,
      `${process.env.DEPLOY_USER}@${process.env.DEPLOY_HOST}`,
      `f=$(mktemp); cat > "$f"; bash "$f" ${cmd} '${EMAIL}' </dev/null; rc=$?; rm -f "$f"; exit $rc`,
    ],
    { input: execFileSync('cat', [path.join(here, 'remote.sh')]) },
  ).toString().trim();
}
const facts = (cmd) =>
  Object.fromEntries(remote(cmd).split('\n').filter(Boolean).map((l) => l.split('|')));

async function code(previous) {
  for (let i = 0; i < 20; i += 1) {
    const c = remote('otp');
    if (/^\d{4,8}$/.test(c) && c !== previous) return c;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('no sign-in code arrived');
}

// --- reporting ---------------------------------------------------------------
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${JOURNEY}] ${name}${detail ? ` — ${detail}` : ''}`);
};
const info = (msg) => console.log(`INFO  [${JOURNEY}] ${msg}`);

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: VIEWPORT, locale: LANG === 'ar' ? 'ar' : 'en-US' });
if (LANG === 'ar') {
  await ctx.addInitScript(() => {
    try { localStorage.setItem('atlas:language', JSON.stringify('ar')); } catch { /* ignore */ }
  });
}
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
p.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
const visited = [];
p.on('framenavigated', (f) => { if (f === p.mainFrame()) visited.push(new URL(f.url()).pathname); });

let shot = 0;
async function step(label) {
  await p.waitForTimeout(1200);
  shot += 1;
  await p.screenshot({ path: path.join(OUT, `${JOURNEY}-${String(shot).padStart(2, '0')}-${label}.png`), fullPage: true });
  const s = await p.evaluate(() => ({
    dir: document.documentElement.dir || 'ltr',
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    rawKeys: (document.body.innerText.match(/\b[a-z]+(?:[A-Z][a-zA-Z]*)?\.[a-z][a-zA-Z]+\.[a-z][a-zA-Z_.]+\b/g) || []).slice(0, 3),
  }));
  const path_ = new URL(p.url()).pathname;
  check(`${label}: layout (${path_})`, !s.overflow && s.rawKeys.length === 0 && s.dir === (LANG === 'ar' ? 'rtl' : 'ltr'),
    `dir=${s.dir} overflow=${s.overflow} rawKeys=${s.rawKeys.join(',') || '-'}`);
}
const acceptCookies = async () => {
  const b = p.getByRole('button', { name: /accept all|قبول الكل/i });
  if (await b.count()) await b.first().click().catch(() => {});
};
const T = LANG === 'ar'
  ? { cont: /^متابعة$/, finish: /^إنهاء$/, finishForNow: /إنهاء الآن والمتابعة لاحقاً/, startCheckout: /بدء عملية الدفع/, toPayment: /المتابعة إلى الدفع/, backToSetup: /العودة إلى الإعداد/, cancelPayment: /إلغاء الدفعة/, required: 'مطلوبة', recommended: 'موصى بها' }
  : { cont: /^continue$/i, finish: /^finish$/i, finishForNow: /finish for now/i, startCheckout: /start checkout/i, toPayment: /continue to payment/i, backToSetup: /back to setup/i, cancelPayment: /cancel payment/i, required: 'Required', recommended: 'Recommended' };

try {
  // --- 1. Start for Free → one-page signup ----------------------------------
  const options = await fetch(`${API}/public/signup-options`).then((r) => r.json());
  check('signup-options: organization signup on', options.organizationSignup === true);
  info(`server trial plans: ${options.trialPlans.map((pl) => pl.key).join(',')}`);

  await p.goto(`${BASE}/`); await p.waitForLoadState('networkidle'); await acceptCookies();
  const cta = p.locator('a[href^="/auth/register"]:visible').first();
  check('landing page has a visible Start-for-Free link to signup', (await cta.count()) === 1,
    (await cta.count()) ? `"${(await cta.innerText()).trim()}"` : 'none');
  if (await cta.count()) await cta.click(); else await p.goto(`${BASE}/auth/register`);
  await p.waitForURL('**/auth/register**'); await p.waitForLoadState('networkidle'); await acceptCookies();
  await p.locator('#organizationName').waitFor({ timeout: 20000 });

  check('signup: Full name, Email, Password, Confirm, Organization name present',
    (await p.locator('#name, #email, #password, #confirmPassword, #organizationName').count()) === 5);
  // Offered plans, by key (language-independent), vs the server's list.
  const offered = await p.locator('[data-testid^="trial-plan-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid').replace('trial-plan-', ''))
      .filter((k) => !['notice', 'description'].includes(k)));
  const serverKeys = options.trialPlans.map((pl) => pl.key);
  check('signup: trial plans offered = server-eligible plans exactly', offered.join(',') === serverKeys.join(','), offered.join(','));
  const submit = p.locator('form button[type=submit]');
  check('signup: exactly one primary submit action', (await submit.count()) === 1, (await submit.first().innerText()).trim());

  await p.fill('#name', 'Onboarding Verify');
  await p.fill('#email', EMAIL);
  await p.fill('#password', PASSWORD); await p.fill('#confirmPassword', PASSWORD);
  await p.fill('#organizationName', `Atlas Onboarding Verify ${JOURNEY} ${RUN}`);
  const firstPlan = options.trialPlans[0];
  if (firstPlan) await p.getByTestId(`trial-plan-${firstPlan.key}`).getByRole('radio').click();
  await p.getByRole('checkbox').first().click();
  await step('signup-filled');
  const before = visited.length;
  await submit.click();
  await p.waitForURL('**/auth/sign-in**', { timeout: 30000 });
  const between = visited.slice(before).filter((u) => !u.startsWith('/auth/register') && !u.startsWith('/auth/sign-in'));
  check('no organization-creation or plan page between signup and sign-in', between.length === 0, between.join(',') || 'direct');

  // --- 2. Atomic state -------------------------------------------------------
  const s = facts('state');
  info(`state: ${JSON.stringify(s)}`);
  check('atomic: one user', s.users === '1');
  check('atomic: organization + primary owner membership', s.organizations_owned === '1');
  check('atomic: onboarding_completed_at IS NULL', s.onboarding_completed_at_null === 'true');
  check('atomic: organization.created audited', (s.audit || '').includes('organization.created'));

  // --- 3. Sign in (prefilled, notice) → OTP -----------------------------------
  await p.waitForLoadState('networkidle');
  check('sign-in: email pre-filled', (await p.inputValue('#email')) === EMAIL);
  check('sign-in: account-created notice shown', (await p.getByTestId('account-created-notice').count()) === 1);
  await step('sign-in');
  await p.locator('#password').waitFor(); await p.waitForTimeout(500);
  await p.fill('#password', PASSWORD); await p.locator('form button[type=submit]').click();
  await p.locator('#email-otp-code').waitFor({ timeout: 30000 });
  check('OTP challenge shown (new device)', true);
  await step('otp');
  await p.fill('#email-otp-code', await code()); await p.press('#email-otp-code', 'Enter');
  await p.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30000 });
  await p.waitForURL('**/onboarding**', { timeout: 30000 }).catch(() => {});
  check('first authenticated page is /onboarding (not an empty dashboard)', new URL(p.url()).pathname.startsWith('/onboarding'), new URL(p.url()).pathname);

  // Rail semantics
  const rail = async (key) => (await p.getByTestId(`rail-step-${key}`).innerText().catch(() => '')) || '';
  if (JOURNEY === 'A') {
    check('trial granted (trialing)', (s.subscription || '').startsWith('trialing:'), s.subscription);
    check('trial redemption recorded once', s.trial_redemptions === '1');
    check('trial audited + lifecycle.trial.started queued', (s.audit || '').includes('subscription.trial.redeemed') && (s.outbox || '').includes('lifecycle.trial.started'));
    await step('onboarding-academy');
    check('rail: Academy = Required', (await rail('academy')).includes(T.required));
    check('rail: Website = Required', (await rail('website')).includes(T.required));
    check('rail: Branding = Recommended', (await rail('branding')).includes(T.recommended));
    check('rail: First course = Recommended', (await rail('course')).includes(T.recommended));

    // Academy
    const sub = `onbverify${Date.now().toString().slice(-7)}`;
    await p.locator('main input').first().fill(`Atlas Onboarding Verify Academy ${RUN}`);
    await p.fill('input[name=requestedSubdomain]', sub); await p.waitForTimeout(1500);
    await p.getByRole('button', { name: /create academy/i }).click();
    await step('academy-provisioning');
    await p.getByRole('button', { name: T.cont }).waitFor({ timeout: 300000 });
    check('Academy: provisioned', true);
    await step('academy-ready');

    // Summary before the required Website step: Finish disabled, never "ready"
    await p.getByTestId('rail-step-summary').getByRole('link').click();
    await p.waitForURL('**/onboarding/summary');
    await step('summary-required-open');
    check('Finish is disabled while Website (required) is open', await p.getByRole('button', { name: T.finish }).isDisabled());
    check('no "ready" wording while a required step is open', !/your academy is ready/i.test(await p.innerText('main')));

    // Refresh: server-derived state survives
    await p.reload(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(1500);
    check('refresh keeps the derived state (Academy still complete)', /done|complete/i.test(await rail('academy')), (await rail('academy')).replace(/\n/g, ' '));

    // Branding
    await p.getByTestId('rail-step-branding').getByRole('link').click();
    await p.waitForURL('**/onboarding/branding');
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: /upload logo/i }).first().click()]);
    await chooser.setFiles(path.join(here, 'logo.png')); await p.waitForTimeout(1500);
    await step('branding');
    await p.getByRole('button', { name: /save branding/i }).first().click();
    await p.waitForURL('**/onboarding/website', { timeout: 30000 });

    // Website
    await step('website');
    await p.getByRole('button', { name: /publish website/i }).first().click();
    await p.getByRole('button', { name: T.cont }).waitFor({ timeout: 60000 });
    await step('website-live');
    await p.getByRole('button', { name: T.cont }).click();
    await p.waitForURL('**/onboarding/course', { timeout: 30000 });

    // First course
    await step('course');
    await p.locator('main input:visible, main textarea:visible').first().fill('Onboarding Verify Course');
    await p.waitForTimeout(500);
    await p.getByRole('button', { name: /create course/i }).first().click();
    await p.waitForTimeout(3000);
    const cont = p.getByRole('button', { name: T.cont });
    if (await cont.count()) await cont.first().click();
    await p.waitForURL('**/onboarding/summary', { timeout: 30000 });
    await step('summary-ready');
    check('"Your academy is ready" once required steps are complete', /your academy is ready/i.test(await p.innerText('main')));
    const finish = p.getByRole('button', { name: T.finish });
    check('Finish enabled once required steps are complete', await finish.isEnabled());
    await finish.click();
    await p.waitForURL((u) => u.pathname.startsWith('/dashboard'), { timeout: 30000 });
    await p.waitForTimeout(3000);
    await step('dashboard');
    check('Finish → dashboard', new URL(p.url()).pathname.startsWith('/dashboard'));
    check('dashboard setup card hidden when everything is complete', (await p.getByTestId('setup-checklist-card').count()) === 0);

    const f = facts('final');
    info(`final: ${JSON.stringify(f)}`);
    check('final: onboarding completed', f.onboarding_completed === 'true');
    check('final: academy, logo, published website, course', f.academies === '1' && f.logo_set === 'true' && f.website === 'published' && Number(f.courses) >= 1);
    check('final: completion audited as finish', f.completion_audit === 'finish');
  } else {
    // --- B: trial already used → existing paid path → Finish for now --------
    check('no second trial for the same mailbox (no_plan)', (s.subscription || '').startsWith('no_plan:'), s.subscription);
    check('no trial redemption for this organization', s.trial_redemptions === '0');
    await p.waitForURL('**/onboarding/plan', { timeout: 20000 }).catch(() => {});
    await step('plan-step');
    check('Plan step offers paid plans (existing checkout)', (await p.getByTestId('plan-paid-offer').count()) >= 1);
    await p.getByTestId('plan-paid-offer').getByRole('link').first().click();
    await p.waitForURL('**/checkout/**', { timeout: 30000 });
    await step('checkout');
    const start = p.getByRole('button', { name: T.startCheckout });
    if (await start.count()) { await start.click(); await p.waitForTimeout(3000); }
    const method = p.getByRole('radio');
    if (await method.count()) {
      await method.first().click();
      await p.getByRole('button', { name: T.toPayment }).click();
      await p.waitForURL('**/payments/**', { timeout: 30000 });
      await step('payment');
      const back = p.getByTestId('payment-back-to-setup');
      check('payment page offers "Back to setup"', (await back.count()) === 1);
      await back.click(); await p.waitForURL('**/onboarding**'); await p.waitForTimeout(2500);
      await step('plan-awaiting');
      check('Plan step shows the payment as awaiting confirmation', (await p.getByTestId('plan-awaiting-confirmation').count()) === 1);
    } else {
      check('checkout offers a payment method', false, 'no payment method configured in production');
    }
    // Finish for now → dashboard card with required items open
    await p.getByTestId('onboarding-finish-for-now').click();
    await p.waitForURL((u) => u.pathname.startsWith('/dashboard'), { timeout: 30000 });
    await p.waitForTimeout(3000);
    await step('dashboard-deferred');
    const card = p.getByTestId('setup-checklist-card');
    check('Finish for now → dashboard with the setup card', (await card.count()) === 1);
    check('setup card never says "ready" while required steps are open', !/ready|جاهزة/i.test(await card.innerText().catch(() => '')));
    const f = facts('final');
    info(`final: ${JSON.stringify(f)}`);
    check('deferral stamped (onboarding_completed_at set)', f.onboarding_completed === 'true');
    check('completion audited as defer', f.completion_audit === 'defer');
    // Clean up: cancel the test payment so nothing reaches the review queue.
    if (/requires_action|pending|created|processing/.test(f.payments || '')) {
      await p.goto(`${BASE}/onboarding/plan`); await p.waitForLoadState('networkidle'); await p.waitForTimeout(2000);
      await p.getByTestId('plan-awaiting-confirmation').getByRole('link').first().click();
      await p.waitForURL('**/payments/**', { timeout: 30000 }); await p.waitForTimeout(2000);
      const cancel = p.getByRole('button', { name: T.cancelPayment });
      if (await cancel.count()) {
        await cancel.click(); await p.waitForTimeout(3000);
        const after = facts('final').payments;
        check('cleanup: test payment cancelled', /cancel/.test(after || ''), after);
      } else {
        info('cleanup: this payment method does not support cancellation; the payment stays pending for review');
      }
    }
  }
  check('no page errors or HTTP 5xx during the journey', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('journey completed without an exception', false, String(e).split('\n')[0].slice(0, 200));
  await p.screenshot({ path: path.join(OUT, `${JOURNEY}-zz-failure.png`), fullPage: true }).catch(() => {});
  info(`at ${new URL(p.url()).pathname}`);
} finally {
  await browser.close();
}
console.log(`RESULT [${JOURNEY}]: ${fails === 0 ? 'all checks passed' : `${fails} check(s) failed`}`);
process.exit(fails === 0 ? 0 : 1);
