# Audit log events

The catalogue of every action Atlas writes to `audit_log_entries`, who can
read it, and what each row may carry. The source of truth is
`src/audit-log/catalog/audit-event-catalog.ts`; this page is its readable
twin — keep the two in step (the frontend mirror is
`atlas/src/features/audit-log/utils/audit-event-catalog.ts`, and every action
needs an English and an Arabic sentence in `auditLog.json`; a test enforces
it).

## How a row is written

- **One writer.** Every mutation calls `AuditLogWriterService.write` or the
  newer `record` as the last statement **inside its own business
  transaction**. Roll back the mutation and the audit row disappears with
  it; there is no audit-only transaction except the few documented
  `writeBestEffort` cases (e.g. a learner device takeover).
- **Catalogue check.** An action missing from the catalogue throws outside
  production (`UnknownAuditActionError`) and is logged — but still written,
  hidden from tenants — in production, so a missed catalogue entry can never
  fail a customer's committed action.
- **`record()`** resolves a missing `organizationId` and actor `role` from
  the academy with **one** query in the caller's transaction (and none when
  the caller already passes both), diffs `before`/`after` snapshots over the
  action's `diffFields` allowlist into `changes`, and stores related entity
  **names** (`courseTitle`, `sectionTitle`, `studentName`, `memberName`,
  `instructorName`) in `context`.
- **Scrubbing (write time).**
  - `changes`: sensitive field names (password, secret, token, credential,
    hash, salt, cipher, encrypted, …) are replaced with `[redacted]` on both
    sides; the fact of the change survives.
  - `context`: only the action's allowlisted keys are stored; sensitive-named
    keys are always dropped; strings are capped at 300 characters.
  - Tenant-visible rows additionally lose every email address (in
    `targetLabel`, `context` values and `changes` values — the latter become
    `[email hidden]`) and every IP-shaped context key.
  - Payment gateway events record **that** credentials were saved/tested/
    enabled and for which provider — never a configuration value.
- **Read time (tenant responses).** The actor is a name only (never an
  email); actions by Atlas staff (`role = platform_owner`) are attributed to
  "Atlas"; legacy rows whose label still holds an email are stripped; context
  keys in `TENANT_HIDDEN_CONTEXT_KEYS` (provider account ids, IPs, user
  agents, challenge/outbox/session ids) are never returned. Course and
  section titles missing from older rows are resolved in one batch per page.

## Who can read what

| Surface | Endpoint | Who | Rows |
| --- | --- | --- | --- |
| Academy activity log | `GET /academies/:id/activity` (cursor feed), `GET /academies/:id/activity/:entryId` | Organization owner (`tenant.dashboard.view`), or an **active `owner`/`administrator` academy member** | `academy_id = :id`, tenant-visible actions only |
| Academy / organization dashboard widget | `GET /academies/:id/dashboard`, `GET /organizations/:id/dashboard` (`recentActivity`) | As the dashboards already allow | Last 10 tenant-visible rows of the scope |
| Platform audit log | `GET /audit-log/feed` (cursor), `GET /audit-log` (offset, kept for compatibility), `GET /audit-log/:id` | Platform Owner | Everything |

**Role decision — managers are not admitted to the Academy activity log.**
The permission model treats an Academy Manager as an *operator*, not an
administrator: `ORGANIZATION_MANAGER_PERMISSIONS` deliberately excludes every
`tenant.*` (billing, payments, subscription) string, and only the owner may
grant team access (`GRANTS_MANAGER_ROLES = {owner}`). The activity log records
exactly those owner-only actions (who granted whom access, payment-settings
and gateway changes) plus every other staff member's work, so it follows the
owner tier. The frontend gates the route, sidebar entry and dashboard widget
on the owner-only `tenant.dashboard.view`.

Feed filters (both feeds): `category`, `action`, `actorUserId`, `targetType`,
`occurredFrom`/`occurredTo` (inclusive ISO-8601), `search` (target label or
actor name), `limit` (1–100, default 25), `cursor`. The Platform feed adds
`organizationId` and `academyId`. `category`/`action` can only narrow the
tenant visibility list. Pagination is keyset on `(occurred_at DESC, id DESC)`
with no `count()`; it is served by the existing
`(academy_id, occurred_at DESC)`, `(organization_id, occurred_at DESC)` and
`(occurred_at DESC)` indexes, so no migration was added.

## Before/after diffs

