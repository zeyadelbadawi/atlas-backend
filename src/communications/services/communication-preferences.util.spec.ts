/**
 * One resolver answers two questions that must never disagree: "may this
 * email go out?" (the dispatcher) and "what does the person see on their
 * settings page?" (`GET /users/me/communication-preferences`). This spec
 * protects the three properties that make that safe:
 *
 *  - SECURITY / TRANSACTIONAL / LIFECYCLE ARE LOCKED ON. Nobody can be
 *    opted out of being told their password changed, their payment was
 *    rejected or their certificate was revoked — not by a stored
 *    preference, not by the legacy flag, not by garbage in the JSON column.
 *    A regression here is silent: the person simply stops being told.
 *  - THE LEGACY `notifications.email === false` FLAG MAPS TO ENGAGEMENT AND
 *    NOTHING ELSE (§23/§47). Users carry that flag from before categories
 *    existed; reading it as "no email at all" would have cancelled their
 *    receipts and security alerts on the day this shipped.
 *  - `operational` EXISTS ONLY FOR STAFF, and `users.preferences` is an
 *    untyped JSONB column, so every read of it has to survive whatever is
 *    actually in there.
 */
import {
  resolveCommunicationPreferences,
  type CommunicationPreferences,
} from './communication-preferences.util';

const LEARNER = { isStaff: false } as const;
const STAFF = { isStaff: true } as const;

function learner(preferences: unknown): CommunicationPreferences {
  return resolveCommunicationPreferences(preferences, LEARNER);
}

function staff(preferences: unknown): CommunicationPreferences {
  return resolveCommunicationPreferences(preferences, STAFF);
}

