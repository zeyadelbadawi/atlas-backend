/**
 * The audited-event catalogue — the ONE list of every `action` Atlas may
 * write to `audit_log_entries`, and what each one is allowed to carry.
 *
 * WHY A CATALOGUE. Before it, `action` was a free string, `context` was a
 * free bag and "can a tenant see this?" was decided nowhere: the dashboard
 * widget showed whatever rows happened to carry the organization id, and the
 * frontend could translate only the handful of actions somebody had
 * remembered to add copy for (everything else read "made a change"). Each
 * entry here answers, in one place:
 *
 *   - `category`        — the filter group shown to people ("Website",
 *                         "Courses", ...).
 *   - `targetType`      — the entity the action is about (informational: a
 *                         few call sites legitimately vary it, e.g. a
 *                         curriculum attach names `lesson`/`quiz`).
 *   - `scope`           — whose log the event belongs to: one academy, the
 *                         organization as a whole, or the platform operator.
 *   - `visibleToTenant` — whether an Academy/Organization owner may read it.
 *                         Sign-in/OTP/account-deletion telemetry and every
 *                         platform-operator action are `false`: they are the
 *                         operator's security record, not the customer's
 *                         activity feed.
 *   - `context`         — the ONLY context keys the writer will store for
 *                         this action. Anything else is dropped at write
 *                         time (see `sanitizeAuditContext`), so a careless
 *                         call site cannot smuggle an IP address, an email
 *                         or a credential into a tenant-visible row.
 *   - `diffFields`      — the fields `AuditLogWriterService.record` diffs
 *                         from before/after snapshots by default.
 *
 * `docs/AUDIT_LOG_EVENTS.md` is the human-readable twin of this file; keep
 * both in step. The frontend keeps a mirror of `category` per action
 * (`src/features/audit-log/utils/audit-event-catalog.ts`) for its filters
 * and sentence copy.
 */

