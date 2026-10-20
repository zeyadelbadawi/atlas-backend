/**
 * B1 F.5 — the cookieless marketing beacon: only closed vocabularies are
 * kept, campaign values are mapped onto the register, the referrer is a
 * bare hostname or nothing, bots and opted-out requests are dropped,
 * batches collapse into daily aggregate increments, ingestion obeys
 * MARKETING_EVENTS_ENABLED and never fails the request, and the retention
 * prune keeps 25 months.
 */
import { MarketingEventsController } from './marketing-events.controller';
import { MarketingEventsService } from './marketing-events.service';
import {
  aggregateMarketingEvents,
  isBotUserAgent,
  normalizeReferrerDomain,
  parseMarketingBeacon,
  registeredUtm,
  requestOptedOut,
  utcDay,
} from './marketing-events.util';
import { MAX_EVENTS_PER_BEACON } from './marketing-events.vocabulary';

const base = { page: 'mkt:home', locale: 'en', device: 'mobile' } as const;
const none = { utmSource: '', utmMedium: '', utmCampaign: '', referrerDomain: '' };
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

describe('parseMarketingBeacon', () => {
  it('keeps help center events (DL-57) with their closed values only', () => {
    const docs = { page: 'docs:article', locale: 'ar', device: 'desktop' } as const;
    expect(
      parseMarketingBeacon({
        events: [
          { name: 'page_viewed', ...docs },
          { name: 'docs_helpful', ...docs, props: { value: 'yes' } },
          {
            name: 'docs_search_used',
            page: 'docs:search',
            locale: 'en',
            device: 'mobile',
            props: { value: 'no_results' },
          },
          // Free text (a query, a path) is never accepted.
          { name: 'docs_search_used', ...docs, props: { value: 'how to pay' } },
          { name: 'docs_helpful', ...docs, props: { value: 'maybe' } },
          {
            name: 'page_viewed',
            page: 'docs:/selling/refunds',
            locale: 'en',
            device: 'mobile',
          },
        ],
      }),
    ).toEqual([
      { name: 'page_viewed', ...docs, value: '', ...none },
      { name: 'docs_helpful', ...docs, value: 'yes', ...none },
      {
        name: 'docs_search_used',
        page: 'docs:search',
        locale: 'en',
        device: 'mobile',
        value: 'no_results',
        ...none,
      },
    ]);
  });

  it('keeps valid events with their closed-list value', () => {
    expect(
      parseMarketingBeacon({
        events: [
          { name: 'page_viewed', ...base },
          { name: 'section_viewed', ...base, props: { value: 's1_hero' } },
          { name: 'faq_expanded', ...base, props: { value: '3' } },
          { name: 'language_switched', ...base, props: { value: 'ar' } },
          { name: 'cta_clicked', ...base, props: { value: 'cta_pricing' } },
          { name: 'billing_toggle_changed', ...base, props: { value: 'yearly' } },
          {
            name: 'contact_form_started',
            page: 'mkt:contact',
            locale: 'ar',
            device: 'desktop',
          },
          {
            name: 'contact_form_submitted',
            page: 'mkt:contact',
            locale: 'ar',
            device: 'desktop',
          },
        ],
      }),
    ).toEqual([
      { name: 'page_viewed', ...base, value: '', ...none },
      { name: 'section_viewed', ...base, value: 's1_hero', ...none },
      { name: 'faq_expanded', ...base, value: '3', ...none },
      { name: 'language_switched', ...base, value: 'ar', ...none },
      { name: 'cta_clicked', ...base, value: 'cta_pricing', ...none },
      { name: 'billing_toggle_changed', ...base, value: 'yearly', ...none },
      {
        name: 'contact_form_started',
        page: 'mkt:contact',
        locale: 'ar',
        device: 'desktop',
        value: '',
        ...none,
      },
      {
        name: 'contact_form_submitted',
        page: 'mkt:contact',
        locale: 'ar',
        device: 'desktop',
        value: '',
        ...none,
      },
    ]);
  });

  it('drops (never stores as "other") unknown names, pages, locales, devices and values', () => {
    expect(
      parseMarketingBeacon({
        events: [
          { name: 'purchase', ...base },
          { name: 'page_viewed', ...base, page: '/pricing?email=a@b.c' },
          { name: 'page_viewed', ...base, page: 'mkt:demo' },
          { name: 'page_viewed', ...base, locale: 'fr' },
          { name: 'page_viewed', ...base, device: 'tv' },
          {
            name: 'section_viewed',
            ...base,
            props: { value: 'https://x.test/#s1_hero' },
          },
          { name: 'section_viewed', ...base },
          { name: 'faq_expanded', ...base, props: { value: '21' } },
          { name: 'faq_expanded', ...base, props: { value: 3 } },
          { name: 'cta_clicked', ...base, props: { value: 'cta_founding' } },
          { name: 'billing_toggle_changed', ...base, props: { value: 'weekly' } },
          { name: 'language_switched', ...base, props: { value: 'fr' } },
        ],
      }),
    ).toEqual([]);
  });

  it('ignores every extra field: no URL, id or free text survives', () => {
    const [event] = parseMarketingBeacon({
      events: [
        {
          name: 'page_viewed',
          ...base,
          url: 'https://atlas.test/pricing?utm_source=x#top',
          userId: 'u1',
          sessionId: 's1',
          props: { value: 'free text', email: 'a@b.c' },
        },
      ],
    });
    expect(event).toEqual({ name: 'page_viewed', ...base, value: '', ...none });
    expect(JSON.stringify(event)).not.toMatch(/https|u1|s1|@|free/);
  });

  it(`reads at most ${MAX_EVENTS_PER_BEACON} events, and nothing from a malformed body`, () => {
    const many = Array.from({ length: 30 }, () => ({
      name: 'cta_clicked',
      ...base,
      props: { value: 'cta_t' },
    }));
    expect(parseMarketingBeacon({ events: many })).toHaveLength(MAX_EVENTS_PER_BEACON);
    for (const body of [null, 'x', 42, {}, { events: 'no' }, { events: [null, 1, []] }])
      expect(parseMarketingBeacon(body)).toEqual([]);
  });

  it('campaign_landing maps UTM values onto the register and keeps a bare referrer hostname', () => {
    const [event] = parseMarketingBeacon({
      events: [
        {
          name: 'campaign_landing',
          ...base,
          props: {
            utm_source: ' Google ',
            utm_medium: 'cpc',
            utm_campaign: 'spring-sale-ahmed@example.com',
            referrer_domain: 'WWW.Example.COM',
          },
        },
      ],
    });
    expect(event).toEqual({
      name: 'campaign_landing',
      ...base,
      value: '',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'unregistered',
      referrerDomain: 'example.com',
    });
  });

  it('UTM fields are only read on campaign_landing', () => {
    const [event] = parseMarketingBeacon({
      events: [{ name: 'page_viewed', ...base, props: { utm_source: 'google' } }],
    });
    expect(event.utmSource).toBe('');
  });
});