describe('resolveCommunicationPreferences', () => {
  describe('the documented shape (§23)', () => {
    it('returns every category, with operational present for staff', () => {
      expect(staff(null)).toEqual({
        language: 'en',
        categories: {
          security: { email: true, locked: true },
          transactional: { email: true, locked: true },
          lifecycle: { email: true, locked: true, reminders: true },
          engagement: { email: true, digest: 'immediate' },
          operational: { email: true, digest: 'immediate' },
        },
      });
    });

    it('gives a user with no staff membership `operational: null`', () => {
      expect(learner(null).categories.operational).toBeNull();
      expect(
        learner({ notifications: { categories: { operational: { email: false } } } })
          .categories.operational,
      ).toBeNull();
    });
  });

  describe('locked categories', () => {
    const attempts: ReadonlyArray<[string, unknown]> = [
      ['nothing stored', null],
      ['undefined', undefined],
      [
        'an explicit attempt to turn them off',
        {
          notifications: {
            categories: {
              security: { email: false, locked: false },
              transactional: { email: false, locked: false },
              lifecycle: { email: false, locked: false, reminders: false },
            },
          },
        },
      ],
      ['the legacy flag off', { notifications: { email: false } }],
      [
        'every legacy channel off',
        { notifications: { email: false, push: false, sms: false } },
      ],
    ];

    it.each(attempts)(
      'security, transactional and lifecycle stay email:true, locked:true with %s',
      (_label, preferences) => {
        for (const resolved of [learner(preferences), staff(preferences)]) {
          expect(resolved.categories.security).toEqual({ email: true, locked: true });
          expect(resolved.categories.transactional).toEqual({
            email: true,
            locked: true,
          });
          expect(resolved.categories.lifecycle.email).toBe(true);
          expect(resolved.categories.lifecycle.locked).toBe(true);
        }
      },
    );

    it('still lets lifecycle REMINDERS (the only unlocked half) be turned off', () => {
      const resolved = learner({
        notifications: { categories: { lifecycle: { reminders: false } } },
      });
      expect(resolved.categories.lifecycle).toEqual({
        email: true,
        locked: true,
        reminders: false,
      });
    });
  });

  describe('the legacy `notifications.email` flag', () => {
    it('maps `false` to engagement email off, and to nothing else', () => {
      const resolved = staff({ notifications: { email: false } });
      expect(resolved.categories.engagement.email).toBe(false);
      // Everything else is untouched by the legacy flag.
      expect(resolved.categories.engagement.digest).toBe('immediate');
      expect(resolved.categories.security.email).toBe(true);
      expect(resolved.categories.transactional.email).toBe(true);
      expect(resolved.categories.lifecycle.email).toBe(true);
      expect(resolved.categories.operational?.email).toBe(true);
    });

    it('leaves engagement on for `true` and for an absent flag', () => {
      expect(
        learner({ notifications: { email: true } }).categories.engagement.email,
      ).toBe(true);
      expect(learner({ notifications: {} }).categories.engagement.email).toBe(true);
      expect(learner({ theme: 'dark' }).categories.engagement.email).toBe(true);
    });

    it('is overridden by an explicit engagement setting in both directions', () => {
      expect(
        learner({
          notifications: { email: false, categories: { engagement: { email: true } } },
        }).categories.engagement.email,
      ).toBe(true);
      expect(
        learner({
          notifications: { email: true, categories: { engagement: { email: false } } },
        }).categories.engagement.email,
      ).toBe(false);
    });

    it('treats a non-boolean legacy flag as "not opted out" (only an exact `false` opts out)', () => {
      expect(
        learner({ notifications: { email: 'false' } }).categories.engagement.email,
      ).toBe(true);
      expect(learner({ notifications: { email: 0 } }).categories.engagement.email).toBe(
        true,
      );
      expect(
        learner({ notifications: { email: null } }).categories.engagement.email,
      ).toBe(true);
    });
  });

  describe('engagement and operational digests', () => {
    it.each(['immediate', 'daily', 'off'] as const)(
      'keeps a valid engagement digest mode (%s)',
      (digest) => {
        expect(
          learner({ notifications: { categories: { engagement: { digest } } } })
            .categories.engagement.digest,
        ).toBe(digest);
      },
    );

    it('falls back to `immediate` for an unknown engagement digest mode', () => {
      expect(
        learner({ notifications: { categories: { engagement: { digest: 'weekly' } } } })
          .categories.engagement.digest,
      ).toBe('immediate');
    });

    it.each(['immediate', 'daily'] as const)(
      'keeps a valid staff digest mode (%s)',
      (digest) => {
        expect(
          staff({ notifications: { categories: { operational: { digest } } } }).categories
            .operational?.digest,
        ).toBe(digest);
      },
    );

    it('refuses `off` as a staff digest mode — operational work can be batched, never dropped', () => {
      expect(
        staff({ notifications: { categories: { operational: { digest: 'off' } } } })
          .categories.operational?.digest,
      ).toBe('immediate');
    });

    it('honours an operational email opt-out for staff', () => {
      expect(
        staff({ notifications: { categories: { operational: { email: false } } } })
          .categories.operational,
      ).toEqual({ email: false, digest: 'immediate' });
    });
  });

  describe('language', () => {
    it.each(['en', 'ar'] as const)('keeps a validated language (%s)', (language) => {
      expect(learner({ language }).language).toBe(language);
    });

    it('falls back to `en` for anything else', () => {
      for (const language of ['fr', 'EN', '', null, 7, {}, ['ar']]) {
        expect(learner({ language }).language).toBe('en');
      }
    });
  });

  describe('garbage in the JSONB column', () => {
    const garbage: ReadonlyArray<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['an empty object', {}],
      ['a string', 'not-an-object'],
      ['a number', 42],
      ['notifications: null', { notifications: null }],
      ['categories: null', { notifications: { categories: null } }],
      [
        'wrongly-typed category values',
        {
          notifications: { categories: { engagement: { email: 'no', digest: 9 } } },
        },
      ],
      ['unrelated keys only', { theme: 'dark', timezone: 'Asia/Dubai' }],
    ];

    it.each(garbage)(
      'falls back to the documented defaults for %s',
      (_label, preferences) => {
        const resolved = staff(preferences);
        expect(resolved.language).toBe('en');
        expect(resolved.categories.security).toEqual({ email: true, locked: true });
        expect(resolved.categories.transactional).toEqual({ email: true, locked: true });
        expect(resolved.categories.lifecycle).toEqual({
          email: true,
          locked: true,
          reminders: true,
        });
        expect(resolved.categories.engagement).toEqual({
          email: true,
          digest: 'immediate',
        });
        expect(resolved.categories.operational).toEqual({
          email: true,
          digest: 'immediate',
        });
      },
    );

    it('does not throw on any of them', () => {
      for (const [, preferences] of garbage) {
        expect(() => staff(preferences)).not.toThrow();
        expect(() => learner(preferences)).not.toThrow();
      }
    });
  });
});