export const AUDIT_CATEGORIES = [
  'courses',
  'assessments',
  'website',
  'academy',
  'team',
  'students',
  'certificates',
  'reviews',
  'media',
  'domains',
  'live_sessions',
  'payments',
  'subscription',
  'support',
  'security',
  'platform',
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export type AuditScope = 'academy' | 'organization' | 'platform';

export interface AuditEventDefinition<A extends string = string> {
  readonly action: A;
  readonly category: AuditCategory;
  readonly targetType: string;
  readonly scope: AuditScope;
  readonly visibleToTenant: boolean;
  readonly context: readonly string[];
  readonly diffFields?: readonly string[];
}

/** Compact constructor; `const A` keeps each action a literal so `AuditAction` is a real union. */
function ev<const A extends string>(
  action: A,
  category: AuditCategory,
  targetType: string,
  scope: AuditScope,
  visibleToTenant: boolean,
  context: readonly string[] = [],
  diffFields?: readonly string[],
): AuditEventDefinition<A> {
  return { action, category, targetType, scope, visibleToTenant, context, diffFields };
}

/* Shared context vocabularies — names, never emails. */
const COURSE_REF = ['courseId', 'courseTitle'] as const;
const SECTION_REF = ['sectionId', 'sectionTitle'] as const;
const STUDENT_REF = ['studentId', 'studentName'] as const;
const QUIZ_REF = ['quizId', 'quizTitle'] as const;
const WEBSITE_PAGE_CONTEXT = [
  'pageType',
  'slug',
  'sectionsAdded',
  'sectionsRemoved',
  'sectionsUpdated',
  'sectionCount',
] as const;
const SUBSCRIPTION_TRANSITION = [
  'previousStatus',
  'newStatus',
  'reason',
  'at',
  'currentPeriodEnd',
  'graceEndsAt',
] as const;
const OTP_CONTEXT = [
  'surface',
  'challengeId',
  'outboxId',
  'resend',
  'attempts',
  'attemptsRemaining',
  'reason',
  // Platform-only (visibleToTenant: false) forensic field.
  'ipAddress',
] as const;
const ACCOUNT_DELETED_CONTEXT = [
  'initiatedBy',
  'reason',
  'hasFeedback',
  'sessionsRevoked',
] as const;

export const COURSE_DIFF_FIELDS = [
  'title',
  'slug',
  'shortDescription',
  'description',
  'thumbnailUrl',
  'visibility',
  'status',
  'categoryId',
  'pricingType',
  'pricingAmountMinorUnits',
  'pricingCurrency',
  'level',
  'language',
  'outcomes',
  'requirements',
  'introVideoAssetId',
] as const;

export const QUIZ_DIFF_FIELDS = [
  'title',
  'description',
  'sectionId',
  'status',
  'passingScore',
  'maxAttempts',
  'mode',
  'timeLimitSeconds',
  'availableFrom',
  'availableUntil',
  'dueAt',
  'latePolicy',
  'gradingPolicy',
  'shuffleQuestions',
  'shuffleOptions',
  'questionsPerAttempt',
  'layout',
  'showScore',
  'showAnswers',
  'showExplanations',
  'integrityMode',
  'maxViolations',
  'requireFullscreen',
  'requiredToProgress',
  'requiredForCompletion',
  'hideTimer',
] as const;

export const ASSIGNMENT_DIFF_FIELDS = [
  'title',
  'description',
  'instructions',
  'sectionId',
  'lessonId',
  'status',
  'dueAt',
  'allowResubmission',
  'latePolicy',
  'requiredForCompletion',
] as const;

export const ACADEMY_DIFF_FIELDS = [
  'name',
  'slug',
  'description',
  'contactEmail',
  'contactPhone',
  'websiteUrl',
  'language',
  'timezone',
  'currency',
  'status',
  'address',
] as const;

export const AUDIT_EVENT_DEFINITIONS = [
  /* ------------------------------ Courses ------------------------------ */
  ev('course.created', 'courses', 'course', 'academy', true),
  ev('course.updated', 'courses', 'course', 'academy', true, [], COURSE_DIFF_FIELDS),
  ev('course.published', 'courses', 'course', 'academy', true),
  ev('course.unpublished', 'courses', 'course', 'academy', true),
  ev('course.archived', 'courses', 'course', 'academy', true),
  ev('course.instructor_assigned', 'courses', 'course', 'academy', true, [
    'targetUserId',
    'instructorName',
  ]),
  ev('course.instructor_removed', 'courses', 'course', 'academy', true, [
    'targetUserId',
    'instructorName',
  ]),
  ev('course.completion_rule.updated', 'courses', 'course', 'academy', true, [
    'lessons',
    'requiredQuizzes',
    'requiredAssignments',
    'minOverallScore',
    'certificatesEnabled',
    'certificateMinScore',
  ]),
  ev('course_section.created', 'courses', 'course_section', 'academy', true, COURSE_REF),
  ev('course_section.updated', 'courses', 'course_section', 'academy', true, COURSE_REF, [
    'title',
    'description',
  ]),
  ev('course_section.deleted', 'courses', 'course_section', 'academy', true, COURSE_REF),
  ev('course_section.reordered', 'courses', 'course', 'academy', true, [
    ...COURSE_REF,
    'sectionCount',
  ]),
  ev('course_lesson.created', 'courses', 'course_lesson', 'academy', true, [
    ...COURSE_REF,
    ...SECTION_REF,
    'videoAssetId',
    'isPreview',
  ]),
  ev(
    'course_lesson.updated',
    'courses',
    'course_lesson',
    'academy',
    true,
    [...COURSE_REF, ...SECTION_REF, 'videoAssetId', 'isPreview'],
    ['title', 'description', 'isPreview', 'durationSeconds', 'completionRule'],
  ),
  ev('course_lesson.content_updated', 'courses', 'course_lesson', 'academy', true, [
    ...COURSE_REF,
    ...SECTION_REF,
    'kind',
    'mediaAssetId',
  ]),
  ev('course_lesson.deleted', 'courses', 'course_lesson', 'academy', true, [
    ...COURSE_REF,
    ...SECTION_REF,
  ]),
  ev('course.curriculum.item_attached', 'courses', 'curriculum_item', 'academy', true, [
    ...COURSE_REF,
    ...SECTION_REF,
    'itemType',
  ]),
  ev('course.curriculum.item_detached', 'courses', 'curriculum_item', 'academy', true, [
    ...COURSE_REF,
    ...SECTION_REF,
    'itemType',
  ]),
  ev('course.curriculum.items_reordered', 'courses', 'course_section', 'academy', true, [
    ...COURSE_REF,
    ...SECTION_REF,
    'itemCount',
    'legacyLessonsEndpoint',
  ]),

  /* ---------------------------- Assessments ---------------------------- */
  ev('quiz.created', 'assessments', 'quiz', 'academy', true, COURSE_REF),
  ev(
    'quiz.updated',
    'assessments',
    'quiz',
    'academy',
    true,
    [
      ...COURSE_REF,
      'questionsAdded',
      'questionsRemoved',
      'questionsChanged',
      'questionCount',
    ],
    QUIZ_DIFF_FIELDS,
  ),
  ev('quiz.deleted', 'assessments', 'quiz', 'academy', true, COURSE_REF),
  ev('quiz.override.updated', 'assessments', 'quiz_student_override', 'academy', true, [
    ...COURSE_REF,
    ...QUIZ_REF,
    ...STUDENT_REF,
    'timeMultiplier',
    'extraAttempts',
  ]),
  ev('quiz.override.removed', 'assessments', 'quiz_student_override', 'academy', true, [
    ...COURSE_REF,
    ...QUIZ_REF,
    ...STUDENT_REF,
  ]),
  ev('quiz_attempt.graded', 'assessments', 'quiz_attempt', 'academy', true, [
    ...COURSE_REF,
    ...QUIZ_REF,
    'score',
    'finalized',
  ]),
  ev('quiz_attempt.invalidated', 'assessments', 'quiz_attempt', 'academy', true, [
    ...COURSE_REF,
    ...QUIZ_REF,
    'reason',
    'previousStatus',
  ]),
  ev('assignment.created', 'assessments', 'assignment', 'academy', true, COURSE_REF),
  ev(
    'assignment.updated',
    'assessments',
    'assignment',
    'academy',
    true,
    COURSE_REF,
    ASSIGNMENT_DIFF_FIELDS,
  ),
  ev('assignment.deleted', 'assessments', 'assignment', 'academy', true, COURSE_REF),
  ev(
    'assignment_submission.graded',
    'assessments',
    'assignment_submission',
    'academy',
    true,
    [...COURSE_REF, 'assignmentId', 'assignmentTitle', 'score'],
  ),

  /* ------------------------------ Website ------------------------------ */
  ev(
    'website.configuration.updated',
    'website',
    'website_configuration',
    'academy',
    true,
    ['changedAreas'],
    ['themeKey'],
  ),
  ev(
    'website.visual_identity.updated',
    'website',
    'academy',
    'academy',
    true,
    ['brandChanged'],
    ['name', 'logoUrl', 'faviconUrl'],
  ),
  ev('website.published', 'website', 'website_configuration', 'academy', true, [
    'pageCount',
  ]),
  ev('website.unpublished', 'website', 'website_configuration', 'academy', true),
  ev(
    'website_page.created',
    'website',
    'website_page',
    'academy',
    true,
    WEBSITE_PAGE_CONTEXT,
  ),
  ev(
    'website_page.updated',
    'website',
    'website_page',
    'academy',
    true,
    WEBSITE_PAGE_CONTEXT,
    ['title', 'slug', 'visible', 'seo'],
  ),
  ev(
    'website_page.deleted',
    'website',
    'website_page',
    'academy',
    true,
    WEBSITE_PAGE_CONTEXT,
  ),
  ev(
    'website_page.published',
    'website',
    'website_page',
    'academy',
    true,
    WEBSITE_PAGE_CONTEXT,
  ),
  ev(
    'website_page.sections_reordered',
    'website',
    'website_page',
    'academy',
    true,
    WEBSITE_PAGE_CONTEXT,
  ),
  ev('website_faq.created', 'website', 'website_faq_entry', 'academy', true),
  ev(
    'website_faq.updated',
    'website',
    'website_faq_entry',
    'academy',
    true,
    [],
    ['question', 'answer', 'order', 'visible'],
  ),
  ev('website_faq.published', 'website', 'website_faq_entry', 'academy', true),
  ev('website_faq.archived', 'website', 'website_faq_entry', 'academy', true),
  ev(
    'website_testimonial.created',
    'website',
    'website_testimonial_entry',
    'academy',
    true,
  ),
  ev(
    'website_testimonial.updated',
    'website',
    'website_testimonial_entry',
    'academy',
    true,
    [],
    ['quote', 'authorName', 'authorRole', 'avatar', 'order', 'visible'],
  ),
  ev(
    'website_testimonial.published',
    'website',
    'website_testimonial_entry',
    'academy',
    true,
  ),
  ev(
    'website_testimonial.archived',
    'website',
    'website_testimonial_entry',
    'academy',
    true,
  ),

  /* ------------------------------ Academy ------------------------------ */
  ev('academy.created', 'academy', 'academy', 'academy', true),
  ev('academy.updated', 'academy', 'academy', 'academy', true, [], ACADEMY_DIFF_FIELDS),
  ev(
    'academy.branding.updated',
    'academy',
    'academy',
    'academy',
    true,
    [],
    ['name', 'logoUrl', 'faviconUrl'],
  ),
  ev('academy.archived', 'academy', 'academy', 'academy', true, [
    'reason',
    'hasFeedback',
  ]),
  ev('academy.content_protection.updated', 'academy', 'academy', 'academy', true, [
    'watermark',
    'disableDownload',
    'disablePip',
    'disableContextMenu',
  ]),
  ev('academy.video_tier.updated', 'academy', 'academy', 'academy', true, [
    'appliesTo',
    'requested',
  ]),
  ev('academy.device_policy.updated', 'academy', 'academy', 'academy', true, [
    'maxDevices',
    'maxConcurrentSessions',
  ]),
  ev(
    'academy.registration_policy.updated',
    'academy',
    'academy',
    'academy',
    true,
    ['registrationPolicy'],
    ['registrationPolicy'],
  ),

  /* -------------------------------- Team ------------------------------- */
  ev('academy.manager.added', 'team', 'academy_member', 'academy', true, [
    'account',
    'memberName',
  ]),
  ev('academy.instructor.added', 'team', 'academy_member', 'academy', true, [
    'account',
    'memberName',
  ]),

  /* ------------------------------ Students ----------------------------- */
  ev('academy.student.created', 'students', 'user', 'academy', true, [
    'account',
    'studentName',
  ]),
  ev('academy.student.added', 'students', 'user', 'academy', true, [
    'account',
    'studentName',
  ]),
  ev('academy.student.joined', 'students', 'user', 'academy', true, [
    'existingAccount',
    'source',
    'status',
  ]),
  ev('academy.student.blocked', 'students', 'user', 'academy', true, ['studentName']),
  ev('academy.student.unblocked', 'students', 'user', 'academy', true, ['studentName']),
  ev('academy.student.approved', 'students', 'user', 'academy', true, ['studentName']),
  ev('academy.student.rejected', 'students', 'user', 'academy', true, ['studentName']),
  ev('academy.invite.created', 'students', 'academy_invite', 'academy', true, [
    'maxUses',
    'emailInvite',
  ]),
  ev('academy.invite.revoked', 'students', 'academy_invite', 'academy', true),
  ev('enrollment.granted', 'students', 'enrollment', 'academy', true, [
    ...STUDENT_REF,
    ...COURSE_REF,
    'expiresAt',
  ]),
  ev('enrollment.revoked', 'students', 'enrollment', 'academy', true, [
    ...STUDENT_REF,
    ...COURSE_REF,
    'reason',
  ]),
  ev(
    'enrollment.expiry_updated',
    'students',
    'enrollment',
    'academy',
    true,
    [...STUDENT_REF, ...COURSE_REF, 'expiresAt'],
    ['expiresAt'],
  ),
  ev('learning.device_session_takeover', 'students', 'student_device', 'academy', true, [
    'previousDeviceLabel',
    'courseId',
    'lessonId',
  ]),

  /* ---------------------------- Certificates --------------------------- */
  ev('certificate.issued', 'certificates', 'certificate', 'academy', true, [
    'enrollmentId',
    ...COURSE_REF,
    ...STUDENT_REF,
    'automatic',
    'forced',
    'reason',
    'overallScore',
  ]),
  ev('certificate.reissued', 'certificates', 'certificate', 'academy', true, [
    'enrollmentId',
    ...COURSE_REF,
    ...STUDENT_REF,
    'automatic',
    'forced',
    'reason',
    'overallScore',
  ]),
  ev('certificate.revoked', 'certificates', 'certificate', 'academy', true, [
    'reason',
    ...STUDENT_REF,
    ...COURSE_REF,
  ]),
  ev('certificate.regenerated', 'certificates', 'certificate', 'academy', true, [
    'version',
    'reason',
    'templateVersion',
  ]),
  ev(
    'certificate_template.updated',
    'certificates',
    'certificate_template',
    'academy',
    true,
    ['version'],
  ),

  /* ------------------------------ Reviews ------------------------------ */
  ev('course_review.created', 'reviews', 'course_review', 'academy', true, [
    ...COURSE_REF,
    'rating',
  ]),
  ev('course_review.updated', 'reviews', 'course_review', 'academy', true, [
    ...COURSE_REF,
    'rating',
    'status',
  ]),
  ev('course_review.deleted', 'reviews', 'course_review', 'academy', true, COURSE_REF),
  ev('course_review.approved', 'reviews', 'course_review', 'academy', true, [
    ...COURSE_REF,
    'status',
  ]),
  ev('course_review.rejected', 'reviews', 'course_review', 'academy', true, [
    ...COURSE_REF,
    'status',
    'reason',
  ]),
  ev('course_review.removed', 'reviews', 'course_review', 'academy', true, [
    ...COURSE_REF,
    'reason',
  ]),

  /* ------------------------------- Media ------------------------------- */
  ev('media.uploaded', 'media', 'media_asset', 'academy', true, [
    'mediaType',
    'sizeBytes',
  ]),
  ev('media.archived', 'media', 'media_asset', 'academy', true, ['mediaType']),
  ev('media.asset.purged', 'media', 'media_asset', 'academy', true, [
    'assetId',
    'provider',
    'bytes',
    'reason',
    'graceDays',
  ]),
  ev('media.video.deleted', 'media', 'media_asset', 'academy', true, [
    'assetId',
    'bytes',
    'minutes',
    'reason',
  ]),

  /* ------------------------------ Domains ------------------------------ */
  ev('domain.custom_domain_added', 'domains', 'domain_connection', 'academy', true, [
    'providerRegistered',
    'error',
    'replacedHostname',
  ]),
  ev('domain.custom_domain_removed', 'domains', 'domain_connection', 'academy', true),
  ev('domain.verification_checked', 'domains', 'domain_connection', 'academy', true, [
    'outcome',
    'error',
    'httpsReachable',
    'reRegistered',
  ]),
  // Operator health probes: noise in a customer feed.
  ev('domain.platform_check', 'domains', 'domain_connection', 'platform', false, [
    'outcome',
    'error',
    'httpsReachable',
  ]),
  // The customer's hostname was released by Atlas — they need to know.
  ev('domain.platform_release', 'domains', 'domain_connection', 'academy', true),

  /* --------------------------- Live sessions --------------------------- */
  ev('live_session.created', 'live_sessions', 'live_session', 'academy', true, [
    ...COURSE_REF,
    'recordingEnabled',
    'scheduledStartAt',
  ]),
  ev('live_session.updated', 'live_sessions', 'live_session', 'academy', true, [
    'status',
  ]),
  ev('live_session.cancelled', 'live_sessions', 'live_session', 'academy', true, [
    'status',
  ]),
  ev('live_session.published', 'live_sessions', 'live_session', 'academy', true),
  // `externalAccountId`/`zoomUserId` are kept for the operator's forensic
  // record but are in `TENANT_HIDDEN_CONTEXT_KEYS`: tenant responses never
  // carry provider account identifiers.
  ev(
    'live_provider.connected',
    'live_sessions',
    'academy_live_provider_connection',
    'academy',
    true,
    ['academyId', 'providerKey', 'externalAccountId'],
  ),
  ev(
    'live_provider.disconnected',
    'live_sessions',
    'academy_live_provider_connection',
    'academy',
    true,
    ['academyId', 'providerKey'],
  ),
  ev(
    'live_provider.deauthorized',
    'live_sessions',
    'academy_live_provider_connection',
    'academy',
    true,
    ['academyId', 'providerKey', 'deauthorizedAt', 'externalAccountId', 'zoomUserId'],
  ),

  /* ------------------------------ Payments ----------------------------- */
  ev(
    'organization.payment_settings.updated',
    'payments',
    'organization_payment_settings',
    'organization',
    true,
    [],
    ['paymentCollectionMode'],
  ),
  // Records THAT credentials changed and for which provider — never a value.
  ev(
    'organization.payment_gateway.credentials_saved',
    'payments',
    'organization_gateway_credential',
    'organization',
    true,
    ['providerKey'],
  ),
  ev(
    'organization.payment_gateway.connection_tested',
    'payments',
    'organization_gateway_credential',
    'organization',
    true,
    ['providerKey', 'success'],
  ),
  ev(
    'organization.payment_gateway.enabled',
    'payments',
    'organization_gateway_credential',
    'organization',
    true,
    ['providerKey'],
  ),
  ev(
    'organization.payment_gateway.disabled',
    'payments',
    'organization_gateway_credential',
    'organization',
    true,
    ['providerKey'],
  ),
  ev('payment.proof_submitted', 'payments', 'payment', 'organization', true, [
    'proofId',
    'mimeType',
  ]),
  ev('payment.approved', 'payments', 'payment', 'organization', true),
  ev('payment.rejected', 'payments', 'payment', 'organization', true, ['notes']),
  ev('course_order_payment.approved', 'payments', 'payment', 'platform', false),
  ev('course_order_payment.rejected', 'payments', 'payment', 'platform', false, [
    'notes',
  ]),
  ev('course_order.refund_recorded', 'payments', 'course_order', 'academy', true, [
    'refundId',
    'amountMinorUnits',
    'currency',
    'paymentCollectionMode',
  ]),

  /* ---------------------------- Subscription --------------------------- */
  ev('organization.created', 'subscription', 'organization', 'organization', true),
  ev(
    'organization.onboarding.completed',
    'subscription',
    'organization',
    'organization',
    true,
    ['mode', 'requiredComplete'],
  ),
  ev(
    'provisioning_request.created',
    'subscription',
    'provisioning_request',
    'organization',
    true,
  ),
  ev(
    'subscription.trial.redeemed',
    'subscription',
    'tenant_subscription',
    'organization',
    true,
    ['planKey', 'trialEndsAt', 'durationDays'],
  ),
  ev(
    'subscription.trial.cancelled',
    'subscription',
    'tenant_subscription',
    'organization',
    true,
    ['reason', 'hasFeedback', 'effectiveAt'],
  ),
  ev(
    'subscription.cancelled',
    'subscription',
    'tenant_subscription',
    'organization',
    true,
    ['reason', 'hasFeedback', 'effectiveAt', 'previousStatus'],
  ),
  ev(
    'subscription.grace_started',
    'subscription',
    'tenant_subscription',
    'organization',
    true,
    SUBSCRIPTION_TRANSITION,
  ),
  ev(
    'subscription.expired',
    'subscription',
    'tenant_subscription',
    'organization',
    true,
    SUBSCRIPTION_TRANSITION,
  ),
  ev(
    'subscription.cancelled_at_period_end',
    'subscription',
    'tenant_subscription',
    'organization',
    true,
    SUBSCRIPTION_TRANSITION,
  ),
  ev('add_on.install', 'subscription', 'tenant_add_on', 'organization', true, [
    'addOnKey',
  ]),
  ev('add_on.enable', 'subscription', 'tenant_add_on', 'organization', true, [
    'addOnKey',
  ]),
  ev('add_on.disable', 'subscription', 'tenant_add_on', 'organization', true, [
    'addOnKey',
  ]),
  ev('add_on.uninstall', 'subscription', 'tenant_add_on', 'organization', true, [
    'addOnKey',
  ]),

  /* ------------------------------ Support ------------------------------ */
  ev('support_case.created', 'support', 'support_case', 'organization', true),
  ev('support_case.replied', 'support', 'support_case', 'organization', true),
  ev('support_case.status_changed', 'support', 'support_case', 'organization', true, [
    'status',
  ]),
  ev('support_case.auto_created', 'support', 'support_case', 'organization', true, [
    'provisioningRequestId',
    'stepKey',
    'attemptCount',
    'errorCode',
  ]),

  /* --------------- Security (operator-only, never tenant) -------------- */
  ev('auth.otp.issued', 'security', 'user', 'platform', false, OTP_CONTEXT),
  ev('auth.otp.failed', 'security', 'user', 'platform', false, OTP_CONTEXT),
  ev('auth.otp.locked_out', 'security', 'user', 'platform', false, OTP_CONTEXT),
  ev('auth.otp.verified', 'security', 'user', 'platform', false, OTP_CONTEXT),
  ev('auth.device.trusted', 'security', 'trusted_device', 'platform', false, [
    'surface',
    'trustDays',
    'label',
  ]),
  ev('auth.device.revoked', 'security', 'trusted_device', 'platform', false, [
    'scope',
    'count',
    'reason',
  ]),
  ev('auth.identity.linked', 'security', 'user', 'platform', false, ['provider', 'via']),
  ev('auth.identity.unlinked', 'security', 'user', 'platform', false, ['provider']),
  ev('auth.sessions.revoked', 'security', 'user', 'platform', false, [
    'trigger',
    'sessionsRevoked',
    'trustedDevicesRevoked',
  ]),
  ev('password_reset.confirmed', 'security', 'user', 'platform', false, [
    'trigger',
    'sessionsRevoked',
    'trustedDevicesRevoked',
  ]),
  ev('account.deletion.requested', 'security', 'user', 'platform', false, [
    'challengeId',
  ]),
  ev('account.deletion.code_failed', 'security', 'user', 'platform', false, [
    'challengeId',
    'attempts',
  ]),
  ev('account.deletion.locked_out', 'security', 'user', 'platform', false, [
    'challengeId',
  ]),
  ev('account.deletion.confirmed', 'security', 'user', 'platform', false, [
    'challengeId',
  ]),
  ev('account.deleted', 'security', 'user', 'platform', false, ACCOUNT_DELETED_CONTEXT),
  ev(
    'account.deleted_by_platform_owner',
    'security',
    'user',
    'platform',
    false,
    ACCOUNT_DELETED_CONTEXT,
  ),

  /* --------------------- Platform operator actions --------------------- */
  ev('plan.created', 'platform', 'plan', 'platform', false, ['key']),
  ev('plan.updated', 'platform', 'plan', 'platform', false, ['key']),
  ev('plan.pricing_changed', 'platform', 'plan', 'platform', false, ['key']),
  ev('plan.trial_config_changed', 'platform', 'plan', 'platform', false, ['key']),
  ev('plan.archived', 'platform', 'plan', 'platform', false, [
    'key',
    'subscriptionsAtArchive',
  ]),
  ev('platform_settings.updated', 'platform', 'platform_settings', 'platform', false, [
    'platformName',
    'platformDescription',
    'supportEmail',
    'twoFactorRequired',
    'sessionTimeoutMinutes',
  ]),
  ev('payment_method.created', 'platform', 'payment_method', 'platform', false, [
    'key',
    'type',
    'enabled',
  ]),
  ev('payment_method.updated', 'platform', 'payment_method', 'platform', false, [
    'fields',
    'enabled',
  ]),
  ev(
    'commission_config.global_default_updated',
    'platform',
    'atlas_commission_config',
    'platform',
    false,
    ['defaultCommissionBasisPoints'],
  ),
  ev('add_on.catalog_status_changed', 'platform', 'add_on', 'platform', false, [
    'addOnKey',
    'previousStatus',
    'newStatus',
  ]),
  ev(
    'observability.synthetic_alert.armed',
    'platform',
    'observability',
    'platform',
    false,
    ['minutes'],
  ),
  ev(
    'observability.synthetic_alert.resolved',
    'platform',
    'observability',
    'platform',
    false,
  ),
  // Written by the platform contact module (contact agent).
  ev(
    'platform.contact_submission.status_changed',
    'platform',
    'platform_contact_submission',
    'platform',
    false,
    ['status', 'previousStatus'],
    ['status'],
  ),
  ev(
    'platform.contact_submission.deleted',
    'platform',
    'platform_contact_submission',
    'platform',
    false,
    ['status'],
  ),
] as const;

export type AuditAction = (typeof AUDIT_EVENT_DEFINITIONS)[number]['action'];

/**
 * Context keys that may be STORED (for the operator's record) but are never
 * returned to a tenant, whatever the action: provider account identifiers,
 * network/device forensics and internal correlation ids.
 */
export const TENANT_HIDDEN_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'externalAccountId',
  'zoomUserId',
  'ipAddress',
  'userAgent',
  'challengeId',
  'outboxId',
  'newSessionId',
  'previousSessionId',
]);

