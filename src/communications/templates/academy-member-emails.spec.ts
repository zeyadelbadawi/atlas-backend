/**
 * The academy invitation / "you've been added" emails must name the
 * academy. Production once sent "You've been added to  on Atlas": the
 * academy name reached the template as an empty string (read without a
 * tenant context under FORCE RLS), and `str()` printed it verbatim.
 *
 * Pinned here, for every template in the family, both locales and every
 * role: the real name appears in the subject and the body, and a blank or
 * missing name can never leave a hole in the sentence.
 */
import { TemplateRegistry } from './template-registry';
import type { RenderInput } from './template-registry';

const INPUT: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
  actionUrl: 'https://platform.test/auth/sign-in',
  settingsUrl: 'https://platform.test/settings/notifications',
};

const TEMPLATES = ['academy.member.added', 'academy.member.invited'] as const;
const ROLES = ['manager', 'instructor', 'student'] as const;
const LOCALES = ['en', 'ar'] as const;

/** Two spaces, or a space before a comma/period — the shape of a dropped value. */
const HOLE = /\s{2,}|\s[.,،]/;

describe('academy member emails name the academy', () => {
  describe.each(TEMPLATES)('%s', (templateId) => {
    it.each(LOCALES.flatMap((locale) => ROLES.map((role) => [locale, role] as const)))(
      '%s / %s: the academy name is in the subject and the body',
      (locale, role) => {
        const rendered = TemplateRegistry.render(templateId, locale, INPUT, {
          academyName: 'Al Shorouk Academy',
          role,
          email: 'person@example.com',
          expiresInHours: 72,
        });
        expect(rendered.subject).toContain('Al Shorouk Academy');
        expect(rendered.text).toContain('Al Shorouk Academy');
        expect(rendered.html).toContain('Al Shorouk Academy');
        expect(rendered.subject).not.toMatch(HOLE);
      },
    );

    it.each(LOCALES)(
      '%s: a blank academy name falls back to words, never a hole',
      (locale) => {
        for (const academyName of ['', '   ', undefined]) {
          const rendered = TemplateRegistry.render(templateId, locale, INPUT, {
            ...(academyName === undefined ? {} : { academyName }),
            role: 'manager',
            email: 'person@example.com',
            expiresInHours: 72,
          });
          expect(rendered.subject).not.toMatch(HOLE);
          expect(rendered.subject).not.toMatch(/to\s+on/);
          expect(rendered.text).not.toMatch(/to\s+on Atlas/);
          expect(rendered.text).not.toMatch(/access to\s+as/);
        }
      },
    );
  });
});
