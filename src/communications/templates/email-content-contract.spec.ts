/**
 * THE CONTENT CONTRACT: what a human is allowed to see in an Atlas email.
 *
 * `template-registry.spec.ts` already proves every template RENDERS in both
 * locales. This spec proves something different and, on the evidence,
 * easier to get wrong: that what renders is addressed to a PERSON.
 *
 * The bug this exists to stop was live in production — the password-reset
 * and verification emails put the raw credential into the body as
 * "Reset token: <64 hex characters>" instead of a link. Nothing threw,
 * every test stayed green, and the recipient was handed a string they
 * could do nothing with. The class of defect is wider than those two
 * messages:
 *
 *   - a token, `challengeId`, `codeHash` or database UUID printed as prose;
 *   - a template that declares a call-to-action whose catalogue entry has
 *     no `actionUrl`, so `defineLocale` silently drops the button and the
 *     reader is told to "click below" with nothing below;
 *   - a relative or `http://` destination, which is a dead link in a mail
 *     client and a downgrade attack in a security email;
 *   - an unresolved `{{placeholder}}`, a literal `undefined`, or an empty
 *     subject, none of which any existing assertion would catch.
 *
 * WHY THE ASSERTIONS ARE SHAPED, NOT SPELLED. Every check below is
 * structural: it renders EVERY template in BOTH locales and asks what KIND
 * of thing came out. Nothing here matches today's wording, so a copy
 * rewrite passes untouched — and a token that escapes into the body fails
 * immediately.
 *
 * THE SENTINEL METHOD. Rather than guessing which runs of characters look
 * opaque, this spec feeds every template a values bag that carries a
 * distinctive, obviously-machine-shaped value under EVERY key name the bug
 * class travels under (`token`, `resetToken`, `challengeId`, `codeHash`,
 * `providerMessageId`, `id`, …) and then asserts those exact strings never
 * survive into the visible body. A template that starts interpolating any
 * of them fails on the spot; one that legitimately puts a token in a link
 * passes, because the link is subtracted first. That is the whole rule,
 * expressed once: INTERNAL TOKEN ≠ USER-FACING TOKEN.
 */
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../database/prisma.service';
import { TEMPLATES, TemplateRegistry, DIGEST_TEMPLATE } from './template-registry';
import type { RenderInput } from './template-registry';
import { escapeHtml } from './layout';
import {
  COMMUNICATION_CATALOG,
  COMMUNICATION_EVENT_KEYS,
  type CommunicationEventKey,
  type CommunicationLocale,
} from '../catalog/communication-catalog';
import { LinkBuilderService } from '../services/link-builder.service';

const LOCALES = ['en', 'ar'] as const;
const PLATFORM_URL = 'https://app.atlas.test';
const ACADEMY_HOST = 'falcon.atlas.test';

/**
 * Machine-shaped sentinels, one per key name this bug class has ever used.
 *
 * They are deliberately hideous: a 64-hex credential, a UUID, a base64url
 * blob. If one of these reaches a reader, the assertion that finds it is
 * reporting a real defect, not a false positive on a course title.
 */
const OPAQUE_SENTINELS = {
  token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  resetToken: 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
  verificationToken: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  inviteToken: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  tokenHash: 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe',
  codeHash: 'b7f3a1c9e5d20486b7f3a1c9e5d20486b7f3a1c9e5d20486b7f3a1c9e5d20486',
  challengeId: 'Zm9vYmFyYmF6cXV4Y29ycmdlZ3JhdWx0Z2FycGx5',
  providerMessageId: '01JC9Z6Q7K8M4N2P5R7T9V1X3Z',
  id: '11111111-2222-4333-8444-555555555555',
} as const;

const SENTINEL_VALUES = Object.values(OPAQUE_SENTINELS);

/**
 * One values bag that satisfies every template, with the sentinels laid on
 * top. The readable half is deliberately ordinary — the point is that
 * ordinary copy renders and machine strings do not.
 */
