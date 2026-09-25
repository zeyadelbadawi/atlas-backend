/**
 * The communication catalogue — P64 Communications C1.
 *
 * ONE typed entry per event Atlas can tell a person about. Every emitting
 * call site names an entry by key and hands over the recipient, the
 * entity and the interpolation values; everything else — category,
 * audience, channel policy, priority, in-app type, retention class,
 * dedupe rule, cooldown, locale and branding rule, template — is decided
 * HERE, once, and never at a call site. That is what makes the outbox an
 * audit vocabulary rather than a bag of ad hoc emails.
 *
 * The first twenty keys are the P17/Phase 3/Phase 12 events that existed
 * before the outbox, migrated 1:1: same `notificationType`, `priority`,
 * `titleKey`, `messageKey` and dedupe string as the fan-out call they
 * replace, so the in-app feed the frontend already renders is unchanged.
 * The three `auth.*` keys are catalogue-and-template only for now — the
 * password-reset queue and the verification email still go through the
 * provider's own narrow methods until that flow is migrated.
 *
 * `channels.email`:
 *   - `always`     — sent regardless of preference (security/transactional
 *                    facts a person must be told).
 *   - `preference` — subject to the recipient's category preference.
 *   - `digest`     — always batched into the recipient's daily digest.
 *   - `never`      — in-app only.
 */
import type {
  CommunicationCategory,
  NotificationPriority,
  NotificationRetentionClass,
  NotificationType,
} from '@prisma/client';

export type CommunicationLocale = 'en' | 'ar';
export type CommunicationAudience = 'learner' | 'staff' | 'platform';
export type CommunicationEmailPolicy = 'always' | 'preference' | 'digest' | 'never';
export type CommunicationInAppPolicy = 'always' | 'never';

export interface CommunicationEntityRef {
  readonly type: string;
  readonly id: string;
}

/** What a catalogue rule (dedupe key, action URL) may look at. */
export interface CommunicationRuleContext {
  readonly entity: CommunicationEntityRef;
  readonly values: Record<string, unknown>;
}

export interface CommunicationCatalogEntry {
  readonly category: CommunicationCategory;
  readonly audience: CommunicationAudience;
  readonly channels: {
    readonly inApp: CommunicationInAppPolicy;
    readonly email: CommunicationEmailPolicy;
  };
  readonly priority: NotificationPriority;
  readonly notificationType: NotificationType;
  readonly retentionClass: NotificationRetentionClass;
  /** Natural idempotency key per recipient, or `null` for events that never dedupe. */
  readonly dedupe: (context: CommunicationRuleContext) => string | null;
  /** Minimum seconds between two emails of this key to the same person. 0 = none. */
  readonly cooldownSeconds: number;
  /** Which language wins when the person has not chosen one. */
  readonly locale: 'user' | 'academy' | 'platform';
  /** Which brand and host the email renders under. */
  readonly branding: 'academy' | 'platform';
  /** Template id in the `TemplateRegistry` — always the key itself today. */
  readonly template: string;
  readonly titleKey: string;
  readonly messageKey: string;
  /** In-app action path and the email's call-to-action, relative to the branded host. */
  readonly actionUrl?: (context: CommunicationRuleContext) => string;
  readonly actionLabelKey?: string;
}

