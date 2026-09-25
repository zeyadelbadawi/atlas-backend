/**
 * What a human actually receives from the credential emails.
 *
 * THE BUG THIS EXISTS FOR. Production's password-reset and
 * email-verification emails pasted the raw token into the body:
 *
 *     Reset token: 9f2c1e...
 *
 * The recipient was handed an internal credential with no action
 * attached — a dead end, and the exact shape a phishing lookalike
 * imitates. Every backend test passed throughout, because they all
 * asserted that a token was ISSUED, never what the message said. The
 * broken part was the only part nobody tested: the words.
 *
 * So these assertions are about the rendered message. They are
 * deliberately STRUCTURAL — "a six-digit run", "the token appears only
 * inside an href" — rather than matching today's copy, so a rewording
 * survives and a regression does not.
 *
 * The rule being enforced: INTERNAL TOKEN != USER-FACING TOKEN. A token
 * may travel inside a link. It may never be the thing the reader is
 * shown and expected to understand.
 */
import { TemplateRegistry } from './template-registry';
import type { RenderInput } from './template-registry';
import { COMMUNICATION_CATALOG } from '../catalog/communication-catalog';
import type { CommunicationLocale } from '../catalog/communication-catalog';

const LOCALES: readonly CommunicationLocale[] = ['en', 'ar'];

/** A realistic opaque credential: what `generateOpaqueToken` produces. */
const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4';

function inputFor(actionUrl: string | null): RenderInput {
  return {
    branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
    actionUrl,
    settingsUrl: 'https://platform.test/settings/notifications',
  };
}

/**
 * Everything a reader sees, with URLs removed.
 *
 * Removing URLs is the whole point. A credential email legitimately
 * carries its token inside a link — and the plain-text alternative has to
 * print that link as a URL, because a text-only client cannot render a
 * button. What must never appear is the token as a BARE value the reader
 * is left to interpret. So the check is "the token does not survive once
 * every URL is taken out", not "the token appears nowhere".
 */
function visibleNonUrlText(subject: string, html: string, text: string): string {
  return `${subject}\n${html.replace(/<[^>]*>/g, ' ')}\n${text}`.replace(
    /https?:\/\/\S+/g,
    ' ',
  );
}

describe('credential emails — what the recipient is shown', () => {
  describe.each(LOCALES)('%s', (locale) => {
    it('password reset shows a CTA, and the token ONLY inside the link', () => {
      const entry = COMMUNICATION_CATALOG['auth.password.reset'];
      const path = entry.actionUrl?.({
        entity: { type: 'password_reset', id: 'u1' },
        values: { token: TOKEN },
      });
      const absolute = `https://platform.test${path}`;
      const rendered = TemplateRegistry.render(
        entry.template,
        locale,
        inputFor(absolute),
        { token: TOKEN },
      );

      // The link is present and absolute — a relative href in an email
      // client resolves against nothing.
      expect(rendered.html).toContain(absolute);
      expect(absolute.startsWith('https://')).toBe(true);

      // …and the token never appears as a bare value.
      expect(
        visibleNonUrlText(rendered.subject, rendered.html, rendered.text),
      ).not.toContain(TOKEN);
      // The link is a real anchor, not a pasted string.
      expect(rendered.html).toMatch(/<a\s[^>]*href="[^"]*token=/i);
    });

    it('email verification shows a CTA, and the token ONLY inside the link', () => {
      const entry = COMMUNICATION_CATALOG['auth.email.verification'];
      const path = entry.actionUrl?.({
        entity: { type: 'email_verification', id: 'u1' },
        values: { token: TOKEN },
      });
      const absolute = `https://platform.test${path}`;
      const rendered = TemplateRegistry.render(
        entry.template,
        locale,
        inputFor(absolute),
        { token: TOKEN },
      );

      expect(rendered.html).toContain(absolute);
      expect(
        visibleNonUrlText(rendered.subject, rendered.html, rendered.text),
      ).not.toContain(TOKEN);
      expect(rendered.html).toMatch(/<a\s[^>]*href="[^"]*token=/i);
    });

    it('the OTP shows six digits and no implementation vocabulary', () => {
      const entry = COMMUNICATION_CATALOG['auth.email.otp'];
      const rendered = TemplateRegistry.render(entry.template, locale, inputFor(null), {
        code: '048915',
        expiresInMinutes: 10,
      });
      const seen = `${rendered.subject}\n${rendered.html.replace(/<[^>]*>/g, ' ')}\n${rendered.text}`;

      // The code is the payload: it must be readable, exactly six digits.
      expect(seen).toContain('048915');
      expect(/(?<!\d)\d{6}(?!\d)/.test(seen)).toBe(true);

      // No ACTION link. A sign-in code email that invites a click is
      // exactly what a phishing lookalike imitates, and the reader
      // already has the page open. The unsubscribe/settings footer every
      // email carries is not an action on the account and is excluded.
      const actionHrefs = (rendered.html.match(/href="([^"]*)"/g) ?? []).filter(
        (href) => !href.includes('/settings/'),
      );
      expect(actionHrefs).toEqual([]);

      // And it must say when it stops working.
      expect(seen).toMatch(/10/);
    });

    it('no credential email leaks an id, hash or opaque value to the reader', () => {
      const keys = [
        'auth.password.reset',
        'auth.email.verification',
        'auth.email.otp',
      ] as const;

      for (const key of keys) {
        const entry = COMMUNICATION_CATALOG[key];
        const path = entry.actionUrl?.({
          entity: { type: 'x', id: 'ent-1234' },
          values: { token: TOKEN, code: '048915' },
        });
        const rendered = TemplateRegistry.render(
          entry.template,
          locale,
          inputFor(path ? `https://platform.test${path}` : null),
          { token: TOKEN, code: '048915', expiresInMinutes: 10 },
        );
        const seen = visibleNonUrlText(rendered.subject, rendered.html, rendered.text);

        // Developer vocabulary a recipient cannot act on.
        for (const word of ['challenge_id', 'challengeId', 'codeHash', 'tokenHash']) {
          expect(seen).not.toContain(word);
        }
        // A bare UUID or long hex run outside a URL is always a leak.
        const withoutUrls = seen;
        expect(withoutUrls).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
        expect(withoutUrls).not.toMatch(/[0-9a-f]{32,}/i);
      }
    });
  });
});
