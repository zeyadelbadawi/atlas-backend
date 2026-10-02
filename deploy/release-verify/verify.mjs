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
  const res = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    redirect: 'manual',
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
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

// ---- browser + RUM -------------------------------------------------------
const browser = await chromium.launch();
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
  info(`visits measured: ${sampledVisits}; beacons sent: ${beacons}; answered 204: ${accepted}`);
  check(beacons > 0, 'at least one real visit sent RUM samples');
  check(beacons > 0 && accepted === beacons, `every beacon answered 204 (${accepted}/${beacons})`);
  check(clean, 'beacons carry only metric, value, route and device (no URL, id or user)');
}
await browser.close();

console.log(`== Result: ${fails} failing check(s)`);
process.exit(fails === 0 ? 0 : 1);