`diffFields` (only these are ever copied into `changes`):

- `course.updated` — title, slug, short description, description, thumbnail,
  visibility, status, category, pricing type/amount/currency, level,
  language, outcomes, requirements, intro video.
- `quiz.updated` — every quiz setting (title, description, unit, status,
  passing score, attempts, mode, time limit, availability window, due date,
  late/grading policy, shuffling, layout, disclosure, integrity settings,
  progression flags); a replaced question set adds `questionsAdded`,
  `questionsRemoved`, `questionsChanged`, `questionCount` (compared by
  position, signature = prompt, type, points, explanation, accepted answers,
  options and correctness).
- `assignment.updated` — title, description, instructions, unit, lesson,
  status, due date, resubmission, late policy, required-for-completion.
- `academy.updated` — name, slug, description, contact email (masked),
  contact phone, website, language, time zone, currency, status, address.
- `academy.branding.updated`, `website.visual_identity.updated` — name, logo,
  favicon.
- `website_page.updated` — title, slug, visible, SEO; section edits are
  summarised as counts in context.
- `website.configuration.updated` — theme; brand/SEO/navigation/header/footer
  are named in `changedAreas` rather than copied.
- `website_faq.updated`, `website_testimonial.updated` — the entry's fields.
- `academy.registration_policy.updated`, `enrollment.expiry_updated`,
  `organization.payment_settings.updated`, `website.published`/`unpublished`,
  `academy.archived` — explicit from/to of the one field that changed.

## Supported actions

Visible = shown to Academy/Organization owners. Context = the only keys the
writer stores.

