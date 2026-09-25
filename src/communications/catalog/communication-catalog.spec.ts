/**
 * The catalogue is the ONLY place a communication's category, priority,
 * in-app type, retention class, template and dedupe rule is decided, so a
 * mistake here is invisible at every call site and shows up only as a
 * wrong (or missing, or duplicated) message in production. This spec is
 * the guard:
 *
 *  - every key is STRUCTURALLY complete and uses real enum members, so a
 *    new entry cannot be added with a typo'd category/priority/type that
 *    Postgres would only reject at INSERT time, inside someone's business
 *    transaction;
 *  - every key has a template that actually exists and renders in BOTH
 *    locales (§24's "a Jest test mirrors the frontend translation-parity
 *    test") — a missing `ar` locale would otherwise surface as a thrown
 *    render in the dispatcher, i.e. an email nobody receives;
 *  - the keys that must NEVER dedupe still return `null` — a security
 *    alert or a support reply that got a dedupe key would be silently
 *    swallowed the second time it mattered;
 *  - and, most importantly, the twenty events migrated onto the outbox
 *    keep the EXACT `dedupeKey` string they had as `NotificationFanoutService`
 *    calls. `notifications.dedupe_key` is a persisted unique column: a
 *    changed shape does not fail, it just stops matching the rows already
 *    in the table, so a redelivered webhook or a retried job would notify
 *    a person a second time about something they were already told. The
 *    table below is the pre-migration shape, copied from the call sites
 *    this module replaced (git diff of the producers) and from §8/§19 of
 *    `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md`.
 */
import {
  CommunicationCategory,
  NotificationPriority,
  NotificationRetentionClass,
  NotificationType,
} from '@prisma/client';
import {
  COMMUNICATION_CATALOG,
  COMMUNICATION_EVENT_KEYS,
  catalogEntry,
  isCommunicationEventKey,
  type CommunicationEventKey,
  type CommunicationRuleContext,
} from './communication-catalog';
import { TemplateRegistry } from '../templates/template-registry';

const CATEGORIES = new Set<string>(Object.values(CommunicationCategory));
const PRIORITIES = new Set<string>(Object.values(NotificationPriority));
const NOTIFICATION_TYPES = new Set<string>(Object.values(NotificationType));
const RETENTION_CLASSES = new Set<string>(Object.values(NotificationRetentionClass));
const EMAIL_POLICIES = new Set(['always', 'preference', 'digest', 'never']);
const IN_APP_POLICIES = new Set(['always', 'never']);
const AUDIENCES = new Set(['learner', 'staff', 'platform']);
const LOCALE_RULES = new Set(['user', 'academy', 'platform']);
const BRANDING_RULES = new Set(['academy', 'platform']);

/** Fixed, obviously-synthetic ids so an expected dedupe string reads as the shape it is. */
const ENTITY_ID = 'e1111111-1111-4111-8111-111111111111';
const STUDENT_ID = 's2222222-2222-4222-8222-222222222222';
const STARTS_AT_MS = 1790000000000;
const REVOKED_AT_MS = 1790000009999;
const DEAUTHORIZED_AT = '2026-09-25T10:00:00.000Z';
/** The instant a C3 roster/enrollment transition happened — see §19 on repeating events. */
const DECIDED_AT_MS = 1790000005555;
const EXPIRES_AT_MS = 1793000000000;
/** The calendar day a repeating, self-damping event was first seen — see `device.limit_reached`. */
const OCCURRED_ON = '2026-09-25';

/**
 * The pre-outbox dedupe string for every migrated key, and the values the
 * producer passes to reproduce it. `null` means the event legitimately
 * never dedupes.
 */
const EXPECTED_DEDUPE: Record<
  CommunicationEventKey,
  { readonly values: Record<string, unknown>; readonly expected: string | null }
