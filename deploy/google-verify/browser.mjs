// Google Identity — production browser check of Google on Atlas's own pages
// (the platform host) and on the allowlisted academy websites. Read-only
// apart from the one Google flow it starts (an unfinished flow row, pruned
// after 24 h). Nothing is signed in and no account is created.
//
//   - EN desktop / AR mobile: sign-in and sign-up show "Continue with
//     Google" with the password form; sign-up shows the organization fields;
//     `/auth/sign-up?plan=` lands on `/auth/register?plan=`; RTL in Arabic;
//     no horizontal overflow;
//   - the organization name typed on the sign-up page travels ONLY in this
//     tab's sessionStorage: the browser reaches accounts.google.com and no
//     URL on the way carries it;
//   - the allowlisted academy's sign-in still shows Google.
import { mkdirSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PLATFORM = process.env.PLATFORM_HOST || 'atlass.dpdns.org';
const ACADEMY_HOST = process.env.ACADEMY_HOST || 'ellzoz.atlass.dpdns.org';
const EXPECT_PLATFORM = process.env.EXPECT_PLATFORM !== 'off';
const OUT = process.env.OUT || './google-verify-out';
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

async function open(label, url, { lang = 'en', mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    locale: lang === 'ar' ? 'ar' : 'en-US',
    isMobile: mobile,
  });
  await context.addInitScript((language) => {
    try {
      localStorage.setItem('i18nextLng', language);
    } catch {
      // storage unavailable: the page's default language is used
    }
  }, lang);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(1_000);
  return { context, page };
}

async function facts(page) {
  return page.evaluate(() => ({
    google: document.querySelectorAll('[data-testid="google-auth-button"]').length,
    password: document.querySelectorAll('input[type="password"]').length,
    organization: document.querySelectorAll('[data-testid="organization-signup-fields"]').length,
    dir: document.documentElement.dir || getComputedStyle(document.body).direction,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
}

for (const variant of [
  { lang: 'en', mobile: false, tag: 'en-desktop' },
  { lang: 'ar', mobile: true, tag: 'ar-mobile' },
]) {
  for (const [page, path] of [
    ['sign-in', '/auth/sign-in'],
    ['sign-up', '/auth/register'],
  ]) {
    const { context, page: p } = await open(page, `https://${PLATFORM}${path}`, variant);
    const f = await facts(p);
    const label = `platform ${page} (${variant.tag})`;
    check(`${label}: Google button ${EXPECT_PLATFORM ? 'shown' : 'hidden'}`, (f.google === 1) === EXPECT_PLATFORM, `buttons=${f.google}`);
    check(`${label}: password form still there`, f.password >= 1, `password inputs=${f.password}`);
    if (page === 'sign-up') check(`${label}: organization fields shown`, f.organization === 1);
    if (variant.lang === 'ar') check(`${label}: right-to-left`, f.dir === 'rtl', f.dir);
    check(`${label}: no horizontal overflow`, !f.overflow);
    await p.screenshot({ path: `${OUT}/platform-${page}-${variant.tag}.png`, fullPage: true });
    await context.close();
  }
}

// /auth/sign-up is the sign-up page, and keeps ?plan=.
{
  const { context, page } = await open('alias', `https://${PLATFORM}/auth/sign-up?plan=starter`);
  const url = new URL(page.url());
  check('/auth/sign-up?plan=starter lands on /auth/register?plan=starter', url.pathname === '/auth/register' && url.searchParams.get('plan') === 'starter', url.pathname + url.search);
  await context.close();
}

// The sign-up draft travels in sessionStorage only; the browser reaches Google.
if (EXPECT_PLATFORM) {
  const marker = `Verify Org ${Date.now().toString(36)}`;
  const { context, page } = await open('carry', `https://${PLATFORM}/auth/register`);
  const urls = [];
  page.on('request', (request) => urls.push(request.url()));
  await page.fill('#organizationName', marker);
  await Promise.all([
    page.waitForURL((u) => u.hostname === 'accounts.google.com', { timeout: 30_000 }).catch(() => undefined),
    page.click('[data-testid="google-auth-button"]'),
  ]);
  const landed = new URL(page.url());
  check('Continue with Google reaches accounts.google.com', landed.hostname === 'accounts.google.com', landed.hostname + landed.pathname);
  const leaked = urls.filter((u) => decodeURIComponent(u).includes(marker));
  check('the organization name is in no URL (Atlas or Google)', leaked.length === 0, `${leaked.length} URL(s)`);
  await page.screenshot({ path: `${OUT}/platform-google-chooser.png` });
  // Back on Atlas's origin, the flow context holds the draft for the create step.
  await page.goto(`https://${PLATFORM}/auth/sign-in`, { waitUntil: 'networkidle' });
  const stored = await page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem('atlas:google-flow') || 'null');
    } catch {
      return null;
    }
  });
  check('the flow context in sessionStorage carries the organization name', stored?.signup?.organizationName === marker, stored ? `intent=${stored.intent} surface=${stored.surface}` : 'none');
  await context.close();
}

// The allowlisted academy is unchanged.
{
  const { context, page } = await open('academy', `https://${ACADEMY_HOST}/sign-in`);
  const f = await facts(page);
  check(`academy ${ACADEMY_HOST} sign-in still shows Google`, f.google === 1, `buttons=${f.google}`);
  await page.screenshot({ path: `${OUT}/academy-sign-in.png`, fullPage: true });
  await context.close();
}

await browser.close();
console.log(failures === 0 ? '\nall browser checks passed' : `\n${failures} browser check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