| Action | Category | Scope | Visible | Context |
| --- | --- | --- | --- | --- |
| `course.created` | courses | academy | yes | — |
| `course.updated` | courses | academy | yes | — |
| `course.published` | courses | academy | yes | — |
| `course.unpublished` | courses | academy | yes | — |
| `course.archived` | courses | academy | yes | — |
| `course.instructor_assigned` | courses | academy | yes | targetUserId, instructorName |
| `course.instructor_removed` | courses | academy | yes | targetUserId, instructorName |
| `course.completion_rule.updated` | courses | academy | yes | lessons, requiredQuizzes, requiredAssignments, minOverallScore, certificatesEnabled, certificateMinScore |
| `course_section.created` | courses | academy | yes | courseId, courseTitle |
| `course_section.updated` | courses | academy | yes | courseId, courseTitle |
| `course_section.deleted` | courses | academy | yes | courseId, courseTitle |
| `course_section.reordered` | courses | academy | yes | courseId, courseTitle, sectionCount |
| `course_lesson.created` | courses | academy | yes | courseId, courseTitle, sectionId, sectionTitle, videoAssetId, isPreview |
| `course_lesson.updated` | courses | academy | yes | courseId, courseTitle, sectionId, sectionTitle, videoAssetId, isPreview |
| `course_lesson.content_updated` | courses | academy | yes | courseId, courseTitle, sectionId, sectionTitle, kind, mediaAssetId |
| `course_lesson.deleted` | courses | academy | yes | courseId, courseTitle, sectionId, sectionTitle |
| `course.curriculum.item_attached` | courses | academy | yes | courseId, courseTitle, sectionId, sectionTitle, itemType |
| `course.curriculum.item_detached` | courses | academy | yes | courseId, courseTitle, sectionId, sectionTitle, itemType |
| `course.curriculum.items_reordered` | courses | academy | yes | courseId, courseTitle, sectionId, sectionTitle, itemCount, legacyLessonsEndpoint |
| `quiz.created` | assessments | academy | yes | courseId, courseTitle |
| `quiz.updated` | assessments | academy | yes | courseId, courseTitle, questionsAdded, questionsRemoved, questionsChanged, questionCount |
| `quiz.deleted` | assessments | academy | yes | courseId, courseTitle |
| `quiz.override.updated` | assessments | academy | yes | courseId, courseTitle, quizId, quizTitle, studentId, studentName, timeMultiplier, extraAttempts |
| `quiz.override.removed` | assessments | academy | yes | courseId, courseTitle, quizId, quizTitle, studentId, studentName |
| `quiz_attempt.graded` | assessments | academy | yes | courseId, courseTitle, quizId, quizTitle, score, finalized |
| `quiz_attempt.invalidated` | assessments | academy | yes | courseId, courseTitle, quizId, quizTitle, reason, previousStatus |
| `assignment.created` | assessments | academy | yes | courseId, courseTitle |
| `assignment.updated` | assessments | academy | yes | courseId, courseTitle |
| `assignment.deleted` | assessments | academy | yes | courseId, courseTitle |
| `assignment_submission.graded` | assessments | academy | yes | courseId, courseTitle, assignmentId, assignmentTitle, score |
| `website.configuration.updated` | website | academy | yes | changedAreas |
| `website.visual_identity.updated` | website | academy | yes | brandChanged |
| `website.published` | website | academy | yes | pageCount |
| `website.unpublished` | website | academy | yes | — |
| `website_page.created` | website | academy | yes | pageType, slug, sectionsAdded, sectionsRemoved, sectionsUpdated, sectionCount |
| `website_page.updated` | website | academy | yes | pageType, slug, sectionsAdded, sectionsRemoved, sectionsUpdated, sectionCount |
| `website_page.deleted` | website | academy | yes | pageType, slug, sectionsAdded, sectionsRemoved, sectionsUpdated, sectionCount |
| `website_page.published` | website | academy | yes | pageType, slug, sectionsAdded, sectionsRemoved, sectionsUpdated, sectionCount |
| `website_page.sections_reordered` | website | academy | yes | pageType, slug, sectionsAdded, sectionsRemoved, sectionsUpdated, sectionCount |
| `website_faq.created` | website | academy | yes | — |
| `website_faq.updated` | website | academy | yes | — |
| `website_faq.published` | website | academy | yes | — |
| `website_faq.archived` | website | academy | yes | — |
| `website_testimonial.created` | website | academy | yes | — |
| `website_testimonial.updated` | website | academy | yes | — |
| `website_testimonial.published` | website | academy | yes | — |
| `website_testimonial.archived` | website | academy | yes | — |
| `academy.created` | academy | academy | yes | requestedName (only when provisioning suffixed a taken name) |
| `academy.updated` | academy | academy | yes | — |
| `academy.branding.updated` | academy | academy | yes | — |
| `academy.archived` | academy | academy | yes | reason, hasFeedback |
| `academy.content_protection.updated` | academy | academy | yes | watermark, disableDownload, disablePip, disableContextMenu |
| `academy.video_tier.updated` | academy | academy | yes | appliesTo, requested |
| `academy.device_policy.updated` | academy | academy | yes | maxDevices, maxConcurrentSessions |
| `academy.registration_policy.updated` | academy | academy | yes | registrationPolicy |
| `academy.manager.added` | team | academy | yes | account, memberName |
| `academy.instructor.added` | team | academy | yes | account, memberName |
| `academy.student.created` | students | academy | yes | account, studentName |
| `academy.student.added` | students | academy | yes | account, studentName |
| `academy.student.joined` | students | academy | yes | existingAccount, source, status |
| `academy.student.name_clash_exempted` | students | academy | yes | source |
| `academy.student.blocked` | students | academy | yes | studentName |
| `academy.student.unblocked` | students | academy | yes | studentName |
| `academy.student.approved` | students | academy | yes | studentName |
| `academy.student.rejected` | students | academy | yes | studentName |
| `academy.invite.created` | students | academy | yes | maxUses, emailInvite |
| `academy.invite.revoked` | students | academy | yes | — |
| `enrollment.granted` | students | academy | yes | studentId, studentName, courseId, courseTitle, expiresAt |
| `enrollment.revoked` | students | academy | yes | studentId, studentName, courseId, courseTitle, reason |
| `enrollment.expiry_updated` | students | academy | yes | studentId, studentName, courseId, courseTitle, expiresAt |
| `learning.device_session_takeover` | students | academy | yes | previousDeviceLabel, courseId, lessonId, newSessionId†, previousSessionId† |
| `certificate.issued` | certificates | academy | yes | enrollmentId, courseId, courseTitle, studentId, studentName, automatic, forced, reason, overallScore |
| `certificate.reissued` | certificates | academy | yes | enrollmentId, courseId, courseTitle, studentId, studentName, automatic, forced, reason, overallScore |
| `certificate.revoked` | certificates | academy | yes | reason, studentId, studentName, courseId, courseTitle |
| `certificate.regenerated` | certificates | academy | yes | version, reason, templateVersion |
| `certificate_template.updated` | certificates | academy | yes | version |
| `course_review.created` | reviews | academy | yes | courseId, courseTitle, rating |
| `course_review.updated` | reviews | academy | yes | courseId, courseTitle, rating, status |
| `course_review.deleted` | reviews | academy | yes | courseId, courseTitle |
| `course_review.approved` | reviews | academy | yes | courseId, courseTitle, status |
| `course_review.rejected` | reviews | academy | yes | courseId, courseTitle, status, reason |
| `course_review.removed` | reviews | academy | yes | courseId, courseTitle, reason |
| `media.uploaded` | media | academy | yes | mediaType, sizeBytes |
| `media.archived` | media | academy | yes | mediaType |
| `media.asset.purged` | media | academy | yes | assetId, provider, bytes, reason, graceDays |
| `media.video.deleted` | media | academy | yes | assetId, bytes, minutes, reason |
| `domain.custom_domain_added` | domains | academy | yes | providerRegistered, error, replacedHostname |
| `domain.custom_domain_removed` | domains | academy | yes | — |
| `domain.verification_checked` | domains | academy | yes | outcome, error, httpsReachable, reRegistered |
| `domain.platform_check` | domains | platform | no | outcome, error, httpsReachable |
| `domain.platform_release` | domains | academy | yes | — |
| `live_session.created` | live_sessions | academy | yes | courseId, courseTitle, recordingEnabled, scheduledStartAt |
| `live_session.updated` | live_sessions | academy | yes | status |
| `live_session.cancelled` | live_sessions | academy | yes | status |
| `live_session.published` | live_sessions | academy | yes | — |
| `live_provider.connected` | live_sessions | academy | yes | academyId, providerKey, externalAccountId |
| `live_provider.disconnected` | live_sessions | academy | yes | academyId, providerKey |
| `live_provider.deauthorized` | live_sessions | academy | yes | academyId, providerKey, deauthorizedAt, externalAccountId, zoomUserId |
| `organization.payment_settings.updated` | payments | organization | yes | — |
| `organization.payment_gateway.credentials_saved` | payments | organization | yes | providerKey |
| `organization.payment_gateway.connection_tested` | payments | organization | yes | providerKey, success |
| `organization.payment_gateway.enabled` | payments | organization | yes | providerKey |
| `organization.payment_gateway.disabled` | payments | organization | yes | providerKey |
| `payment.proof_submitted` | payments | organization | yes | proofId, mimeType |
| `payment.approved` | payments | organization | yes | — |
| `payment.rejected` | payments | organization | yes | notes |
| `course_order_payment.approved` | payments | platform | no | — |
| `course_order_payment.rejected` | payments | platform | no | notes |
| `course_order.refund_recorded` | payments | academy | yes | refundId, amountMinorUnits, currency, paymentCollectionMode |
| `organization.created` | subscription | organization | yes | — |
| `organization.onboarding.completed` | subscription | organization | yes | mode, requiredComplete |
| `provisioning_request.created` | subscription | organization | yes | — |
| `subscription.trial.redeemed` | subscription | organization | yes | planKey, trialEndsAt, durationDays |
| `subscription.gift.granted` | subscription | organization | yes | planKey, billingCycle, giftedDays, giftedEndsAt, paymentId |
| `subscription.trial.cancelled` | subscription | organization | yes | reason, hasFeedback, effectiveAt |
| `subscription.cancelled` | subscription | organization | yes | reason, hasFeedback, effectiveAt, previousStatus |
| `subscription.grace_started` | subscription | organization | yes | previousStatus, newStatus, reason, at, currentPeriodEnd, graceEndsAt |
| `subscription.expired` | subscription | organization | yes | previousStatus, newStatus, reason, at, currentPeriodEnd, graceEndsAt |
| `subscription.cancelled_at_period_end` | subscription | organization | yes | previousStatus, newStatus, reason, at, currentPeriodEnd, graceEndsAt |
| `add_on.install` | subscription | organization | yes | addOnKey |
| `add_on.enable` | subscription | organization | yes | addOnKey |
| `add_on.disable` | subscription | organization | yes | addOnKey |
| `add_on.uninstall` | subscription | organization | yes | addOnKey |
| `support_case.created` | support | organization | yes | — |
| `support_case.replied` | support | organization | yes | — |
| `support_case.status_changed` | support | organization | yes | status |
| `support_case.auto_created` | support | organization | yes | provisioningRequestId, stepKey, attemptCount, errorCode |
| `auth.otp.issued` | security | platform | no | surface, challengeId, outboxId, resend, attempts, attemptsRemaining, reason, ipAddress |
| `auth.otp.failed` | security | platform | no | surface, challengeId, outboxId, resend, attempts, attemptsRemaining, reason, ipAddress |
| `auth.otp.locked_out` | security | platform | no | surface, challengeId, outboxId, resend, attempts, attemptsRemaining, reason, ipAddress |
| `auth.otp.verified` | security | platform | no | surface, challengeId, outboxId, resend, attempts, attemptsRemaining, reason, ipAddress |
| `auth.device.trusted` | security | platform | no | surface, trustDays, label |
| `auth.device.revoked` | security | platform | no | scope, count, reason |
| `auth.identity.linked` | security | platform | no | provider, via |
| `auth.identity.unlinked` | security | platform | no | provider |
| `auth.sessions.revoked` | security | platform | no | trigger, sessionsRevoked, trustedDevicesRevoked |
| `password_reset.confirmed` | security | platform | no | trigger, sessionsRevoked, trustedDevicesRevoked |
| `account.deletion.requested` | security | platform | no | challengeId |
| `account.deletion.code_failed` | security | platform | no | challengeId, attempts |
| `account.deletion.locked_out` | security | platform | no | challengeId |
| `account.deletion.confirmed` | security | platform | no | challengeId |
| `account.deleted` | security | platform | no | initiatedBy, reason, hasFeedback, sessionsRevoked |
| `account.deleted_by_platform_owner` | security | platform | no | initiatedBy, reason, hasFeedback, sessionsRevoked |
| `plan.created` | platform | platform | no | key |
| `plan.updated` | platform | platform | no | key |
| `plan.pricing_changed` | platform | platform | no | key |
| `plan.trial_config_changed` | platform | platform | no | key |
| `plan.archived` | platform | platform | no | key, subscriptionsAtArchive |
| `platform_settings.updated` | platform | platform | no | platformName, platformDescription, supportEmail, twoFactorRequired, sessionTimeoutMinutes |
| `payment_method.created` | platform | platform | no | key, type, enabled |
| `payment_method.updated` | platform | platform | no | fields, enabled |
| `commission_config.global_default_updated` | platform | platform | no | defaultCommissionBasisPoints |
| `add_on.catalog_status_changed` | platform | platform | no | addOnKey, previousStatus, newStatus |
| `observability.synthetic_alert.armed` | platform | platform | no | minutes |
| `observability.synthetic_alert.resolved` | platform | platform | no | — |
| `platform.contact_submission.status_changed` | platform | platform | no | status, previousStatus |
| `platform.contact_submission.deleted` | platform | platform | no | status |
| `platform.campaign.sent` | platform | platform | no | audienceType, channels, recipientCount, mailCount, inAppCount |
| `academy.message.sent` | academy | academy | yes | audienceType, channels, recipientCount, mailCount, inAppCount |

