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
