/**
 * The two decisions this workstream cannot get wrong, pinned where they
 * are cheapest to pin:
 *
 *  1. ACTIVE vs SCHEDULED. One event, two messages. Getting it backwards
 *     tells a learner to go and use an accommodation that does not open
 *     until next week — they start an ordinary attempt under the ordinary
 *     timer believing they have longer, and find out when it runs out.
 *  2. DEDUPE-KEY STABILITY. The activation sweep re-asks the same
 *     question every five minutes forever. The ONLY thing between that
 *     design and an email every five minutes is a key derived from the
 *     transition instant rather than from the tick — so the key is
 *     asserted here against the REAL catalogue rules, not against a
 *     restatement of them.
 */
import {
  COMMUNICATION_CATALOG,
  type CommunicationRuleContext,
} from '../catalog/communication-catalog';
import { TemplateRegistry } from '../templates/template-registry';
import {
  activatedValues,
  grantedValues,
  isScheduled,
  multiplierLabel,
  revokedValues,
  utcLabel,
  type QuizExceptionFacts,
} from './quiz-exception-values.util';

const OVERRIDE_ID = 'o1111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-25T12:00:00.000Z');

function facts(overrides: Partial<QuizExceptionFacts> = {}): QuizExceptionFacts {
  return {
    overrideId: OVERRIDE_ID,
    quizId: 'q1',
    quizTitle: 'Module 2 quiz',
    courseId: 'c1',
    timeMultiplier: '1.50',
    extraAttempts: 2,
    availableFrom: null,
    availableUntil: null,
    ...overrides,
  };
}

function context(values: Record<string, unknown>): CommunicationRuleContext {
  return { entity: { type: 'quiz_student_override', id: OVERRIDE_ID }, values };
}