const BY_ACTION: ReadonlyMap<string, AuditEventDefinition> = new Map(
  AUDIT_EVENT_DEFINITIONS.map((definition) => [definition.action, definition]),
);

export function getAuditEventDefinition(
  action: string,
): AuditEventDefinition | undefined {
  return BY_ACTION.get(action);
}

export function isAuditAction(action: string): action is AuditAction {
  return BY_ACTION.has(action);
}

/** Every action an Academy/Organization owner may read. */
export const TENANT_VISIBLE_AUDIT_ACTIONS: readonly AuditAction[] =
  AUDIT_EVENT_DEFINITIONS.filter((definition) => definition.visibleToTenant).map(
    (definition) => definition.action,
  );

/** Tenant-visible actions in one category — the category filter's expansion. */
export function tenantVisibleActionsInCategory(
  category: AuditCategory,
): readonly AuditAction[] {
  return AUDIT_EVENT_DEFINITIONS.filter(
    (definition) => definition.visibleToTenant && definition.category === category,
  ).map((definition) => definition.action);
}

/** All actions in one category, tenant-visible or not — the Platform filter's expansion. */
export function actionsInCategory(category: AuditCategory): readonly AuditAction[] {
  return AUDIT_EVENT_DEFINITIONS.filter(
    (definition) => definition.category === category,
  ).map((definition) => definition.action);
}
