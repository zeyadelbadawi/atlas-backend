/**
 * Every catalogue key must have a frontend translation, in both languages.
 *
 * WHY THIS LIVES IN THE BACKEND. The catalogue is here; the translations
 * are in the other repository. A frontend test can compare EN against AR
 * and will happily pass while BOTH are missing a key the backend just
 * added — which is exactly what happened twice. The C3 events shipped
 * with no translations, were caught by hand and fixed; then the C5
 * lifecycle events shipped the same way and the frontend parity spec
 * stayed green through all seventeen of them, because it was only ever
 * asking whether the two locales agreed with each other.
 *
 * The failure is silent and user-visible: i18next renders the raw key, so
 * an academy owner's notification feed reads
 * "notifications:events.lifecycleTrialStarted.title". Nothing throws,
 * nothing is logged, and it surfaces only when a human looks at the feed.
 *
 * SCOPE, STATED HONESTLY. This reads the sibling checkout at
 * `../atlas-front`. When that directory is absent — a CI job with only
 * this repository cloned — the spec SKIPS rather than fails, because
 * failing would only teach people to ignore it. It therefore protects
 * development, where both repositories are checked out side by side and
 * where the mistake is actually made, and claims nothing about CI. A
 * stronger guarantee needs the two repositories to share a package or a
 * generated manifest; that is a bigger change than this bug warrants.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMUNICATION_CATALOG } from './communication-catalog';

const FRONTEND_ROOT = resolve(__dirname, '../../../../atlas-front');
const LOCALES = ['en', 'ar'] as const;

function localePath(lang: string): string {
  return resolve(FRONTEND_ROOT, `src/localization/resources/${lang}/notifications.json`);
}

const available = LOCALES.every((lang) => existsSync(localePath(lang)));

/** `notifications:events.lifecycleTrialStarted.title` -> `lifecycleTrialStarted`. */
function eventName(key: string): string | null {
  const match = /^notifications:events\.([A-Za-z0-9]+)\./.exec(key);
  return match ? match[1] : null;
}

const describeIfAvailable = available ? describe : describe.skip;

describeIfAvailable('catalogue keys have frontend translations', () => {
  const events = Object.values(COMMUNICATION_CATALOG);
  const required = new Set<string>();
  for (const entry of events) {
    for (const key of [entry.titleKey, entry.messageKey]) {
      const name = eventName(key);
      if (name) required.add(name);
    }
  }

  const translations = Object.fromEntries(
    LOCALES.map((lang) => [
      lang,
      (
        JSON.parse(readFileSync(localePath(lang), 'utf8')) as {
          events?: Record<string, { title?: string; message?: string }>;
        }
      ).events ?? {},
    ]),
  );

  it('finds catalogue entries and locale files at all (guard against a vacuous pass)', () => {
    expect(required.size).toBeGreaterThan(20);
    for (const lang of LOCALES) {
      expect(Object.keys(translations[lang]).length).toBeGreaterThan(20);
    }
  });

  it.each(LOCALES)('%s translates every catalogue event', (lang) => {
    const missing = [...required].filter((name) => !translations[lang][name]).sort();
    expect(missing).toEqual([]);
  });

  it.each(LOCALES)('%s gives every catalogue event a title AND a message', (lang) => {
    const incomplete = [...required]
      .filter((name) => {
        const entry = translations[lang][name];
        return entry && !(entry.title?.trim() && entry.message?.trim());
      })
      .sort();
    expect(incomplete).toEqual([]);
  });
});