const VALUES: Record<string, unknown> = {
  ...OPAQUE_SENTINELS,
  academyName: 'Falcon Academy',
  organizationName: 'Falcon Group',
  courseTitle: 'Applied Cryptography',
  courseCount: 3,
  assignmentTitle: 'Week 3 lab report',
  quizTitle: 'Module 2 quiz',
  score: 88,
  title: 'Live review session',
  startsAt: '2026-09-25T10:00:00.000Z',
  subject: 'Cannot upload a video',
  status: 'resolved',
  stepKey: 'subdomain',
  amount: '49.00',
  currency: 'USD',
  reason: 'Transfer reference did not match',
  // The OTP's payload: six digits, and the expiry the reader must be told.
  code: '482915',
  expiresInMinutes: 10,
  // Certificate: a human-typeable code, never the certificate's row id.
  verificationCode: 'ABCD-EFGH-JKLM',
  // Retention: the dates §31 requires these emails to state.
  anchorAtDate: '1 July 2026',
  deletionAtDate: '30 September 2026',
  deletedAtDate: '30 September 2026',
  videoCount: 12,
  videoMinutes: 430,
  deletedCount: 12,
  deletedMinutes: 430,
  failedCount: 0,
  attempts: 5,
  provider: 'bunny',
  fileName: 'module-2-intro.mp4',
  lastError: 'provider returned 409',
  trialEndsAt: '3 October 2026',
  currentPeriodEnd: '1 November 2026',
  graceEndsAt: '8 November 2026',
  planName: 'Growth',
  deviceLabel: 'Chrome on macOS',
  items: [
    { subject: 'Your assignment has been graded', url: `https://${ACADEMY_HOST}/my` },
    { subject: 'Your certificate is ready', url: null },
  ],
};

/** The platform host and an academy host, so both branding rules are exercised. */
function renderInput(
  actionUrl: string | null,
  settingsUrl: string,
  onAcademy: boolean,
): RenderInput {
  return {
    branding: onAcademy
      ? {
          academyName: 'Falcon Academy',
          academyLogoUrl: 'https://cdn.test/logo.png',
          academyHost: ACADEMY_HOST,
          platformName: 'Atlas',
          platformUrl: PLATFORM_URL,
        }
      : { platformName: 'Atlas', platformUrl: PLATFORM_URL },
    actionUrl,
    settingsUrl,
  };
}

/** The real link builder, with configuration stubs — no request, no database. */
function linkBuilder(): LinkBuilderService {
  const config = {
    getOrThrow: (key: string) => {
      if (key === 'communications')
        return { platformWebUrl: PLATFORM_URL, platformName: 'Atlas' };
      throw new Error(`Unexpected config key: ${key}`);
    },
    get: (key: string) =>
      key === 'platformDomain' ? { baseDomain: 'atlas.test' } : undefined,
  } as unknown as ConfigService;
  const prisma = {
    platformDomainConfiguration: { findFirst: async () => null },
  } as unknown as PrismaService;
  return new LinkBuilderService(config, prisma);
}

const LINKS = linkBuilder();

/**
 * Exactly what `CommunicationDispatchService.render` does: the catalogue's
 * path, built on the academy host for an academy-branded key and on the
 * platform host otherwise. Reproduced rather than imported so this spec
 * needs no Nest module — but kept in the same shape, so a change to the
 * rule is a change to one function here.
 */
function buildActionUrl(
  key: CommunicationEventKey,
  locale: CommunicationLocale,
): string | null {
  const entry = COMMUNICATION_CATALOG[key];
  const path = entry.actionUrl?.({
    entity: { type: 'entity', id: OPAQUE_SENTINELS.id },
    values: VALUES,
  });
  if (!path) return null;
  return entry.branding === 'academy'
    ? LINKS.onHost(ACADEMY_HOST, path, locale)
    : LINKS.platform(path);
}

function settingsUrl(key: CommunicationEventKey, locale: CommunicationLocale): string {
  const entry = COMMUNICATION_CATALOG[key];
  return LINKS.settings(locale, entry.branding === 'academy' ? ACADEMY_HOST : null);
}

/**
 * Removes every occurrence of the email's own URLs — in both their raw and
 * HTML-escaped spellings — so what is left is the copy a reader sees
 * around them. A token inside a link is correct; the same token in the
 * remainder is the bug.
 */
function withoutUrls(rendered: string, urls: readonly (string | null)[]): string {
  let remainder = rendered;
  for (const url of urls) {
    if (!url) continue;
    for (const spelling of [url, escapeHtml(url)]) {
      remainder = remainder.split(spelling).join(' ');
    }
  }
  return remainder;
}

/** Every rendering of one catalogue key: both locales, on its own branded host. */
function rendersOf(key: CommunicationEventKey) {
  const entry = COMMUNICATION_CATALOG[key];
  return LOCALES.map((locale) => {
    const action = buildActionUrl(key, locale);
    const settings = settingsUrl(key, locale);
    const rendered = TemplateRegistry.render(
      entry.template,
      locale,
      renderInput(action, settings, entry.branding === 'academy'),
      VALUES,
    );
    return { locale, action, settings, rendered };
  });
}