† Stored for operators only; removed from tenant responses by `TENANT_HIDDEN_CONTEXT_KEYS`.

## Intentionally excluded or not tenant-visible

- **Sign-in and account-security telemetry** (`auth.*`, `password_reset.*`,
  `account.*`) — the operator's security record; often carries an IP address.
  Stored, Platform-only.
- **Platform operator configuration** (`plan.*`, `platform_settings.*`,
  `payment_method.*`, `commission_config.*`, `add_on.catalog_status_changed`,
  `observability.*`, `platform.contact_submission.*`) — Platform-only.
- **`domain.platform_check`** — automatic health probes; noise in a customer
  feed. `domain.platform_release` *is* shown (the customer's hostname was
  released), attributed to "Atlas".
- **Course payment review** (`course_order_payment.*`) — Platform payment
  operations; Platform-only.
- **Not audited at all:** reads; editing-presence heartbeats; a learner's own
  submission attachment uploads and automated recording imports
  (`media.uploaded` is written only for a staff library upload); learner
  progress/attempt events (they have their own records); rate-limit and
  validation refusals (a refused mutation writes nothing because it rolls
  back).
- **History is not backfilled.** Rows written before an action gained names
  or diffs keep what they had; the UI says "no field-by-field changes were
  recorded" rather than inventing them.

## Known gaps

- Organization-scoped events (payment settings, subscription, support) have
  no `academy_id` and therefore appear on the organization dashboard widget,
  not in an individual academy's activity log.
- `certificate_template.updated` and `course.completion_rule.updated` record
  the new values in context but not a before/after diff.