function str(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

const NEVER_DEDUPED = (): null => null;

/**
 * P64 C5 — the deep link every tenant-lifecycle email and in-app row
 * points at (plan §38: "trial/renewal emails deep-link to
 * `/dashboard/tenant/subscription`"). One constant, so sixteen entries
 * cannot drift apart.
 */
const TENANT_SUBSCRIPTION_PATH = '/dashboard/tenant/subscription';

/**
 * P64 C6 — the deep link every retention warning points at (plan §31:
 * "a Data & retention page under `/dashboard/tenant/retention`"). A
 * retention warning must NOT land on the billing page: §31 gives the
 * owner two ways to stop a deletion, subscribing and downloading, and
 * only the first of them lives under billing.
 */
const TENANT_RETENTION_PATH = '/dashboard/tenant/retention';

/**
 * P64 C5 — the dedupe key of one lifecycle step:
 * `lifecycle_<step>:<entity id>:<version>`.
 *
 * `version` is the step's ANCHOR — the immutable instant its timing
 * derives from (`trialEndsAt`, `currentPeriodEnd`, `graceEndsAt`, a
 * cancellation's `effectiveAt`), or, for the payment receipt, the proof
 * that was uploaded. This is the mechanism that makes a sweep re-running
 * every 15 minutes silent: the anchor has not moved, so the key is
 * byte-identical and the unique index rejects the second INSERT. It is
 * also what lets a legitimate recurrence through, because a renewed
 * period has a different anchor. §19's "events that legitimately repeat
 * carry a version in the key", applied to a sequence rather than a
 * webhook.
 */
function lifecycleKey(step: string, entityId: string, version: string): string {
  return `lifecycle_${step}:${entityId}:${version}`;
}

const CATALOG = {
  // --- Provisioning (P14) — the organisation owner who asked for the academy.
  'provisioning.completed': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'system',
    retentionClass: 'standard',
    dedupe: ({ entity }) => `provisioning_completed:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'academy',
    template: 'provisioning.completed',
    titleKey: 'notifications:events.provisioningCompleted.title',
    messageKey: 'notifications:events.provisioningCompleted.message',
    actionUrl: () => '/dashboard',
  },
  'provisioning.failed': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'system',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `provisioning_failed:${entity.id}:${str(values, 'stepKey')}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'provisioning.failed',
    titleKey: 'notifications:events.provisioningFailed.title',
    messageKey: 'notifications:events.provisioningFailed.message',
    actionUrl: () => '/dashboard',
  },

  // --- Course commerce (P13) — the buyer.
  'course.order.paid': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `course_order_paid:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'academy',
    template: 'course.order.paid',
    titleKey: 'notifications:events.courseOrderPaid.title',
    messageKey: 'notifications:events.courseOrderPaid.message',
    actionUrl: () => '/my/purchases',
  },
  'course.order.payment_failed': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `course_order_payment_failed:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'academy',
    template: 'course.order.payment_failed',
    titleKey: 'notifications:events.courseOrderPaymentFailed.title',
    messageKey: 'notifications:events.courseOrderPaymentFailed.message',
    actionUrl: () => '/my/purchases',
  },
  'course.order.refunded': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `course_order_refunded:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'academy',
    template: 'course.order.refunded',
    titleKey: 'notifications:events.courseOrderRefunded.title',
    messageKey: 'notifications:events.courseOrderRefunded.message',
    actionUrl: () => '/my/purchases',
  },

  // --- Platform subscription billing (P12) — the organisation owner.
  'platform.payment.approved': {
    category: 'transactional',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `payment_approved:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'platform.payment.approved',
    titleKey: 'notifications:events.platformPaymentApproved.title',
    messageKey: 'notifications:events.platformPaymentApproved.message',
    actionUrl: () => '/dashboard/billing',
  },
  'platform.payment.rejected': {
    category: 'transactional',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `payment_rejected:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'platform.payment.rejected',
    titleKey: 'notifications:events.platformPaymentRejected.title',
    messageKey: 'notifications:events.platformPaymentRejected.message',
    actionUrl: () => '/dashboard/billing',
  },

  // --- Support (P15) — the case requester.
  'support.case.reply': {
    category: 'operational',
    audience: 'staff',
    channels: { inApp: 'always', email: 'preference' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: NEVER_DEDUPED,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'support.case.reply',
    titleKey: 'notifications:events.supportCaseReply.title',
    messageKey: 'notifications:events.supportCaseReply.message',
    actionUrl: ({ entity }) => `/dashboard/support/${entity.id}`,
  },
  'support.case.status_changed': {
    category: 'operational',
    audience: 'staff',
    channels: { inApp: 'always', email: 'never' },
    priority: 'low',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `support_case_status_changed:${entity.id}:${str(values, 'status')}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'support.case.status_changed',
    titleKey: 'notifications:events.supportCaseStatusChanged.title',
    messageKey: 'notifications:events.supportCaseStatusChanged.message',
    actionUrl: ({ entity }) => `/dashboard/support/${entity.id}`,
  },

  // --- Account security (P1/P17).
  'auth.password.changed': {
    category: 'security',
    audience: 'platform',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'security',
    retentionClass: 'extended',
    dedupe: NEVER_DEDUPED,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'auth.password.changed',
    titleKey: 'notifications:events.passwordChanged.title',
    messageKey: 'notifications:events.passwordChanged.message',
  },
  'auth.email.verification': {
    category: 'security',
    audience: 'platform',
    channels: { inApp: 'never', email: 'always' },
    priority: 'high',
    notificationType: 'security',
    retentionClass: 'extended',
    dedupe: NEVER_DEDUPED,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'auth.email.verification',
    titleKey: 'notifications:events.emailVerification.title',
    messageKey: 'notifications:events.emailVerification.message',
    actionUrl: ({ values }) => `/verify-email?token=${str(values, 'token')}`,
  },
  /**
   * P64 Communications C4 (§12) — the emailed sign-in code.
   *
   * `inApp: 'never'` is load-bearing, not a default: the recipient has no
   * session at this point, so an in-app row could not be read anyway, and
   * writing the code into the notifications feed would leave a live
   * credential sitting in a surface that outlives it.
   *
   * `dedupe: NEVER_DEDUPED` and `cooldownSeconds: 0` are equally
   * deliberate. A resend must produce a NEW email, and the catalogue
   * cooldown DEFERS a send rather than refusing it — a deferred sign-in
   * code would arrive after it had already expired. The real resend
   * controls (60 seconds between codes, 3 codes per challenge, 5
   * challenges per account per hour) live in `EmailOtpService`, where
   * being over budget refuses the request instead of delaying the mail.
   *
   * `branding: 'academy'` resolves to the platform brand whenever no
   * academy is attached (`CommunicationBrandingService.forOutbox`), which
   * is exactly what a management-surface sign-in wants.
   */
  'auth.email.otp': {
    category: 'security',
    audience: 'platform',
    channels: { inApp: 'never', email: 'always' },
    priority: 'high',
    notificationType: 'security',
    retentionClass: 'extended',
    dedupe: NEVER_DEDUPED,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'academy',
    template: 'auth.email.otp',
    titleKey: 'notifications:events.emailOtp.title',
    messageKey: 'notifications:events.emailOtp.message',
  },
  'auth.password.reset': {
    category: 'security',
    audience: 'platform',
    channels: { inApp: 'never', email: 'always' },
    priority: 'high',
    notificationType: 'security',
    retentionClass: 'extended',
    dedupe: NEVER_DEDUPED,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'auth.password.reset',
    titleKey: 'notifications:events.passwordReset.title',
    messageKey: 'notifications:events.passwordReset.message',
    actionUrl: ({ values }) => `/reset-password?token=${str(values, 'token')}`,
  },
  'auth.password.reset_confirmed': {
    category: 'security',
    audience: 'platform',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'security',
    retentionClass: 'extended',
    dedupe: NEVER_DEDUPED,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'auth.password.reset_confirmed',
    titleKey: 'notifications:events.passwordResetConfirmed.title',
    messageKey: 'notifications:events.passwordResetConfirmed.message',
  },

  // --- Live Sessions (Phase 12).
  'live_session.recording_available': {
    category: 'operational',
    audience: 'staff',
    channels: { inApp: 'always', email: 'preference' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity }) => `live-session:${entity.id}:recording-available`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'academy',
    template: 'live_session.recording_available',
    titleKey: 'notifications:liveSession.recordingAvailable.title',
    messageKey: 'notifications:liveSession.recordingAvailable.message',
    actionUrl: () => '/dashboard/add-ons/live-sessions/recordings',
    actionLabelKey: 'notifications:liveSession.action.openRecordings',
  },
  'live_session.scheduled': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `live-session:${entity.id}:scheduled:${str(values, 'studentId')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'live_session.scheduled',
    titleKey: 'notifications:liveSession.scheduled.title',
    messageKey: 'notifications:liveSession.scheduled.message',
    actionUrl: ({ values }) => `/dashboard/learning/courses/${str(values, 'courseId')}`,
    actionLabelKey: 'notifications:liveSession.action.openCourse',
  },
  'live_session.rescheduled': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `live-session:${entity.id}:rescheduled:${str(values, 'startsAtMs')}:${str(values, 'studentId')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'live_session.rescheduled',
    titleKey: 'notifications:liveSession.rescheduled.title',
    messageKey: 'notifications:liveSession.rescheduled.message',
    actionUrl: ({ values }) => `/dashboard/learning/courses/${str(values, 'courseId')}`,
    actionLabelKey: 'notifications:liveSession.action.openCourse',
  },
  'live_session.cancelled': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'high',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `live-session:${entity.id}:cancelled:${str(values, 'studentId')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'live_session.cancelled',
    titleKey: 'notifications:liveSession.cancelled.title',
    messageKey: 'notifications:liveSession.cancelled.message',
    actionUrl: ({ values }) => `/dashboard/learning/courses/${str(values, 'courseId')}`,
    actionLabelKey: 'notifications:liveSession.action.openCourse',
  },
  'live_session.starting_soon': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `live-session:${entity.id}:starting_soon:${str(values, 'startsAtMs')}:${str(values, 'studentId')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'live_session.starting_soon',
    titleKey: 'notifications:liveSession.starting_soon.title',
    messageKey: 'notifications:liveSession.starting_soon.message',
    actionUrl: ({ values }) => `/dashboard/learning/courses/${str(values, 'courseId')}`,
    actionLabelKey: 'notifications:liveSession.action.openCourse',
  },
  'live_provider.deauthorized': {
    category: 'security',
    audience: 'staff',
    channels: { inApp: 'always', email: 'never' },
    priority: 'high',
    notificationType: 'security',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      `live_provider.deauthorized:${entity.id}:${str(values, 'deauthorizedAt')}`,
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'academy',
    template: 'live_provider.deauthorized',
    titleKey: 'notifications:liveProvider.deauthorized.title',
    messageKey: 'notifications:liveProvider.deauthorized.message',
    actionUrl: () => '/dashboard/add-ons/live-sessions/connection',
    actionLabelKey: 'notifications:liveProvider.action.reconnect',
  },

  // --- Assessments (P64 Phase 3) — the learner.
  'assessment.assignment.graded': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'preference' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `assignment_submission.graded:${entity.id}:${str(values, 'revision')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'assessment.assignment.graded',
    titleKey: 'notifications:events.assignmentGraded.title',
    messageKey: 'notifications:events.assignmentGraded.message',
    actionUrl: ({ values }) =>
      `/my/courses/${str(values, 'courseId')}/activities/${str(values, 'assignmentId')}`,
  },
  'assessment.quiz.graded': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'preference' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity }) => `quiz_attempt.graded:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'assessment.quiz.graded',
    titleKey: 'notifications:events.quizGraded.title',
    messageKey: 'notifications:events.quizGraded.message',
    actionUrl: ({ values }) =>
      `/my/courses/${str(values, 'courseId')}/activities/${str(values, 'quizId')}`,
  },

  // --- Certificates (P64 Phase 3) — the learner.
  'certificate.issued': {
    category: 'lifecycle',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      `certificate.issued:${entity.id}:${str(values, 'version')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'certificate.issued',
    titleKey: 'notifications:events.certificateIssued.title',
    messageKey: 'notifications:events.certificateIssued.message',
    actionUrl: () => '/my/certificates',
  },
  'certificate.revoked': {
    category: 'lifecycle',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'activity',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      `certificate.revoked:${entity.id}:${str(values, 'revokedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'certificate.revoked',
    titleKey: 'notifications:events.certificateRevoked.title',
    messageKey: 'notifications:events.certificateRevoked.message',
    actionUrl: () => '/my/certificates',
  },

  // --- Enrollment access (P64 Communications C3, plan §8 C1-C4 / §10).
  //
  // The three transitions that CHANGE a learner's access to a course and
  // told them nothing before this phase. All `transactional`: §11 says a
  // person cannot opt out of being told their access changed, and the
  // catalogue's own invariant (`communication-catalog.spec.ts`) forbids a
  // `preference` channel on that category. §10's "transactional-lite /
  // preference" note for the GRANT is honoured by the preference model
  // rather than the channel: `transactional` is locked `email: true`
  // there, so `preference` would have resolved to `always` anyway —
  // declaring `always` is the honest version of the same behaviour.
  //
  // Each dedupe key carries the INSTANT of the transition, following
  // §19's rule for events that legitimately repeat (`certificate.revoked`
  // is the precedent): a learner can be granted, revoked and re-granted
  // access to the same course, and the second grant is exactly the one
  // they must not miss. The instant is computed ONCE per request by the
  // producer, so a retried transaction reproduces the same key.
  'enrollment.granted': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `enrollment.granted:${entity.id}:${str(values, 'grantedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'enrollment.granted',
    titleKey: 'notifications:events.enrollmentGranted.title',
    messageKey: 'notifications:events.enrollmentGranted.message',
    actionUrl: ({ values }) => `/my/courses/${str(values, 'courseId')}`,
  },
  'enrollment.revoked': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'activity',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      `enrollment.revoked:${entity.id}:${str(values, 'revokedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'enrollment.revoked',
    titleKey: 'notifications:events.enrollmentRevoked.title',
    messageKey: 'notifications:events.enrollmentRevoked.message',
    actionUrl: () => '/my/courses',
  },
  // The expiry is the whole message, so it is also the whole dedupe key:
  // setting the SAME date twice is not news, moving it is.
  'enrollment.expiry_changed': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `enrollment.expiry_changed:${entity.id}:${str(values, 'expiresAtMs') || 'cleared'}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'enrollment.expiry_changed',
    titleKey: 'notifications:events.enrollmentExpiryChanged.title',
    messageKey: 'notifications:events.enrollmentExpiryChanged.message',
    actionUrl: ({ values }) => `/my/courses/${str(values, 'courseId')}`,
  },

  // --- Academy roster decisions (plan §8 G2/G3, §10). The entity is the
  // `academy_students` membership row; the instant distinguishes a second
  // legitimate decision on the same membership (re-applied then approved,
  // blocked then unblocked then blocked again).
  'roster.student.approved': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'account',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `roster.student.approved:${entity.id}:${str(values, 'decidedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'roster.student.approved',
    titleKey: 'notifications:events.rosterStudentApproved.title',
    messageKey: 'notifications:events.rosterStudentApproved.message',
    actionUrl: () => '/my/courses',
  },
  'roster.student.rejected': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'account',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `roster.student.rejected:${entity.id}:${str(values, 'decidedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'roster.student.rejected',
    titleKey: 'notifications:events.rosterStudentRejected.title',
    messageKey: 'notifications:events.rosterStudentRejected.message',
  },
  'roster.student.blocked': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'account',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      `roster.student.blocked:${entity.id}:${str(values, 'decidedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'roster.student.blocked',
    titleKey: 'notifications:events.rosterStudentBlocked.title',
    messageKey: 'notifications:events.rosterStudentBlocked.message',
  },
  'roster.student.unblocked': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'account',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `roster.student.unblocked:${entity.id}:${str(values, 'decidedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'roster.student.unblocked',
    titleKey: 'notifications:events.rosterStudentUnblocked.title',
    messageKey: 'notifications:events.rosterStudentUnblocked.message',
    actionUrl: () => '/my/courses',
  },

  // --- Course commerce receipt (plan §8 D3, §10 "proof submitted →
  // always (receipt) to learner"). The entity is the PROOF, which is
  // minted once per submission — so a resubmission is a new receipt and a
  // retried request that reuses the same proof id is not.
  'course.order.proof_submitted': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `course_order_proof_submitted:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'course.order.proof_submitted',
    titleKey: 'notifications:events.courseOrderProofSubmitted.title',
    messageKey: 'notifications:events.courseOrderProofSubmitted.message',
    actionUrl: () => '/my/purchases',
  },

  // --- Review moderation (plan §8 F2, §10 "learner: yes | never — low
  // stakes; feed only"). The one new key that is deliberately in-app
  // ONLY: telling someone by email that their review was approved is
  // noise, and telling them it was rejected by email reads as a
  // reprimand. The dedupe is per (review, outcome): clicking "approve"
  // twice is not two pieces of news, approving a review that was
  // rejected is.
  /**
   * A learner's review is waiting for moderation — a STAFF work item.
   *
   * `email: 'digest'` rather than `always`: a moderator on a busy academy
   * would otherwise receive one mail per review, which is how a useful
   * signal becomes a filter rule. The in-app row is immediate; the mail
   * is batched.
   *
   * `operational`, not `engagement`: it is work someone is expected to
   * do, so it is not silenced by the engagement toggle — but it is still
   * digestible, which is the distinction `operational` exists to carry.
   */
  'review.submitted': {
    category: 'operational',
    audience: 'staff',
    channels: { inApp: 'always', email: 'digest' },
    priority: 'low',
    notificationType: 'activity',
    retentionClass: 'standard',
    // One work item per review per moderator. A re-submitted review is a
    // NEW thing to moderate, so the status transition instant is in the
    // key — otherwise an edited review would silently never be re-queued.
    dedupe: ({ entity, values }) =>
      `course_review.submitted:${entity.id}:${str(values, 'submittedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'review.submitted',
    titleKey: 'notifications:events.reviewSubmitted.title',
    messageKey: 'notifications:events.reviewSubmitted.message',
    actionUrl: () => `/dashboard/reviews`,
  },
  'review.moderated': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'low',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `course_review.moderated:${entity.id}:${str(values, 'status')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'review.moderated',
    titleKey: 'notifications:events.reviewModerated.title',
    messageKey: 'notifications:events.reviewModerated.message',
    actionUrl: ({ values }) => `/my/courses/${str(values, 'courseId')}`,
  },

  // --- Tenant lifecycle sequences (P64 C5, plan §26 trial T1–T6 and §27
  // subscription S1–S10). The recipient is always the organisation's
  // owner; branding and locale are the PLATFORM's, because this is Atlas
  // talking to its customer about their account, not an academy talking
  // to a learner.
  //
  // EVERY dedupe key here is `lifecycle_<step>:<organizationId>:<anchor>`,
  // where the anchor is the immutable instant the step's timing derives
  // from. That shape is the whole reason a sweep that re-evaluates every
  // 15 minutes does not re-send: an unchanged anchor re-derives the exact
  // same string and the INSERT is rejected by the unique index, while a
  // genuine second occurrence (a renewed period, a second grace window)
  // carries a different anchor and is allowed through. Nothing is ever
  // scheduled ahead, so nothing ever has to be cancelled.
  //
  // `always` vs `preference` is not a style choice either: §26/§27 make
  // T3, S3, S5, S7 (and the factual S9) NON-suppressible — a site going
  // offline is consequential, not marketing — while the nudges T4–T6 and
  // S10 respect the recipient's `lifecycle.reminders` toggle.

  // T1 — the one email an owner expects, at `startTrial`.
  'lifecycle.trial.started': {
    category: 'transactional',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('trial_started', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.trial.started',
    titleKey: 'notifications:events.lifecycleTrialStarted.title',
    messageKey: 'notifications:events.lifecycleTrialStarted.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // T2 — `trialEndsAt − 24 h`.
  'lifecycle.trial.ending_soon': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('trial_ending_soon', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.trial.ending_soon',
    titleKey: 'notifications:events.lifecycleTrialEndingSoon.title',
    messageKey: 'notifications:events.lifecycleTrialEndingSoon.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // T3 — at expiry. NOT suppressible: their site is now offline.
  'lifecycle.trial.expired': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'urgent',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('trial_expired', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.trial.expired',
    titleKey: 'notifications:events.lifecycleTrialExpired.title',
    messageKey: 'notifications:events.lifecycleTrialExpired.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // T4/T5/T6 — the conditional tail. Email only, and only with
  // `lifecycle.reminders` on: a nudge is not news, so it neither takes a
  // slot in the in-app feed nor overrides the recipient's preference.
  'lifecycle.trial.followup_3d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'never', email: 'preference' },
    priority: 'low',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('trial_followup_3d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.trial.followup_3d',
    titleKey: 'notifications:events.lifecycleTrialFollowup3d.title',
    messageKey: 'notifications:events.lifecycleTrialFollowup3d.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  'lifecycle.trial.followup_14d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'never', email: 'preference' },
    priority: 'low',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('trial_followup_14d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.trial.followup_14d',
    titleKey: 'notifications:events.lifecycleTrialFollowup14d.title',
    messageKey: 'notifications:events.lifecycleTrialFollowup14d.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  'lifecycle.trial.reactivation_45d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'never', email: 'preference' },
    priority: 'low',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('trial_reactivation_45d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.trial.reactivation_45d',
    titleKey: 'notifications:events.lifecycleTrialReactivation45d.title',
    messageKey: 'notifications:events.lifecycleTrialReactivation45d.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },

  // S1 — the receipt §27 asks for beside the existing approval notice:
  // period dates and the limits this purchase actually froze. Anchored on
  // the new `currentPeriodEnd`, so each renewal is its own receipt.
  'lifecycle.subscription.activated': {
    category: 'transactional',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_activated', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.activated',
    titleKey: 'notifications:events.lifecycleSubscriptionActivated.title',
    messageKey: 'notifications:events.lifecycleSubscriptionActivated.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // S2 — "they are waiting on a human" (§28). The version is the PROOF
  // id, not the payment: re-uploading a corrected receipt is a genuinely
  // new submission and deserves its own confirmation, while a retried
  // request for the same upload does not.
  'lifecycle.subscription.payment_submitted': {
    category: 'transactional',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_payment_submitted', entity.id, str(values, 'proofId')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.payment_submitted',
    titleKey: 'notifications:events.lifecycleSubscriptionPaymentSubmitted.title',
    messageKey: 'notifications:events.lifecycleSubscriptionPaymentSubmitted.message',
    actionUrl: () => '/dashboard/billing',
  },
  // S3/S4 — renewal lead time. NOT suppressible: a manual bank transfer
  // plus a human review cannot be started after the fact.
  'lifecycle.subscription.renewal_due': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_renewal_due', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.renewal_due',
    titleKey: 'notifications:events.lifecycleSubscriptionRenewalDue.title',
    messageKey: 'notifications:events.lifecycleSubscriptionRenewalDue.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  'lifecycle.subscription.renewal_tomorrow': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_renewal_tomorrow', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.renewal_tomorrow',
    titleKey: 'notifications:events.lifecycleSubscriptionRenewalTomorrow.title',
    messageKey: 'notifications:events.lifecycleSubscriptionRenewalTomorrow.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // S5 — the period ended and the 7-day grace opened. NOT suppressible.
  'lifecycle.subscription.grace_started': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'urgent',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_grace_started', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.grace_started',
    titleKey: 'notifications:events.lifecycleSubscriptionGraceStarted.title',
    messageKey: 'notifications:events.lifecycleSubscriptionGraceStarted.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  'lifecycle.subscription.grace_ending': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_grace_ending', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.grace_ending',
    titleKey: 'notifications:events.lifecycleSubscriptionGraceEnding.title',
    messageKey: 'notifications:events.lifecycleSubscriptionGraceEnding.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // S7 — access has actually ended. NOT suppressible.
  'lifecycle.subscription.expired': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'urgent',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_expired', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.expired',
    titleKey: 'notifications:events.lifecycleSubscriptionExpired.title',
    messageKey: 'notifications:events.lifecycleSubscriptionExpired.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // S8 — the confirmation a cancelling customer is owed, with the date
  // their access actually ends (never "immediately": they keep the period
  // they paid for).
  'lifecycle.subscription.cancel_scheduled': {
    category: 'transactional',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_cancel_scheduled', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.cancel_scheduled',
    titleKey: 'notifications:events.lifecycleSubscriptionCancelScheduled.title',
    messageKey: 'notifications:events.lifecycleSubscriptionCancelScheduled.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // S9 — the cancellation actually took effect.
  'lifecycle.subscription.cancelled': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_cancelled', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.cancelled',
    titleKey: 'notifications:events.lifecycleSubscriptionCancelled.title',
    messageKey: 'notifications:events.lifecycleSubscriptionCancelled.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  // S10 — two post-expiry touches and no more, both respecting
  // `lifecycle.reminders`.
  'lifecycle.subscription.followup_7d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'never', email: 'preference' },
    priority: 'low',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_followup_7d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.followup_7d',
    titleKey: 'notifications:events.lifecycleSubscriptionFollowup7d.title',
    messageKey: 'notifications:events.lifecycleSubscriptionFollowup7d.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },
  'lifecycle.subscription.followup_30d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'never', email: 'preference' },
    priority: 'low',
    notificationType: 'billing',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      lifecycleKey('subscription_followup_30d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'lifecycle.subscription.followup_30d',
    titleKey: 'notifications:events.lifecycleSubscriptionFollowup30d.title',
    messageKey: 'notifications:events.lifecycleSubscriptionFollowup30d.message',
    actionUrl: () => TENANT_SUBSCRIPTION_PATH,
  },

  // === P64 Communications C3, second pass — the remaining transactional
  // === events (plan §8 B1-B4 / C1 / D1-D2 / E4-E6 / H1).
  //
  // Three rules decided every entry below, in this order:
  //
  //  1. §10's channel column, verbatim, WHERE THE CATALOGUE'S OWN
  //     INVARIANT ALLOWS IT. `communication-catalog.spec.ts` forbids a
  //     `preference` email channel on `security` and `transactional`,
  //     because §23 locks those two categories' email preference to
  //     `true` — a `preference` channel there is not a softer policy, it
  //     is the same `always` written misleadingly. Where §10 says
  //     "preference" for an event whose category can only be `security`
  //     (B1/B2), the entry declares `always` or `never` and says which,
  //     rather than pretending the recipient has a choice they do not.
  //  2. §11's category definitions decide the category, not the channel:
  //     a device change PROVES OR PROTECTS account ownership, so it is
  //     `security` however quiet its channel; a congratulation is
  //     `engagement` however consequential the course was.
  //  3. §19's dedupe rule: the entity alone when the transition can
  //     happen exactly once for that row, entity + the transition instant
  //     when it can legitimately recur. The instant is always computed
  //     ONCE by the producer and passed in, so a retried transaction
  //     reproduces the key and a genuine second occurrence does not.

  // --- Learner self/free enrollment (plan §8 C1, §10 "C1 free
  // enrollment, C2 granted | yes | preference (transactional-lite)").
  //
  // Shaped exactly like its sibling `enrollment.granted` above, for the
  // reason recorded there: `transactional` is locked `email: true` by the
  // preference model, so `preference` would have resolved to `always`
  // anyway. The learner clicked Enrol a moment ago, so the mail is a
  // receipt with the course link rather than news.
  //
  // The enrollment row is minted ONCE per (student, course) — the
  // producer returns the existing row on a re-click without reaching the
  // emit — so the entity id alone is the whole key. A learner who is
  // revoked and re-enrolls gets a NEW enrollment id, and therefore a new
  // key, which is the behaviour that matters.
  'enrollment.self_enrolled': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity }) => `enrollment.self_enrolled:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'enrollment.self_enrolled',
    titleKey: 'notifications:events.enrollmentSelfEnrolled.title',
    messageKey: 'notifications:events.enrollmentSelfEnrolled.message',
    actionUrl: ({ values }) => `/my/courses/${str(values, 'courseId')}`,
  },

  // --- Course commerce, the two ends of an unpaid order (plan §8 D1/D2,
  // §10 "D1 order created | yes | never — receipt comes with D3" and
  // "D2 order expired | yes | never"). Both are `transactional` facts
  // about the learner's own money and both are in-app ONLY: the receipt
  // is `course.order.proof_submitted`, and emailing somebody that they
  // did not finish paying is the shape of a dark pattern.
  //
  // A course order is minted once and expires once, so each key is the
  // entity alone.
  'course.order.created': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'low',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `course_order_created:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'course.order.created',
    titleKey: 'notifications:events.courseOrderCreated.title',
    messageKey: 'notifications:events.courseOrderCreated.message',
    actionUrl: () => '/my/purchases',
  },
  'course.order.expired': {
    category: 'transactional',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'medium',
    notificationType: 'billing',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `course_order_expired:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'course.order.expired',
    titleKey: 'notifications:events.courseOrderExpired.title',
    messageKey: 'notifications:events.courseOrderExpired.message',
    actionUrl: ({ values }) => `/courses/${str(values, 'courseId')}`,
  },

  // --- Assessments, the two transitions a learner did not ask for (plan
  // §8 E4/E5, §10 "E4 auto-submitted, E5 invalidated | yes (high) |
  // preference"). `engagement` is what makes §10's `preference` legal
  // here, and it is also the category the two already-shipped assessment
  // keys use, so the learning toggle governs the whole of assessment
  // rather than half of it.
  //
  // An attempt is finalised exactly once — `updateIfInProgress` lets only
  // one racing finaliser win — so the attempt id alone keys the
  // auto-submit. Invalidation carries its instant: a reviewer can void a
  // later attempt at the same quiz, and (unlike finalisation) nothing in
  // the schema makes a second invalidation of the SAME attempt
  // impossible.
  'assessment.quiz.auto_submitted': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'preference' },
    priority: 'high',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity }) => `quiz_attempt.auto_submitted:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'assessment.quiz.auto_submitted',
    titleKey: 'notifications:events.quizAutoSubmitted.title',
    messageKey: 'notifications:events.quizAutoSubmitted.message',
    actionUrl: ({ values }) =>
      `/my/courses/${str(values, 'courseId')}/activities/${str(values, 'quizId')}`,
  },
  'assessment.attempt.invalidated': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'preference' },
    priority: 'high',
    notificationType: 'activity',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      `quiz_attempt.invalidated:${entity.id}:${str(values, 'invalidatedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'assessment.attempt.invalidated',
    titleKey: 'notifications:events.attemptInvalidated.title',
    messageKey: 'notifications:events.attemptInvalidated.message',
    actionUrl: ({ values }) =>
      `/my/courses/${str(values, 'courseId')}/activities/${str(values, 'quizId')}`,
  },

  // --- Course completed (plan §8 E6, §10 "yes | preference
  // (engagement-positive) — pairs with certificate"). Deliberately NOT
  // `always`: the certificate that follows it IS the `always` email, and
  // two mails a minute apart about the same achievement is how a product
  // gets muted.
  //
  // Completion is reversible — voiding an attempt takes it away and
  // re-earning it puts it back (`set_enrollment_completion` runs in both
  // directions) — so the key carries the instant, exactly as
  // `certificate.revoked` does.
  'course.completed': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'preference' },
    priority: 'medium',
    notificationType: 'activity',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `course.completed:${entity.id}:${str(values, 'completedAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'course.completed',
    titleKey: 'notifications:events.courseCompleted.title',
    messageKey: 'notifications:events.courseCompleted.message',
    actionUrl: ({ values }) => `/my/courses/${str(values, 'courseId')}`,
  },

  // --- Learner devices and sessions (plan §8 B1-B4, §10).
  //
  // All four are `security` by §11 ("proves or protects account
  // ownership"), which is what makes §10's "preference" column
  // unavailable to B1/B2 — see the note at the top of this block. The
  // split chosen instead:
  //
  //   B1 registered     -> in-app only. The learner is sitting at the
  //                        browser that was just registered; §10's own
  //                        note is "low volume", and one email per new
  //                        browser is the opposite of that. (§12's A7
  //                        new-device EMAIL is a separate event owned by
  //                        the OTP workstream, and with OTP on, the OTP
  //                        email IS that notice.)
  //   B2 removed        -> emailed. §10 asks for mail at least on a
  //                        staff-driven removal, removal ENDS access on
  //                        that device, and it is the half a person who
  //                        has lost control of a browser needs to see
  //                        outside Atlas.
  //   B3 limit reached  -> in-app only, urgent. §10: "the learner is in
  //                        front of the screen; the player already
  //                        explains".
  //   B4 session taken  -> in-app only, urgent. Same reason.
  //
  // A device row is registered once and removed once, so those two key on
  // the device alone. The cap is hit on EVERY refused grant, so its key
  // carries the academy and a calendar DAY rather than an instant —
  // otherwise a learner poking at a locked lesson would paper their feed
  // with identical rows. A takeover carries its instant: moving the
  // session back and forth is exactly what a shared account does, and
  // each move is a thing its owner should see.
  'device.registered': {
    category: 'security',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'medium',
    notificationType: 'security',
    retentionClass: 'standard',
    dedupe: ({ entity }) => `device.registered:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'device.registered',
    titleKey: 'notifications:events.deviceRegistered.title',
    messageKey: 'notifications:events.deviceRegistered.message',
    actionUrl: () => '/my/devices',
  },
  'device.removed': {
    category: 'security',
    audience: 'learner',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'security',
    retentionClass: 'extended',
    dedupe: ({ entity }) => `device.removed:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'device.removed',
    titleKey: 'notifications:events.deviceRemoved.title',
    messageKey: 'notifications:events.deviceRemoved.message',
    actionUrl: () => '/my/devices',
  },
  'device.limit_reached': {
    category: 'security',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'urgent',
    notificationType: 'security',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `device.limit_reached:${entity.id}:${str(values, 'occurredOn')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'device.limit_reached',
    titleKey: 'notifications:events.deviceLimitReached.title',
    messageKey: 'notifications:events.deviceLimitReached.message',
    actionUrl: () => '/my/devices',
  },
  'session.taken_over': {
    category: 'security',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'urgent',
    notificationType: 'security',
    retentionClass: 'standard',
    dedupe: ({ entity, values }) =>
      `session.taken_over:${entity.id}:${str(values, 'takenOverAtMs')}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'session.taken_over',
    titleKey: 'notifications:events.sessionTakenOver.title',
    messageKey: 'notifications:events.sessionTakenOver.message',
    actionUrl: () => '/my/devices',
  },

  // --- Announcements (plan §8 H1, §10 "audience: yes (type
  // `announcement`) | preference (engagement) with per-announcement 'also
  // email' choice for owners, capped (§22)").
  //
  // `email: 'never'`, and that is a REPORTED GAP rather than a decision:
  // the per-announcement "also email" flag §10 requires does not exist on
  // `announcements` (no column, no DTO field, no UI), and this workstream
  // may not add one. Declaring `preference` instead would email every
  // learner of an academy about every announcement the moment anyone's
  // engagement toggle is on — the exact blast §21 says must be SIZED
  // before it is enqueued, and the opposite of what the owner-controlled
  // flag is for. The template exists and carries the copy the email half
  // would use the day the flag does.
  //
  // One announcement is published once, so the announcement id alone is
  // the key — per recipient, which is what the outbox's unique index is
  // scoped to, so a class of 200 gets 200 distinct rows and a retried
  // publish gets none.
  'announcement.published': {
    category: 'engagement',
    audience: 'learner',
    channels: { inApp: 'always', email: 'never' },
    priority: 'low',
    notificationType: 'announcement',
    retentionClass: 'standard',
    dedupe: ({ entity }) => `announcement.published:${entity.id}`,
    cooldownSeconds: 0,
    locale: 'academy',
    branding: 'academy',
    template: 'announcement.published',
    titleKey: 'notifications:events.announcementPublished.title',
    messageKey: 'notifications:events.announcementPublished.message',
    // There is no learner announcements PAGE — the feed is the surface —
    // so a course announcement links to its course and an academy-wide
    // one to the learner overview, rather than to a route that 404s.
    actionUrl: ({ values }) => {
      const courseId = str(values, 'courseId');
      return courseId ? `/my/courses/${courseId}` : '/my';
    },
  },

  // === P64 Communications C6 — hosted-video retention (plan §31/§32).
  //
  // THE SIX ENTRIES BELOW ARE THE ONLY WARNING A CUSTOMER GETS BEFORE
  // THEIR VIDEO IS DESTROYED, so three things about them are deliberate
  // and none of them are style:
  //
  //  1. `email: 'always'` on all five customer-facing entries. §31 calls
  //     these "lifecycle-critical and only suppressible by hard bounce".
  //     `always` bypasses the preference branch in
  //     `CommunicationDispatchService` and still respects the suppression
  //     list, which is exactly that sentence expressed as policy. A
  //     `preference` channel here would mean a customer who once turned
  //     off reminders loses their course library without being told.
  //  2. `notificationType: 'account'` with `retentionClass: 'extended'`.
  //     This is not billing and not a nudge: it is a statement about the
  //     customer's own data. §33 keeps account-class rows for 365 days,
  //     which is what makes "we told you, on this date" still answerable a
  //     year later — and the deletion is permanent, so the record of the
  //     notice has to outlive the 180-day standard class.
  //  3. The dedupe anchor is the retention anchor, so the whole sequence
  //     shares one version string. That is what lets
  //     `VideoRetentionRepository.findWarningsSent` ask "was this customer
  //     warned about THIS deletion date" by key alone — the precondition
  //     that makes the destructive step reachable.
  //
  // `actionUrl` points at the retention page §31 specifies rather than at
  // the subscription page: the two ways to stop a deletion are subscribing
  // AND downloading, and only one of them lives under billing.

  // W1 Notice — 30 days out. Counts, minutes, the date, and the two ways
  // to stop it.
  'retention.video.warning_30d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'account',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('retention_warning_30d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'retention.video.warning_30d',
    titleKey: 'notifications:events.retentionVideoWarning30d.title',
    messageKey: 'notifications:events.retentionVideoWarning30d.message',
    actionUrl: () => TENANT_RETENTION_PATH,
  },
  // W2 Reminder — 14 days out, with the affected courses named.
  'retention.video.warning_14d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'high',
    notificationType: 'account',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('retention_warning_14d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'retention.video.warning_14d',
    titleKey: 'notifications:events.retentionVideoWarning14d.title',
    messageKey: 'notifications:events.retentionVideoWarning14d.message',
    actionUrl: () => TENANT_RETENTION_PATH,
  },
  // W3 Final warning — 7 days out. `urgent`: from here the feed should
  // outrank everything else in it.
  'retention.video.warning_7d': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'urgent',
    notificationType: 'account',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('retention_warning_7d', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'retention.video.warning_7d',
    titleKey: 'notifications:events.retentionVideoWarning7d.title',
    messageKey: 'notifications:events.retentionVideoWarning7d.message',
    actionUrl: () => TENANT_RETENTION_PATH,
  },
  // W4 Last call — 24 hours out, short, and sent even if W1-W3 bounced
  // (§31). `always` is what makes that last clause true.
  'retention.video.warning_24h': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'urgent',
    notificationType: 'account',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('retention_warning_24h', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'retention.video.warning_24h',
    titleKey: 'notifications:events.retentionVideoWarning24h.title',
    messageKey: 'notifications:events.retentionVideoWarning24h.message',
    actionUrl: () => TENANT_RETENTION_PATH,
  },
  // D — one per tenant, after every asset of the run has settled. Reports
  // what went, what stayed, and — when the provider refused some of them —
  // says so rather than claiming a clean sweep.
  'retention.video.deleted': {
    category: 'lifecycle',
    audience: 'staff',
    channels: { inApp: 'always', email: 'always' },
    priority: 'urgent',
    notificationType: 'account',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('retention_deleted', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'retention.video.deleted',
    titleKey: 'notifications:events.retentionVideoDeleted.title',
    messageKey: 'notifications:events.retentionVideoDeleted.message',
    actionUrl: () => TENANT_RETENTION_PATH,
  },
  // K3 — the Platform Owner, when an asset exhausted its five attempts.
  // Addressed to staff of the PLATFORM, never to the customer: the
  // customer's D email already tells them honestly what remains, and this
  // one carries the asset id an operator needs.
  //
  // Deduped on the asset and the anchor, so one broken asset produces one
  // alert per deletion run rather than one per retry.
  'retention.video.deletion_failed': {
    category: 'operational',
    audience: 'platform',
    channels: { inApp: 'always', email: 'always' },
    priority: 'urgent',
    notificationType: 'system',
    retentionClass: 'extended',
    dedupe: ({ entity, values }) =>
      lifecycleKey('retention_deletion_failed', entity.id, str(values, 'anchorAt')),
    cooldownSeconds: 0,
    locale: 'user',
    branding: 'platform',
    template: 'retention.video.deletion_failed',
    titleKey: 'notifications:events.retentionVideoDeletionFailed.title',
    messageKey: 'notifications:events.retentionVideoDeletionFailed.message',
    actionUrl: () => '/platform/analytics',
  },
} as const satisfies Record<string, CommunicationCatalogEntry>;

export type CommunicationEventKey = keyof typeof CATALOG;

export const COMMUNICATION_CATALOG: Readonly<
  Record<CommunicationEventKey, CommunicationCatalogEntry>
> = CATALOG;

export const COMMUNICATION_EVENT_KEYS = Object.keys(
  COMMUNICATION_CATALOG,
) as readonly CommunicationEventKey[];

export function catalogEntry(key: CommunicationEventKey): CommunicationCatalogEntry {
  return COMMUNICATION_CATALOG[key];
}

export function isCommunicationEventKey(value: string): value is CommunicationEventKey {
  return Object.prototype.hasOwnProperty.call(COMMUNICATION_CATALOG, value);
}