/**
 * The one template that legitimately prints machine identifiers.
 *
 * `retention.video.deletion_failed` is `audience: 'platform'` — an alert
 * to Atlas's own operators when a provider refused a deletion five times.
 * The asset id and the organisation id ARE the payload: an operator has to
 * find that asset at the provider, and no human-readable name identifies
 * it. It is exempted BY KEY and BY AUDIENCE below, never by shape, so the
 * exemption cannot silently widen to a customer-facing email.
 */
const OPERATOR_ONLY_KEYS: ReadonlySet<string> = new Set([
  'retention.video.deletion_failed',
]);

describe('email content contract', () => {
  it('exempts only operator-facing keys from the opaque-value rule', () => {
    for (const key of OPERATOR_ONLY_KEYS) {
      const entry = COMMUNICATION_CATALOG[key as CommunicationEventKey];
      expect(entry).toBeDefined();
      // A customer-facing key must never appear in this set.
      expect(entry.audience).toBe('platform');
    }
  });

  describe.each(COMMUNICATION_EVENT_KEYS)('%s', (key) => {
    const entry = COMMUNICATION_CATALOG[key];

    it('shows no opaque machine value outside a link', () => {
      if (OPERATOR_ONLY_KEYS.has(key)) return;
      for (const { rendered, action, settings } of rendersOf(key)) {
        const urls = [action, settings];
        const htmlBody = withoutUrls(rendered.html, urls);
        const textBody = withoutUrls(rendered.text, urls);
        for (const sentinel of SENTINEL_VALUES) {
          expect(htmlBody).not.toContain(sentinel);
          expect(textBody).not.toContain(sentinel);
          expect(rendered.subject).not.toContain(sentinel);
        }
      }
    });

    it('shows nothing token-SHAPED outside a link either', () => {
      if (OPERATOR_ONLY_KEYS.has(key)) return;
      // Independent of the sentinel names: any long hex run or UUID in the
      // visible copy is a machine value a reader cannot act on, whatever
      // key it arrived under.
      const HEX_RUN = /\b[0-9a-f]{32,}\b/i;
      const UUID =
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
      for (const { rendered, action, settings } of rendersOf(key)) {
        const textBody = withoutUrls(rendered.text, [action, settings]);
        expect(textBody).not.toMatch(HEX_RUN);
        expect(textBody).not.toMatch(UUID);
        expect(rendered.subject).not.toMatch(HEX_RUN);
        expect(rendered.subject).not.toMatch(UUID);
      }
    });

    it('declares a call-to-action label exactly when the catalogue has a destination', () => {
      // `defineLocale` emits the button only when BOTH exist. A label with
      // no `actionUrl` is a silently missing button; an `actionUrl` with no
      // label is a destination no email ever offers.
      const template = TEMPLATES[entry.template];
      for (const locale of LOCALES) {
        const withUrl = TemplateRegistry.render(
          entry.template,
          locale,
          renderInput(
            `https://${ACADEMY_HOST}/probe-cta-target`,
            `${PLATFORM_URL}/s`,
            false,
          ),
          VALUES,
        );
        const declaresCta = withUrl.text.includes('/probe-cta-target');
        expect(declaresCta).toBe(Boolean(entry.actionUrl));
      }
      expect(template).toBeDefined();
    });

    it('resolves its call-to-action to an absolute https URL in both locales', () => {
      if (!entry.actionUrl) return;
      for (const { rendered, action } of rendersOf(key)) {
        expect(action).not.toBeNull();
        const url = action as string;
        expect(url.startsWith('https://')).toBe(true);
        // Present as a real anchor in the html, and as a usable line in the
        // text alternative.
        expect(rendered.html).toContain(`href="${escapeHtml(url)}"`);
        expect(rendered.text).toContain(url);
        // Never a bare relative path leaking into either part.
        expect(rendered.html).not.toContain('href="/');
        expect(rendered.html).not.toContain('href="http://');
      }
    });

    it('keeps any credential in the link inside the href, never in prose', () => {
      if (!entry.actionUrl) return;
      for (const { rendered, action, settings } of rendersOf(key)) {
        const url = action as string;
        const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        if (!query) continue;
        for (const pair of query.split('&')) {
          const value = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
          if (value.length < 16) continue;
          // The credential may exist only as part of the URL itself.
          const textBody = withoutUrls(rendered.text, [action, settings]);
          const htmlBody = withoutUrls(rendered.html, [action, settings]);
          expect(textBody).not.toContain(value);
          expect(htmlBody).not.toContain(value);
          expect(rendered.subject).not.toContain(value);
        }
      }
    });

    it.each(LOCALES)('renders complete, resolved copy in %s', (locale) => {
      const action = buildActionUrl(key, locale);
      const rendered = TemplateRegistry.render(
        entry.template,
        locale,
        renderInput(action, settingsUrl(key, locale), entry.branding === 'academy'),
        VALUES,
      );
      expect(rendered.subject.trim().length).toBeGreaterThan(0);
      expect(rendered.text.trim().length).toBeGreaterThan(0);
      expect(rendered.html.trim().length).toBeGreaterThan(0);
      for (const part of [rendered.subject, rendered.text, rendered.html]) {
        // An unrendered template placeholder, of any dialect.
        expect(part).not.toMatch(/\{\{.*?\}\}/);
        expect(part).not.toContain('${');
        expect(part).not.toContain('[object Object]');
        expect(part).not.toContain('undefined');
        expect(part).not.toContain('NaN');
      }
    });
  });

  describe('the sign-in code', () => {
    const KEY: CommunicationEventKey = 'auth.email.otp';

    it('presents exactly six numeric digits as the code, on their own line', () => {
      for (const { rendered } of rendersOf(KEY)) {
        const line = rendered.text
          .split('\n')
          .map((l) => l.trim())
          .find((l) => /^\d+$/.test(l));
        expect(line).toBe(VALUES.code);
        expect(line).toMatch(/^\d{6}$/);
      }
    });

    it('carries no challenge id, token hash or link at all', () => {
      for (const { rendered, settings } of rendersOf(KEY)) {
        const textBody = withoutUrls(rendered.text, [settings]);
        const htmlBody = withoutUrls(rendered.html, [settings]);
        for (const sentinel of SENTINEL_VALUES) {
          expect(textBody).not.toContain(sentinel);
          expect(htmlBody).not.toContain(sentinel);
        }
        // §12: a sign-in code email carries no clickable action — that is
        // the shape every phishing lookalike copies. The footer's settings
        // link is the ONLY anchor the message is allowed to contain.
        expect(COMMUNICATION_CATALOG[KEY].actionUrl).toBeUndefined();
        const anchors = rendered.html.match(/<a\s/g) ?? [];
        expect(anchors).toHaveLength(1);
        expect(rendered.html).toContain(`href="${escapeHtml(settings)}"`);
      }
    });

    it('states how long the code lasts', () => {
      for (const { rendered } of rendersOf(KEY)) {
        expect(rendered.text).toContain(String(VALUES.expiresInMinutes));
      }
    });
  });

  describe('deletion warnings state the date that stops mattering', () => {
    // §31 / plan §13: "lifecycle deletion warnings state the exact date and
    // the action that stops it". The date is the only fact in these emails
    // a customer can act on, and it is passed in — so it must appear.
    const WARNINGS = COMMUNICATION_EVENT_KEYS.filter((key) =>
      key.startsWith('retention.video.warning_'),
    );

    it('covers every warning step in the sequence', () => {
      expect(WARNINGS.length).toBeGreaterThanOrEqual(4);
    });

    it.each(WARNINGS)('%s names the deletion date and offers a way out', (key) => {
      for (const { rendered, action } of rendersOf(key)) {
        expect(rendered.text).toContain(String(VALUES.deletionAtDate));
        expect(action).not.toBeNull();
        expect(rendered.text).toContain(action as string);
      }
    });
  });

  describe('the digest', () => {
    it('renders each item as a link or as plain text, never as a naked id', () => {
      for (const locale of LOCALES) {
        const rendered = TemplateRegistry.render(
          DIGEST_TEMPLATE,
          locale,
          renderInput(null, `${PLATFORM_URL}/settings`, false),
          VALUES,
        );
        for (const sentinel of SENTINEL_VALUES) {
          expect(rendered.html).not.toContain(sentinel);
          expect(rendered.text).not.toContain(sentinel);
        }
        expect(rendered.html).not.toContain('href="null"');
        expect(rendered.html).not.toContain('href="undefined"');
      }
    });
  });
});