> = {
  // --- Provisioning (P14, `ProvisioningOrchestratorService`)
  'provisioning.completed': {
    values: {},
    expected: `provisioning_completed:${ENTITY_ID}`,
  },
  'provisioning.failed': {
    values: { stepKey: 'subdomain' },
    expected: `provisioning_failed:${ENTITY_ID}:subdomain`,
  },

  // --- Course commerce (P13)
  'course.order.paid': {
    values: {},
    expected: `course_order_paid:${ENTITY_ID}`,
  },
  'course.order.payment_failed': {
    values: {},
    expected: `course_order_payment_failed:${ENTITY_ID}`,
  },
  'course.order.refunded': {
    values: {},
    expected: `course_order_refunded:${ENTITY_ID}`,
  },

  // --- Platform subscription billing (P12)
  'platform.payment.approved': {
    values: {},
    expected: `payment_approved:${ENTITY_ID}`,
  },
  'platform.payment.rejected': {
    values: {},
    expected: `payment_rejected:${ENTITY_ID}`,
  },

  // --- Support (P15)
  'support.case.reply': { values: {}, expected: null },
  'support.case.status_changed': {
    values: { status: 'resolved' },
    expected: `support_case_status_changed:${ENTITY_ID}:resolved`,
  },

  // --- Account security (P1/P17) — every one of these must fire every time.
  'auth.password.changed': { values: {}, expected: null },
  // P64 C4 — a resend MUST produce a second email, so this one can never
  // carry a dedupe key; the `values` are what the OTP template renders.
  'auth.email.otp': { values: { code: '123456', expiresInMinutes: 10 }, expected: null },
  'auth.email.verification': { values: { token: 'tok' }, expected: null },
  'auth.password.reset': { values: { token: 'tok' }, expected: null },
  'auth.password.reset_confirmed': { values: {}, expected: null },

  // --- Live sessions (Phase 12, `LiveSessionNotificationsService`)
  'live_session.recording_available': {
    values: {},
    expected: `live-session:${ENTITY_ID}:recording-available`,
  },
  'live_session.scheduled': {
    values: { studentId: STUDENT_ID, startsAtMs: STARTS_AT_MS },
    expected: `live-session:${ENTITY_ID}:scheduled:${STUDENT_ID}`,
  },
  'live_session.rescheduled': {
    values: { studentId: STUDENT_ID, startsAtMs: STARTS_AT_MS },
    expected: `live-session:${ENTITY_ID}:rescheduled:${STARTS_AT_MS}:${STUDENT_ID}`,
  },
  'live_session.cancelled': {
    values: { studentId: STUDENT_ID, startsAtMs: STARTS_AT_MS },
    expected: `live-session:${ENTITY_ID}:cancelled:${STUDENT_ID}`,
  },
  'live_session.starting_soon': {
    values: { studentId: STUDENT_ID, startsAtMs: STARTS_AT_MS },
    expected: `live-session:${ENTITY_ID}:starting_soon:${STARTS_AT_MS}:${STUDENT_ID}`,
  },
  'live_provider.deauthorized': {
    values: { deauthorizedAt: DEAUTHORIZED_AT },
    expected: `live_provider.deauthorized:${ENTITY_ID}:${DEAUTHORIZED_AT}`,
  },

  // --- Assessments (P64 Phase 3)
  'assessment.assignment.graded': {
    values: { revision: 2 },
    expected: `assignment_submission.graded:${ENTITY_ID}:2`,
  },
  'assessment.quiz.graded': {
    values: {},
    expected: `quiz_attempt.graded:${ENTITY_ID}`,
  },

  // --- Certificates (P64 Phase 3)
  'certificate.issued': {
    values: { version: 1 },
    expected: `certificate.issued:${ENTITY_ID}:1`,
  },
  'certificate.revoked': {
    values: { revokedAtMs: REVOKED_AT_MS },
    expected: `certificate.revoked:${ENTITY_ID}:${REVOKED_AT_MS}`,
  },

  // --- Enrollment access and roster decisions (P64 Communications C3).
  // These keys are NEW, so there is no pre-migration string to preserve —
  // what the table pins instead is the shape chosen here, which becomes
  // the persisted `notifications.dedupe_key` from the first deploy on and
  // is then just as unchangeable as the twenty above.
  'enrollment.granted': {
    values: { grantedAtMs: DECIDED_AT_MS, courseId: 'c1' },
    expected: `enrollment.granted:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'enrollment.revoked': {
    values: { revokedAtMs: DECIDED_AT_MS },
    expected: `enrollment.revoked:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'enrollment.expiry_changed': {
    values: { expiresAtMs: EXPIRES_AT_MS, courseId: 'c1' },
    expected: `enrollment.expiry_changed:${ENTITY_ID}:${EXPIRES_AT_MS}`,
  },
  'roster.student.approved': {
    values: { decidedAtMs: DECIDED_AT_MS },
    expected: `roster.student.approved:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'roster.student.rejected': {
    values: { decidedAtMs: DECIDED_AT_MS },
    expected: `roster.student.rejected:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'roster.student.blocked': {
    values: { decidedAtMs: DECIDED_AT_MS },
    expected: `roster.student.blocked:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'roster.student.unblocked': {
    values: { decidedAtMs: DECIDED_AT_MS },
    expected: `roster.student.unblocked:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'course.order.proof_submitted': {
    values: {},
    expected: `course_order_proof_submitted:${ENTITY_ID}`,
  },
  'review.moderated': {
    values: { status: 'approved', courseId: 'c1' },
    expected: `course_review.moderated:${ENTITY_ID}:approved`,
  },

  // --- P64 Communications C3, second pass (plan §8 B1-B4/C1/D1-D2/E4-E6/H1).
  // New keys again: what is pinned is the shape chosen, which becomes the
  // persisted `notifications.dedupe_key` from the first deploy on.
  'enrollment.self_enrolled': {
    values: { courseId: 'c1', courseTitle: 'Algebra' },
    expected: `enrollment.self_enrolled:${ENTITY_ID}`,
  },
  'course.order.created': {
    values: { courseTitle: 'Algebra', amount: '49.00', currency: 'AED' },
    expected: `course_order_created:${ENTITY_ID}`,
  },
  'course.order.expired': {
    values: { courseTitle: 'Algebra', courseId: 'c1' },
    expected: `course_order_expired:${ENTITY_ID}`,
  },
  'assessment.quiz.auto_submitted': {
    values: { quizTitle: 'Unit 1', reason: 'timeout', courseId: 'c1', quizId: 'q1' },
    expected: `quiz_attempt.auto_submitted:${ENTITY_ID}`,
  },
  'assessment.attempt.invalidated': {
    values: {
      quizTitle: 'Unit 1',
      invalidatedAtMs: DECIDED_AT_MS,
      reason: 'Duplicate submission',
      academyName: 'Falcon',
      courseId: 'c1',
      quizId: 'q1',
    },
    expected: `quiz_attempt.invalidated:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'course.completed': {
    values: { completedAtMs: DECIDED_AT_MS, courseId: 'c1', courseTitle: 'Algebra' },
    expected: `course.completed:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'device.registered': {
    values: { deviceLabel: 'Chrome on macOS' },
    expected: `device.registered:${ENTITY_ID}`,
  },
  'device.removed': {
    values: { deviceLabel: 'Chrome on macOS' },
    expected: `device.removed:${ENTITY_ID}`,
  },
  'device.limit_reached': {
    values: { occurredOn: OCCURRED_ON, maxDevices: 2 },
    expected: `device.limit_reached:${ENTITY_ID}:${OCCURRED_ON}`,
  },
  'session.taken_over': {
    values: {
      takenOverAtMs: DECIDED_AT_MS,
      deviceLabel: 'Chrome on macOS',
      previousDeviceLabel: 'Safari on iOS',
    },
    expected: `session.taken_over:${ENTITY_ID}:${DECIDED_AT_MS}`,
  },
  'announcement.published': {
    values: { title: 'Exam week', academyName: 'Falcon', courseId: 'c1' },
    expected: `announcement.published:${ENTITY_ID}`,
  },
};

/** Keys whose contract is "fire every time" — a dedupe key here is a bug. */
const NEVER_DEDUPED_KEYS: readonly CommunicationEventKey[] = [
  'auth.password.changed',
  'auth.email.otp',
  'auth.email.verification',
  'auth.password.reset',
  'auth.password.reset_confirmed',
  'support.case.reply',
];

function context(values: Record<string, unknown> = {}): CommunicationRuleContext {
  return { entity: { type: 'fixture', id: ENTITY_ID }, values };
}

describe('COMMUNICATION_CATALOG', () => {
  it('exposes every key exactly once, and `isCommunicationEventKey` agrees', () => {
    expect(COMMUNICATION_EVENT_KEYS.length).toBe(new Set(COMMUNICATION_EVENT_KEYS).size);
    expect(COMMUNICATION_EVENT_KEYS.length).toBe(
      Object.keys(COMMUNICATION_CATALOG).length,
    );
    for (const key of COMMUNICATION_EVENT_KEYS) {
      expect(isCommunicationEventKey(key)).toBe(true);
      expect(catalogEntry(key)).toBe(COMMUNICATION_CATALOG[key]);
    }
    expect(isCommunicationEventKey('not.a.key')).toBe(false);
    // Nothing inherited from Object.prototype may pass as a key.
    expect(isCommunicationEventKey('toString')).toBe(false);
  });

  describe.each(COMMUNICATION_EVENT_KEYS)('%s', (key) => {
    const entry = COMMUNICATION_CATALOG[key];

    it('uses only real enum members and valid policy values', () => {
      expect(CATEGORIES.has(entry.category)).toBe(true);
      expect(PRIORITIES.has(entry.priority)).toBe(true);
      expect(NOTIFICATION_TYPES.has(entry.notificationType)).toBe(true);
      expect(RETENTION_CLASSES.has(entry.retentionClass)).toBe(true);
      expect(AUDIENCES.has(entry.audience)).toBe(true);
      expect(IN_APP_POLICIES.has(entry.channels.inApp)).toBe(true);
      expect(EMAIL_POLICIES.has(entry.channels.email)).toBe(true);
      expect(LOCALE_RULES.has(entry.locale)).toBe(true);
      expect(BRANDING_RULES.has(entry.branding)).toBe(true);
      expect(entry.cooldownSeconds).toBeGreaterThanOrEqual(0);
    });

    it('carries the i18n keys the in-app feed renders from', () => {
      expect(typeof entry.titleKey).toBe('string');
      expect(typeof entry.messageKey).toBe('string');
      // The frontend resolves `notifications:<path>`; a bare path renders raw.
      expect(entry.titleKey.startsWith('notifications:')).toBe(true);
      expect(entry.messageKey.startsWith('notifications:')).toBe(true);
      expect(entry.titleKey).not.toBe(entry.messageKey);
    });

    it('names a template that exists and renders in both en and ar', () => {
      expect(typeof entry.template).toBe('string');
      expect(TemplateRegistry.has(entry.template)).toBe(true);
      for (const locale of ['en', 'ar'] as const) {
        const rendered = TemplateRegistry.render(
          entry.template,
          locale,
          {
            branding: { platformName: 'Atlas', platformUrl: 'https://atlas.test' },
            actionUrl: 'https://atlas.test/somewhere',
            settingsUrl: 'https://atlas.test/settings/notifications',
          },
          EXPECTED_DEDUPE[key].values,
        );
        expect(rendered.subject.length).toBeGreaterThan(0);
        expect(rendered.text.length).toBeGreaterThan(0);
        expect(rendered.html.length).toBeGreaterThan(0);
      }
    });

    it('has a dedupe rule that is a pure function of entity + values', () => {
      expect(typeof entry.dedupe).toBe('function');
      const ctx = context(EXPECTED_DEDUPE[key].values);
      expect(entry.dedupe(ctx)).toEqual(entry.dedupe(ctx));
    });

    it('builds an action URL as a relative path when it has one', () => {
      if (!entry.actionUrl) return;
      const path = entry.actionUrl(context(EXPECTED_DEDUPE[key].values));
      // The branded host is prepended by `LinkBuilderService`; a catalogue
      // entry that returned an absolute URL would bypass the canonical-host
      // rule entirely.
      expect(path.startsWith('/')).toBe(true);
      expect(path).not.toMatch(/^https?:/);
    });
  });

  describe('dedupe keys', () => {
    it('covers every catalogue key (a new key must make a deliberate choice)', () => {
      expect(Object.keys(EXPECTED_DEDUPE).sort()).toEqual(
        [...COMMUNICATION_EVENT_KEYS].sort(),
      );
    });

    it.each(NEVER_DEDUPED_KEYS)('%s never dedupes (returns null)', (key) => {
      expect(COMMUNICATION_CATALOG[key].dedupe(context())).toBeNull();
      // Even with a full values bag — nothing can accidentally key it.
      expect(
        COMMUNICATION_CATALOG[key].dedupe(
          context({ status: 'x', version: 1, studentId: STUDENT_ID, token: 't' }),
        ),
      ).toBeNull();
    });

    it.each(Object.entries(EXPECTED_DEDUPE).filter(([, spec]) => spec.expected !== null))(
      '%s keeps its pre-migration shape',
      (key, spec) => {
        const entry = COMMUNICATION_CATALOG[key as CommunicationEventKey];
        expect(entry.dedupe(context(spec.values))).toBe(spec.expected);
      },
    );

    it('distinguishes two students of the same live session', () => {
      const entry = COMMUNICATION_CATALOG['live_session.scheduled'];
      const a = entry.dedupe(context({ studentId: 'student-a' }));
      const b = entry.dedupe(context({ studentId: 'student-b' }));
      expect(a).not.toBe(b);
    });

    it('distinguishes two reschedules of the same live session', () => {
      const entry = COMMUNICATION_CATALOG['live_session.rescheduled'];
      const first = entry.dedupe(
        context({ studentId: STUDENT_ID, startsAtMs: STARTS_AT_MS }),
      );
      const second = entry.dedupe(
        context({ studentId: STUDENT_ID, startsAtMs: STARTS_AT_MS + 86_400_000 }),
      );
      // The reschedule nobody hears about is exactly the one that matters.
      expect(first).not.toBe(second);
    });

    it('distinguishes a re-grant of the same enrollment from the first grant', () => {
      // Granted → revoked → granted again is a real sequence, and the
      // SECOND grant is the one the learner most needs to hear about. A
      // dedupe key on the enrollment id alone would swallow it.
      const entry = COMMUNICATION_CATALOG['enrollment.granted'];
      expect(entry.dedupe(context({ grantedAtMs: DECIDED_AT_MS }))).not.toBe(
        entry.dedupe(context({ grantedAtMs: DECIDED_AT_MS + 86_400_000 })),
      );
    });

    it('distinguishes a second roster decision on the same membership', () => {
      for (const key of [
        'roster.student.approved',
        'roster.student.rejected',
        'roster.student.blocked',
        'roster.student.unblocked',
      ] as const) {
        const entry = COMMUNICATION_CATALOG[key];
        expect(entry.dedupe(context({ decidedAtMs: DECIDED_AT_MS }))).not.toBe(
          entry.dedupe(context({ decidedAtMs: DECIDED_AT_MS + 1000 })),
        );
      }
    });

    it('treats a cleared enrollment expiry as its own distinct key', () => {
      const entry = COMMUNICATION_CATALOG['enrollment.expiry_changed'];
      const cleared = entry.dedupe(context({}));
      expect(cleared).toBe(`enrollment.expiry_changed:${ENTITY_ID}:cleared`);
      // Setting the SAME date twice is not news; moving it is.
      expect(entry.dedupe(context({ expiresAtMs: EXPIRES_AT_MS }))).toBe(
        entry.dedupe(context({ expiresAtMs: EXPIRES_AT_MS })),
      );
      expect(entry.dedupe(context({ expiresAtMs: EXPIRES_AT_MS }))).not.toBe(cleared);
    });

    it('distinguishes the two outcomes of moderating one review', () => {
      const entry = COMMUNICATION_CATALOG['review.moderated'];
      expect(entry.dedupe(context({ status: 'approved' }))).not.toBe(
        entry.dedupe(context({ status: 'rejected' })),
      );
    });

    it('damps the device cap to one row per academy per DAY', () => {
      // The cap is hit on EVERY refused grant — a learner poking at a
      // locked lesson would otherwise paper their own feed. Same day is
      // one row; the next day is news again.
      const entry = COMMUNICATION_CATALOG['device.limit_reached'];
      expect(entry.dedupe(context({ occurredOn: OCCURRED_ON }))).toBe(
        entry.dedupe(context({ occurredOn: OCCURRED_ON })),
      );
      expect(entry.dedupe(context({ occurredOn: '2026-09-26' }))).not.toBe(
        entry.dedupe(context({ occurredOn: OCCURRED_ON })),
      );
    });

    it('distinguishes a second takeover of the same device', () => {
      const entry = COMMUNICATION_CATALOG['session.taken_over'];
      expect(entry.dedupe(context({ takenOverAtMs: DECIDED_AT_MS }))).not.toBe(
        entry.dedupe(context({ takenOverAtMs: DECIDED_AT_MS + 1000 })),
      );
    });

    it('distinguishes a re-completion of the same enrollment', () => {
      // Voiding an attempt takes completion away; earning it back is the
      // second piece of news, and a key on the enrollment alone would eat it.
      const entry = COMMUNICATION_CATALOG['course.completed'];
      expect(entry.dedupe(context({ completedAtMs: DECIDED_AT_MS }))).not.toBe(
        entry.dedupe(context({ completedAtMs: DECIDED_AT_MS + 86_400_000 })),
      );
    });

    it('keys an auto-submitted attempt on the attempt alone', () => {
      // `updateIfInProgress` lets exactly one finaliser win, so the
      // reason must NOT enter the key: a timeout and an integrity
      // auto-submit of the same attempt cannot both happen, and letting
      // the reason vary the key would only let a retry notify twice.
      const entry = COMMUNICATION_CATALOG['assessment.quiz.auto_submitted'];
      expect(entry.dedupe(context({ reason: 'timeout' }))).toBe(
        entry.dedupe(context({ reason: 'integrity' })),
      );
    });

    it('distinguishes two versions of the same certificate', () => {
      const entry = COMMUNICATION_CATALOG['certificate.issued'];
      expect(entry.dedupe(context({ version: 1 }))).not.toBe(
        entry.dedupe(context({ version: 2 })),
      );
    });
  });

  describe('category invariants', () => {
    it('security and transactional email is never subject to a preference', () => {
      for (const key of COMMUNICATION_EVENT_KEYS) {
        const entry = COMMUNICATION_CATALOG[key];
        if (entry.category !== 'security' && entry.category !== 'transactional') continue;
        expect(['always', 'never']).toContain(entry.channels.email);
      }
    });

    it('every entry that is in-app only still declares an in-app channel', () => {
      for (const key of COMMUNICATION_EVENT_KEYS) {
        const entry = COMMUNICATION_CATALOG[key];
        if (entry.channels.email !== 'never') continue;
        expect(entry.channels.inApp).toBe('always');
      }
    });

    it('an entry with no in-app row must be emailed (otherwise it tells nobody)', () => {
      for (const key of COMMUNICATION_EVENT_KEYS) {
        const entry = COMMUNICATION_CATALOG[key];
        if (entry.channels.inApp !== 'never') continue;
        expect(entry.channels.email).not.toBe('never');
      }
    });
  });
});