describe('registeredUtm', () => {
  it('registered → itself, anything else → unregistered, absent/empty → ""', () => {
    expect(registeredUtm('utm_source', 'LinkedIn')).toBe('linkedin');
    expect(registeredUtm('utm_medium', 'carrier-pigeon')).toBe('unregistered');
    expect(registeredUtm('utm_campaign', 42)).toBe('unregistered');
    expect(registeredUtm('utm_campaign', undefined)).toBe('');
    expect(registeredUtm('utm_campaign', '  ')).toBe('');
  });
});

describe('normalizeReferrerDomain', () => {
  it('keeps a bare hostname, lowercased, without www.', () => {
    expect(normalizeReferrerDomain('news.ycombinator.com')).toBe('news.ycombinator.com');
    expect(normalizeReferrerDomain('WWW.Google.com.')).toBe('google.com');
    expect(normalizeReferrerDomain('xn--mgbh0fb.xn--kgbechtv')).toBe(
      'xn--mgbh0fb.xn--kgbechtv',
    );
  });

  it('drops URLs, paths, queries, fragments, ports, e-mails, phones, IPs and long values', () => {
    for (const raw of [
      'https://google.com',
      'google.com/search?q=atlas',
      'google.com?q=1',
      'google.com#x',
      'google.com:8080',
      'ahmed@example.com',
      'user:pass@example.com',
      '+201234567890',
      '201234567890.example.com',
      '192.168.1.10',
      'localhost',
      'exa mple.com',
      `${'a'.repeat(95)}.example.com`,
      42,
      null,
    ])
      expect(normalizeReferrerDomain(raw)).toBe('');
  });
});

describe('bot filter and opt-out', () => {
  it('drops crawlers, previewers, headless browsers, tools and a missing User-Agent', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'facebookexternalhit/1.1',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
      'curl/8.4.0',
      'python-requests/2.31',
      'Go-http-client/1.1',
      'GPTBot/1.0',
      'WhatsApp/2.23.20.0',
      '',
      undefined,
    ])
      expect(isBotUserAgent(ua)).toBe(true);
  });

  it('keeps real browsers', () => {
    for (const ua of [
      CHROME,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0',
    ])
      expect(isBotUserAgent(ua)).toBe(false);
  });

  it('honours Sec-GPC: 1 and DNT: 1 on the request', () => {
    const headers = (h: Record<string, string>) => (name: string) => h[name];
    expect(requestOptedOut(headers({ 'sec-gpc': '1' }))).toBe(true);
    expect(requestOptedOut(headers({ dnt: '1' }))).toBe(true);
    expect(requestOptedOut(headers({ dnt: '0' }))).toBe(false);
    expect(requestOptedOut(headers({}))).toBe(false);
  });
});

