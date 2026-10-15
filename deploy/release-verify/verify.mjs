/**
 * Atlas — runner-side half of the Final Completion release verification
 * (`Release verify` workflow). Anonymous, read-only requests against
 * production plus a real Chromium on the runner:
 *
 *   caching  the app shell is revalidated (`no-cache`), hashed assets are
 *            `immutable`, a rendered Academy page is `private, no-cache`
 *   SSR      a public Academy page is server-rendered (`X-Atlas-SSR`
 *            render|hit) in English and Arabic (`dir="rtl"`); a sign-in
 *            page is not
 *   browser  the public page loads in Chromium in EN and AR with the right
 *            direction (screenshots in $OUT)
 *   RUM      fresh visits until the 10% sample measures some: each beacon
 *            is answered 204 and carries only metric/value/route/device
 *
 *   initiative  (3 Oct 2026) the new protected APIs answer 401 to an
 *            anonymous caller, the public contact and verify-email
 *            endpoints reject an invalid body (400), and the contact
 *            page form renders in EN and AR (never submitted)
 *   holding  (D6, 14 Oct 2026) the legacy marketing site is retired: `/` and
 *            `/ar` are the noindex holding page with only the four allowed
 *            links, `/pricing` and `/features` forward to it, and the
 *            platform sitemap lists only contact and the legal pages
 *
 * No account is created, no sign-in is attempted, nothing is written except
 * the RUM samples a real visit sends. Prints PASS/FAIL/INFO lines.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL;
const HOSTS = (process.env.ACADEMY_HOSTS ?? '').split(',').filter(Boolean);
const EXPECT_SSR = process.env.EXPECT_SSR === 'on';
const RUM_VISITS = Number(process.env.RUM_VISITS ?? 40);
const OUT = process.env.OUT ?? 'out';
mkdirSync(OUT, { recursive: true });

let fails = 0;
const pass = (m) => console.log(`PASS  ${m}`);
const fail = (m) => {
  fails += 1;
  console.log(`FAIL  ${m}`);
};
const info = (m) => console.log(`INFO  ${m}`);
const check = (ok, m) => (ok ? pass(m) : fail(m));

async function get(url) {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } catch (error) {
    // One unreachable host is a failing check, not the end of the run.
    fail(`${url} could not be fetched (${error.cause?.code ?? error.message})`);
    return { status: 0, headers: new Headers(), body: '' };
  }
}

// ---- caching -------------------------------------------------------------
console.log('== Caching (app host)');
const shell = await get(`${BASE}/`);
const shellCc = shell.headers.get('cache-control') ?? '';
check(shell.status === 200, `${BASE}/ -> ${shell.status}`);
check(/no-cache/.test(shellCc), `app shell Cache-Control "${shellCc}" revalidates`);
const asset = shell.body.match(/\/assets\/[^"']+\.js/)?.[0];
if (asset) {
  const res = await fetch(`${BASE}${asset}`);
  const cc = res.headers.get('cache-control') ?? '';
  check(
    res.status === 200 && /immutable/.test(cc) && /max-age=31536000/.test(cc),
    `hashed asset ${asset} -> ${res.status} "${cc}"`
  );
  await res.arrayBuffer();
  const missing = await fetch(`${BASE}/assets/does-not-exist-${Date.now()}.js`);
  const missingCc = missing.headers.get('cache-control') ?? '';
  check(
    !/immutable/.test(missingCc),
    `a missing asset is not cached as immutable (${missing.status} "${missingCc}")`
  );
  await missing.arrayBuffer();
} else {
  fail('no /assets/*.js referenced by the app shell');
}

// ---- SSR -----------------------------------------------------------------
console.log(`== Public Academy pages (ATLAS_SSR expected ${EXPECT_SSR ? 'on' : 'off'})`);
if (HOSTS.length === 0) fail('no published Academy host to check');
for (const host of HOSTS) {
  for (const path of ['/', '/ar']) {
    const url = `https://${host}${path}`;
    const res = await get(url);
    const ssr = res.headers.get('x-atlas-ssr');
    const cc = res.headers.get('cache-control') ?? '';
    const dir = res.body.match(/<html[^>]*\sdir="(rtl|ltr)"/)?.[1];
    check(res.status === 200, `${url} -> ${res.status}`);
    // Never the platform's title or description on an Academy's site.
    const title = res.body.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    if (EXPECT_SSR) {
      check(title && title !== 'Atlas', `${url} server title "${title}" is the Academy's`);
      check(
        !res.body.includes('The operating system for education businesses.'),
        `${url} server HTML carries no Atlas description`
      );
      check(ssr === 'render' || ssr === 'hit', `${url} X-Atlas-SSR: ${ssr ?? '<none>'}`);
      check(/private/.test(cc) && /no-cache/.test(cc), `${url} rendered page Cache-Control "${cc}"`);
      check(
        dir === (path === '/ar' ? 'rtl' : 'ltr'),
        `${url} server HTML dir="${dir ?? '<none>'}"`
      );
      check(
        /<main[\s>]/.test(res.body) || /id="root"[^>]*>\s*<[a-z]/.test(res.body),
        `${url} server HTML carries rendered content`
      );
    } else {
      check(!ssr, `${url} served without the renderer (X-Atlas-SSR ${ssr ?? 'absent'})`);
    }
  }
  const privatePage = await get(`https://${host}/sign-in`);
  const privateSsr = privatePage.headers.get('x-atlas-ssr');
  check(
    privateSsr !== 'render' && privateSsr !== 'hit',
    `https://${host}/sign-in is not server-rendered (X-Atlas-SSR ${privateSsr ?? 'absent'})`
  );
  check(
    /no-cache|no-store/.test(privatePage.headers.get('cache-control') ?? ''),
    `https://${host}/sign-in Cache-Control "${privatePage.headers.get('cache-control')}"`
  );
}

// ---- platform-wide initiative (3 Oct 2026) -------------------------------
// Anonymous only: the new protected APIs refuse without a session, and the
// public endpoints reject an invalid body before anything is stored. No
// enquiry is sent and no token is ever valid, so nothing is written.
console.log('== Platform-wide initiative (anonymous)');
const API = `${BASE}/api/v1`;
const NIL = '00000000-0000-4000-8000-000000000000';
async function api(method, path, body) {
  try {
    const res = await fetch(`${API}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.status;
  } catch (error) {
    fail(`${method} /api/v1/${path} could not be fetched (${error.cause?.code ?? error.message})`);
    return 0;
  }
}
for (const path of [
  'platform/contact-submissions',
  `academies/${NIL}/course-orders`,
  `academies/${NIL}/activity`,
  'audit-log/feed',
]) {
  const status = await api('GET', path);
  check(status === 401, `GET /api/v1/${path} without a session -> ${status} (401 expected)`);
}
{
  const status = await api('POST', 'public/contact', {});
  check(status === 400, `POST /api/v1/public/contact with an empty body -> ${status} (400, nothing stored)`);
}
{
  const status = await api('POST', 'auth/verify-email', { token: 'not-a-token' });
  check(status === 400, `POST /api/v1/auth/verify-email with a malformed token -> ${status} (400)`);
}

// ---- Large-Scale initiative (4 Oct 2026) -------------------------------
// Anonymous only: every new protected API exists and refuses without a
// session (401, never 404 or 5xx). Nothing is created.
console.log('== Large-Scale initiative (anonymous)');
for (const path of [
  'platform-communications/email-activity',
  'platform-communications/email-activity/summary',
  'platform-communications/campaigns',
  'platform-security/summary',
  'platform-security/events',
  `academies/${NIL}/messages`,
  `academies/${NIL}/messages/quota`,
  `academies/${NIL}/me`,
  `academies/${NIL}/courses/${NIL}/publish-readiness`,
]) {
  const status = await api('GET', path);
  check(status === 401, `GET /api/v1/${path} without a session -> ${status} (401 expected)`);
}
{
  const status = await api('GET', `public/websites/${NIL}/logo`);
  check(status === 404, `GET /api/v1/public/websites/<unknown>/logo -> ${status} (404, no tenant data)`);
}
for (const path of ['plans', 'add-ons']) {
  const status = await api('GET', path);
  check(status > 0 && status < 500, `GET /api/v1/${path} -> ${status} (catalog answers, no server error)`);
}

// ---- browser + RUM -------------------------------------------------------
const browser = await chromium.launch();
console.log('== Atlas contact page (Chromium, not submitted)');
for (const locale of ['en', 'ar']) {
  const context = await browser.newContext({ locale });
  await context.addInitScript((l) => {
    try {
      localStorage.setItem('atlas:language', JSON.stringify(l));
    } catch {
      /* storage blocked: the page falls back to the browser locale */
    }
  }, locale);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const res = await page.goto(`${BASE}/contact`, { waitUntil: 'load' });
  const form = page.locator('#contact form');
  const visible = await form
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check(res?.status() === 200, `${locale.toUpperCase()} contact page loads (${res?.status()})`);
  check(visible, `${locale.toUpperCase()} contact page form is shown`);
  if (visible) {
    const fields = await form.locator('input, textarea').count();
    check(fields >= 3, `${locale.toUpperCase()} contact form has its fields (${fields})`);
  }
  const dir = await page.locator('html').getAttribute('dir');
  check(dir === (locale === 'ar' ? 'rtl' : 'ltr'), `${locale.toUpperCase()} contact page html dir="${dir}"`);
  check(errors.length === 0, `${locale.toUpperCase()} contact page has no uncaught page errors (${errors.length})`);
  await page.screenshot({ path: `${OUT}/contact-${locale}.png`, fullPage: false });
  await context.close();
}
console.log('== Legal pages, contact and the holding page (Chromium, EN + AR, desktop + 390 px)');
{
  // The public plan catalog is still served (the marketing pricing page that
  // read it was retired by D6; the B1 site will read it again).
  const catalogRes = await fetch(`${API}/public/plans`).catch(() => null);
  const catalogJson = catalogRes?.ok ? await catalogRes.json().catch(() => null) : null;
  const plans = Array.isArray(catalogJson) ? catalogJson : (catalogJson?.data ?? []);
  check(plans.length > 0, `public plan catalog answers (${plans.length} plans)`);
  const TEXT = {
    en: {
      updated: '4 October 2026',
      privacy: 'Older free trial records',
      privacyDevices: 'Lesson access records',
      terms: 'the trial of that plan starts when your account is created',
      termsOld: 'does not begin automatically',
      holding: 'Atlas is a platform for running an online academy.',
    },
    ar: {
      updated: '٤ أكتوبر ٢٠٢٦',
      privacy: 'سجلات الفترات التجريبية الأقدم',
      privacyDevices: 'سجلات الوصول إلى الدروس',
      terms: 'تبدأ الفترة التجريبية لتلك الخطة عند إنشاء حسابك',
      termsOld: 'ولا تبدأ تلقائيًا',
      holding: 'أطلس منصة لإدارة أكاديمية عبر الإنترنت.',
    },
  };
  for (const locale of ['en', 'ar']) {
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'phone', width: 390, height: 844 },
    ]) {
      const label = `${locale.toUpperCase()} ${viewport.name}`;
      const t = TEXT[locale];
      const context = await browser.newContext({ locale, viewport });
      await context.addInitScript((l) => {
        try {
          localStorage.setItem('atlas:language', JSON.stringify(l));
        } catch {
          /* storage blocked: the page falls back to the browser locale */
        }
      }, locale);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      // A failed "no sideways scroll" check names the overflow and the
      // widest elements past the right edge, so the cause is in the log.
      const overflowCheck = async (message) => {
        const px = await overflow();
        if (px <= 1) return check(true, message);
        const culprits = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          return [...document.querySelectorAll('body *')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ el, r }) => r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed')
            .sort((a, b) => b.r.right - a.r.right)
            .slice(0, 3)
            .map(({ el, r }) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).trim().split(/\s+/).slice(0, 4).join('.')} right=${Math.round(r.right)}`)
            .join(' | ');
        });
        return check(false, `${message} (${px}px past the edge: ${culprits || 'no element found'})`);
      };
      const textOf = async (selector) =>
        (await page
          .locator(selector)
          .first()
          .innerText({ timeout: 30_000 })
          .catch(() => '')) ?? '';

      let res = await page.goto(`${BASE}/privacy-policy`, { waitUntil: 'load' });
      await page
        .locator('article')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      const privacy = await textOf('article');
      check(res?.status() === 200, `${label} privacy policy loads (${res?.status()})`);
      // The closure disclosures date from 4 October 2026; later revisions
      // keep them (checked below), so any October 2026 date from the 4th on
      // passes. Arabic-Indic digits are normalised first.
      const revision = privacy
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .match(locale === 'ar' ? /(\d{1,2})\s+أكتوبر\s+2026/ : /(\d{1,2})\s+October\s+2026/);
      check(
        Boolean(revision) && Number(revision[1]) >= 4,
        `${label} privacy policy is the ${TEXT.en.updated} revision or later (${revision ? revision[0] : 'no date found'})`,
      );
      check(
        privacy.includes(t.privacy) && privacy.includes(t.privacyDevices),
        `${label} privacy policy carries the closure disclosures`,
      );
      await overflowCheck(`${label} privacy policy has no sideways scroll`);

      res = await page.goto(`${BASE}/terms`, { waitUntil: 'load' });
      await page
        .locator('#trials')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      const trials = await textOf('#trials');
      check(res?.status() === 200, `${label} terms load (${res?.status()})`);
      check(
        trials.includes(t.terms) && !trials.includes(t.termsOld),
        `${label} terms describe the signup trial`,
      );
      await overflowCheck(`${label} terms have no sideways scroll`);

      // The shared public header (the 8 Oct overflow regression) is checked
      // on the contact page now that the pricing page is retired.
      res = await page.goto(`${BASE}/contact`, { waitUntil: 'load' });
      await page
        .locator('#contact form')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      await overflowCheck(`${label} contact page has no sideways scroll`);

      // D6 — the holding page: one sentence, four destinations, noindex.
      const home = locale === 'ar' ? '/ar' : '/';
      res = await page.goto(`${BASE}${home}`, { waitUntil: 'load' });
      const holding = page.getByTestId('holding-page');
      const holdingShown = await holding
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      check(res?.status() === 200 && holdingShown, `${label} ${home} is the holding page (${res?.status()})`);
      if (holdingShown) {
        const holdingText = (await holding.innerText().catch(() => '')) ?? '';
        check(holdingText.includes(t.holding), `${label} holding page carries its one sentence`);
        check(
          !/free/i.test(holdingText) && !holdingText.includes('مجان'),
          `${label} holding page never says "free"`,
        );
        const hrefs = await holding
          .locator('a[href]')
          .evaluateAll((as) => as.map((a) => new URL(a.href).pathname + new URL(a.href).search));
        const allowed = ['/auth/sign-in', '/contact?topic=sales', '/privacy-policy', '/terms', locale === 'ar' ? '/' : '/ar'];
        check(
          allowed.every((h) => hrefs.includes(h)) && hrefs.every((h) => allowed.includes(h)),
          `${label} holding page links only to sign-in, contact, legal pages and the other language (${hrefs.join(' ')})`,
        );
        const robots = await page.locator('meta[name="robots"]').getAttribute('content').catch(() => null);
        check(robots === 'noindex, follow', `${label} holding page is noindex, follow (${robots})`);
        check((await page.title()) === 'Atlas', `${label} holding page title is "Atlas"`);
        const holdingDir = await holding.getAttribute('dir');
        check(holdingDir === (locale === 'ar' ? 'rtl' : 'ltr'), `${label} holding page dir="${holdingDir}"`);
      }
      await overflowCheck(`${label} holding page has no sideways scroll`);

      // Retired marketing addresses forward (client-side) to the holding page.
      for (const [from, to] of locale === 'ar'
        ? [['/ar/pricing', '/ar']]
        : [
            ['/pricing', '/'],
            ['/features', '/'],
          ]) {
        await page.goto(`${BASE}${from}`, { waitUntil: 'load' });
        const landed = await page
          .waitForURL((u) => u.pathname === to, { timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        check(landed, `${label} ${from} forwards to ${to} (${new URL(page.url()).pathname})`);
      }
      check(
        errors.length === 0,
        `${label} legal, contact and holding pages raise no page errors (${errors.length})`,
      );
      await page.screenshot({
        path: `${OUT}/holding-${locale}-${viewport.name}.png`,
        fullPage: false,
      });
      await context.close();
    }
  }
}
if (HOSTS[0]) {
  console.log('== Browser (Chromium)');
  for (const [locale, path] of [
    ['en', '/'],
    ['ar', '/ar'],
  ]) {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`https://${HOSTS[0]}${path}`, { waitUntil: 'load' });
    await page.locator('main').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    const dir = await page.locator('html').getAttribute('dir');
    check(res?.status() === 200, `${locale.toUpperCase()} page loads (${res?.status()})`);
    check(dir === (locale === 'ar' ? 'rtl' : 'ltr'), `${locale.toUpperCase()} html dir="${dir}"`);
    check(errors.length === 0, `${locale.toUpperCase()} no uncaught page errors (${errors.length})`);
    const docTitle = await page.title();
    check(docTitle !== 'Atlas', `${locale.toUpperCase()} browser title "${docTitle}" is the Academy's`);
    const icons = await page
      .locator('head link[rel~="icon"]')
      .evaluateAll((links) => links.map((l) => l.getAttribute('href')));
    info(`${locale.toUpperCase()} icon links: ${JSON.stringify(icons)}`);
    check(icons.length === 1, `${locale.toUpperCase()} exactly one favicon link`);
    if (icons[0]?.includes('/favicon?v=')) {
      const icon = await page.request.get(new URL(icons[0], page.url()).toString());
      check(
        icon.status() === 200 && /^image\//.test(icon.headers()['content-type'] ?? ''),
        `${locale.toUpperCase()} Academy favicon served (${icon.status()} ${icon.headers()['content-type']})`
      );
    }
    await page.screenshot({ path: `${OUT}/public-${locale}.png`, fullPage: true });
    await context.close();
  }

  console.log(`== RUM (up to ${RUM_VISITS} fresh visits; the build samples 10%)`);
  const allowed = new Set(['metric', 'value', 'route', 'device']);
  let beacons = 0;
  let accepted = 0;
  let clean = true;
  let sampledVisits = 0;
  for (let visit = 1; visit <= RUM_VISITS && beacons < 3; visit += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    let sent = 0;
    page.on('request', (req) => {
      if (!req.url().includes('/rum/vitals')) return;
      sent += 1;
      beacons += 1;
      try {
        for (const sample of JSON.parse(req.postData() ?? '{}').samples ?? []) {
          if (Object.keys(sample).some((k) => !allowed.has(k))) clean = false;
        }
      } catch {
        clean = false;
      }
    });
    page.on('response', (res) => {
      if (res.url().includes('/rum/vitals') && res.status() === 204) accepted += 1;
    });
    await page.goto(`https://${HOSTS[0]}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.mouse.click(5, 5);
    // web-vitals reports CLS/INP (and LCP if not yet) as the page is hidden.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1500);
    if (sent > 0) sampledVisits += 1;
    await context.close();
  }
  if (RUM_VISITS === 0) {
    // `rum_visits: 0` is a deliberate "no RUM visits" run (e.g. a storage
    // or server-facts check), not a failed measurement.
    info('RUM not measured (rum_visits=0)');
  } else {
    info(`visits measured: ${sampledVisits}; beacons sent: ${beacons}; answered 204: ${accepted}`);
    check(beacons > 0, 'at least one real visit sent RUM samples');
    check(beacons > 0 && accepted === beacons, `every beacon answered 204 (${accepted}/${beacons})`);
    check(clean, 'beacons carry only metric, value, route and device (no URL, id or user)');
  }
}
await browser.close();

console.log(`== Result: ${fails} failing check(s)`);
process.exit(fails === 0 ? 0 : 1);