describe('the active-vs-scheduled decision', () => {
  it('calls an exception with no start date ACTIVE', () => {
    expect(isScheduled(null, NOW)).toBe(false);
  });

  it('calls a start date in the past ACTIVE', () => {
    expect(isScheduled(new Date(NOW.getTime() - 1), NOW)).toBe(false);
    expect(isScheduled(new Date(NOW.getTime() - 86_400_000), NOW)).toBe(false);
  });

  it('calls the boundary instant itself ACTIVE, matching the engine', () => {
    // An attempt started exactly at `availableFrom` is inside the window;
    // a message calling that instant "scheduled" contradicts the page the
    // learner is looking at.
    expect(isScheduled(new Date(NOW.getTime()), NOW)).toBe(false);
  });

  it('calls a start date in the future SCHEDULED', () => {
    expect(isScheduled(new Date(NOW.getTime() + 1), NOW)).toBe(true);
    expect(isScheduled(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(true);
  });

  it('writes the decision into the values the copy reads, both ways', () => {
    const future = new Date(NOW.getTime() + 3_600_000);
    const past = new Date(NOW.getTime() - 3_600_000);
    expect(grantedValues(facts({ availableFrom: future }), NOW).scheduled).toBe(true);
    expect(grantedValues(facts({ availableFrom: past }), NOW).scheduled).toBe(false);
    expect(grantedValues(facts(), NOW).scheduled).toBe(false);
  });

  it('drives the in-app copy variant from that same flag', () => {
    const entry = COMMUNICATION_CATALOG['assessment.exception.granted'];
    const variant = (entry.variants ?? [])[0];
    expect(variant).toBeDefined();
    const future = new Date(NOW.getTime() + 3_600_000);
    expect(
      variant.when(context(grantedValues(facts({ availableFrom: future }), NOW))),
    ).toBe(true);
    expect(variant.when(context(grantedValues(facts(), NOW)))).toBe(false);
  });

  it('states the start instant the scheduled copy has to print', () => {
    const at = new Date('2026-09-30T14:05:00.000Z');
    const values = grantedValues(facts({ availableFrom: at }), NOW);
    expect(values.availableFromLabel).toBe('2026-09-30 14:05 UTC');
    // …and prints nothing at all when there is nothing to print, so no
    // template can render an empty date.
    expect(grantedValues(facts(), NOW).availableFromLabel).toBe('');
  });
});

describe('dedupe-key stability', () => {
  const activated = COMMUNICATION_CATALOG['assessment.exception.activated'];
  const granted = COMMUNICATION_CATALOG['assessment.exception.granted'];
  const revoked = COMMUNICATION_CATALOG['assessment.exception.revoked'];
  const availableFrom = new Date('2026-09-30T14:05:00.000Z');

  it('gives an activation the SAME key however often the sweep asks', () => {
    // Ten ticks, hours apart, one key. This is the whole correctness
    // property of the sweep, expressed without a database.
    const keys = new Set<string | null>();
    for (let tick = 0; tick < 10; tick++) {
      keys.add(activated.dedupe(context(activatedValues(facts({ availableFrom })))));
    }
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(
      `quiz_override.activated:${OVERRIDE_ID}:${availableFrom.getTime()}`,
    );
  });

  it('gives a MOVED window a different key — the one recurrence that is real news', () => {
    const moved = new Date(availableFrom.getTime() + 86_400_000);
    expect(activated.dedupe(context(activatedValues(facts({ availableFrom }))))).not.toBe(
      activated.dedupe(context(activatedValues(facts({ availableFrom: moved })))),
    );
  });

  it('is unaffected by anything the reviewer edits that is not the window', () => {
    const a = activatedValues(facts({ availableFrom, extraAttempts: 1 }));
    const b = activatedValues(
      facts({ availableFrom, extraAttempts: 9, timeMultiplier: '3.00' }),
    );
    expect(activated.dedupe(context(a))).toBe(activated.dedupe(context(b)));
  });

  it('keys a grant on the instant the producer computed, not on the row', () => {
    const first = granted.dedupe(context(grantedValues(facts(), NOW)));
    const again = granted.dedupe(context(grantedValues(facts(), NOW)));
    const edited = granted.dedupe(
      context(grantedValues(facts(), new Date(NOW.getTime() + 1))),
    );
    expect(first).toBe(again);
    expect(first).not.toBe(edited);
  });

  it('keys a revocation on the instant it was taken away', () => {
    expect(revoked.dedupe(context(revokedValues(facts(), NOW)))).toBe(
      `quiz_override.revoked:${OVERRIDE_ID}:${NOW.getTime()}`,
    );
  });
});

describe('how the accommodation is described', () => {
  const availableFrom = new Date('2026-09-30T14:05:00.000Z');

  it('normalises the Decimal the database returns', () => {
    expect(multiplierLabel('1.50')).toBe('1.5');
    expect(multiplierLabel('2.00')).toBe('2');
    expect(multiplierLabel(1.25)).toBe('1.25');
    expect(multiplierLabel({ toString: () => '1.75' })).toBe('1.75');
    // Never renders `NaN` into an email, whatever arrives.
    expect(multiplierLabel('not a number')).toBe('1');
  });

  it('labels an instant unambiguously, and an absent one as nothing', () => {
    expect(utcLabel(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02 03:04 UTC');
    expect(utcLabel(null)).toBe('');
  });

  it('describes the row identically in all three messages', () => {
    // The learner reads these in sequence; a multiplier that is spelled
    // `1.5` when granted and `1.50` when activated reads as a change.
    const row = facts({
      availableFrom,
      availableUntil: new Date('2026-10-01T09:00:00Z'),
    });
    const g = grantedValues(row, NOW);
    const a = activatedValues(row);
    const r = revokedValues(row, NOW);
    for (const field of [
      'quizTitle',
      'courseId',
      'quizId',
      'timeMultiplier',
      'extraAttempts',
      'availableFromLabel',
      'availableUntilLabel',
    ]) {
      expect([g[field], a[field], r[field]]).toEqual([g[field], g[field], g[field]]);
    }
  });
});

/**
 * The copy itself, rendered through the real registry — because the
 * decision above is only worth making if the two branches actually say
 * different things, and because "must NOT tell them to go and use it now"
 * is a property of the WORDS, not of the flag.
 */
describe('the granted email says two different things', () => {
  const availableFrom = new Date('2026-09-30T14:05:00.000Z');
  const INPUT = {
    branding: {
      academyName: 'Falcon Academy',
      academyHost: 'falcon.atlas.test',
      platformName: 'Atlas',
      platformUrl: 'https://app.atlas.test',
    },
    actionUrl: 'https://falcon.atlas.test/my/courses/c1/activities/q1',
    settingsUrl: 'https://falcon.atlas.test/my/profile',
  };

  function render(values: Record<string, unknown>, locale: 'en' | 'ar') {
    return TemplateRegistry.render('assessment.exception.granted', locale, INPUT, values);
  }

  const active = () => grantedValues(facts(), NOW);
  const scheduled = () => grantedValues(facts({ availableFrom }), NOW);

  it.each(['en', 'ar'] as const)(
    '%s: the ACTIVE copy invites the learner to use it, and names no future date',
    (locale) => {
      const rendered = render(active(), locale);
      expect(rendered.text).not.toContain('2026-09-30');
      expect(rendered.subject).not.toContain('2026-09-30');
      // It carries the button, because there is something to open.
      expect(rendered.text).toContain(INPUT.actionUrl);
    },
  );

  it.each(['en', 'ar'] as const)(
    '%s: the SCHEDULED copy names the start instant, in the subject and the body',
    (locale) => {
      const rendered = render(scheduled(), locale);
      expect(rendered.subject).toContain('2026-09-30 14:05 UTC');
      expect(rendered.text).toContain('2026-09-30 14:05 UTC');
    },
  );

  it('the SCHEDULED copy never tells the learner it is usable now', () => {
    const text = render(scheduled(), 'en').text.toLowerCase();
    for (const phrase of [
      'it is active now',
      'you can use it now',
      'applies to your next attempt',
    ]) {
      expect(text).not.toContain(phrase);
    }
    // …and says the opposite explicitly.
    expect(text).toContain('nothing for you to do yet');
  });

  it('the two branches are genuinely different copy, not one string', () => {
    for (const locale of ['en', 'ar'] as const) {
      const a = render(active(), locale);
      const b = render(scheduled(), locale);
      expect(a.subject).not.toBe(b.subject);
      expect(a.text).not.toBe(b.text);
    }
  });

  it('describes the accommodation itself the same way in both', () => {
    // 1.5x and 2 more attempts is the same fact whether it is open yet.
    for (const rendered of [render(active(), 'en'), render(scheduled(), 'en')]) {
      expect(rendered.text).toContain('1.5');
      expect(rendered.text).toContain('2 more attempts');
    }
  });
});