describe('aggregateMarketingEvents', () => {
  it('collapses a batch into one increment per row; once-per-page events count once', () => {
    const events = parseMarketingBeacon({
      events: [
        { name: 'page_viewed', ...base },
        { name: 'page_viewed', ...base },
        { name: 'section_viewed', ...base, props: { value: 'faq' } },
        { name: 'section_viewed', ...base, props: { value: 'faq' } },
        { name: 'cta_clicked', ...base, props: { value: 'cta_t' } },
        { name: 'cta_clicked', ...base, props: { value: 'cta_t' } },
        { name: 'cta_clicked', ...base, props: { value: 'cta_c' } },
      ],
    });
    const rows = aggregateMarketingEvents(events).map((r) => [r.name, r.value, r.count]);
    expect(rows).toEqual([
      ['page_viewed', '', 1],
      ['section_viewed', 'faq', 1],
      ['cta_clicked', 'cta_t', 2],
      ['cta_clicked', 'cta_c', 1],
    ]);
  });

  it('utcDay is midnight UTC of the moment', () => {
    expect(utcDay(new Date('2026-10-20T23:59:59+03:00')).toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    );
  });
});

describe('MarketingEventsService', () => {
  const repo = () => ({
    increment: jest.fn(async () => undefined),
    sumBetween: jest.fn(async () => []),
    deleteBefore: jest.fn(async () => 7),
  });

  it('record writes today’s aggregate increments in one call', async () => {
    const repository = repo();
    const service = new MarketingEventsService(repository as never);
    const total = await service.record(
      parseMarketingBeacon({
        events: [
          { name: 'cta_clicked', ...base, props: { value: 'cta_t' } },
          { name: 'cta_clicked', ...base, props: { value: 'cta_t' } },
        ],
      }),
      new Date('2026-10-20T10:00:00Z'),
    );
    expect(total).toBe(2);
    expect(repository.increment).toHaveBeenCalledTimes(1);
    const [day, rows] = repository.increment.mock.calls[0] as unknown as [
      Date,
      unknown[],
    ];
    expect(day.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(rows).toEqual([
      { name: 'cta_clicked', ...base, value: 'cta_t', ...none, count: 2 },
    ]);
    expect(await service.record([])).toBe(0);
    expect(repository.increment).toHaveBeenCalledTimes(1);
  });

  it('prune deletes days older than 25 months', async () => {
    const repository = repo();
    const service = new MarketingEventsService(repository as never);
    const result = await service.prune(new Date('2026-10-20T05:00:00Z'));
    expect(result).toEqual({ retentionMonths: 25, cutoff: '2024-09-20', deleted: 7 });
    const [cutoff] = repository.deleteBefore.mock.calls[0] as unknown as [Date];
    expect(cutoff.toISOString()).toBe('2024-09-20T00:00:00.000Z');
  });
});

describe('MarketingEventsController', () => {
  const beacon = { events: [{ name: 'page_viewed', ...base }] };
  const req = (headers: Record<string, string> = { 'user-agent': CHROME }) =>
    ({ headers }) as never;
  const make = (enabled: string | undefined, record = jest.fn(async () => 1)) => ({
    record,
    controller: new MarketingEventsController(
      { get: () => enabled } as never,
      { record } as unknown as MarketingEventsService,
    ),
  });

  it('records nothing unless MARKETING_EVENTS_ENABLED is exactly "true"', async () => {
    for (const flag of [undefined, 'false', 'yes', 'TRUE']) {
      const { controller, record } = make(flag);
      await controller.receive(req(), beacon);
      expect(record).not.toHaveBeenCalled();
    }
    const { controller, record } = make('true');
    await controller.receive(req(), beacon);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('drops bots, opted-out requests and empty batches', async () => {
    const { controller, record } = make('true');
    await controller.receive(req({ 'user-agent': 'Googlebot/2.1' }), beacon);
    await controller.receive(req({}), beacon);
    await controller.receive(req({ 'user-agent': CHROME, 'sec-gpc': '1' }), beacon);
    await controller.receive(req({ 'user-agent': CHROME, dnt: '1' }), beacon);
    await controller.receive(req(), { events: [{ name: 'nope', ...base }] });
    expect(record).not.toHaveBeenCalled();
  });

  it('a storage failure never fails the beacon', async () => {
    const { controller } = make(
      'true',
      jest.fn(async () => {
        throw new Error('db down');
      }),
    );
    await expect(controller.receive(req(), beacon)).resolves.toBeUndefined();
  });
});
