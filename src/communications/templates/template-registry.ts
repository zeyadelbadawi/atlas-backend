/**
 * TemplateRegistry — P64 Communications C2. Resolves a template id to its
 * `en`/`ar` copy and renders subject, plain text and HTML in one call.
 * Every catalogue key has a template here (asserted by the unit test);
 * `digest.daily` is the one template without a catalogue key.
 */
import type { CommunicationLocale } from '../catalog/communication-catalog';
import type { BrandingContext, CommunicationTemplate, TemplateValues } from './layout';
import { template as provisioningCompleted } from './keys/provisioning.completed';
import { template as provisioningFailed } from './keys/provisioning.failed';
import { template as courseOrderPaid } from './keys/course.order.paid';
import { template as courseOrderPaymentFailed } from './keys/course.order.payment_failed';
import { template as courseOrderRefunded } from './keys/course.order.refunded';
import { template as platformPaymentApproved } from './keys/platform.payment.approved';
import { template as platformPaymentRejected } from './keys/platform.payment.rejected';
import { template as supportCaseReply } from './keys/support.case.reply';
import { template as supportCaseStatusChanged } from './keys/support.case.status_changed';
import { template as authPasswordChanged } from './keys/auth.password.changed';
import { template as authIdentityLinked } from './keys/auth.identity.linked';
import { template as authIdentityUnlinked } from './keys/auth.identity.unlinked';
import { template as accountAcademyJoined } from './keys/account.academy.joined';
import { template as authEmailVerification } from './keys/auth.email.verification';
import { template as authEmailOtp } from './keys/auth.email.otp';
import { template as authPasswordReset } from './keys/auth.password.reset';
import { template as authPasswordResetConfirmed } from './keys/auth.password.reset_confirmed';
import { template as liveSessionRecordingAvailable } from './keys/live_session.recording_available';
import { template as liveSessionScheduled } from './keys/live_session.scheduled';
import { template as liveSessionRescheduled } from './keys/live_session.rescheduled';
import { template as liveSessionCancelled } from './keys/live_session.cancelled';
import { template as liveSessionStartingSoon } from './keys/live_session.starting_soon';
import { template as liveProviderDeauthorized } from './keys/live_provider.deauthorized';
import { template as assignmentGraded } from './keys/assessment.assignment.graded';
import { template as quizGraded } from './keys/assessment.quiz.graded';
import { template as exceptionGranted } from './keys/assessment.exception.granted';
import { template as exceptionActivated } from './keys/assessment.exception.activated';
import { template as exceptionRevoked } from './keys/assessment.exception.revoked';
import { template as certificateIssued } from './keys/certificate.issued';
import { template as certificateRevoked } from './keys/certificate.revoked';
import { template as enrollmentGranted } from './keys/enrollment.granted';
import { template as enrollmentRevoked } from './keys/enrollment.revoked';
import { template as enrollmentExpiryChanged } from './keys/enrollment.expiry_changed';
import { template as rosterStudentApproved } from './keys/roster.student.approved';
import { template as rosterStudentRejected } from './keys/roster.student.rejected';
import { template as rosterStudentBlocked } from './keys/roster.student.blocked';
import { template as rosterStudentUnblocked } from './keys/roster.student.unblocked';
import { template as courseOrderProofSubmitted } from './keys/course.order.proof_submitted';
import { template as reviewModerated } from './keys/review.moderated';
import { template as academyMemberInvited } from './keys/academy.member.invited';
import { template as academyMemberAdded } from './keys/academy.member.added';
import { template as reviewSubmitted } from './keys/review.submitted';
import { template as rosterStudentAwaitingApproval } from './keys/roster.student.awaiting_approval';
import { template as enrollmentSelfEnrolled } from './keys/enrollment.self_enrolled';
import { template as courseOrderCreated } from './keys/course.order.created';
import { template as courseOrderExpired } from './keys/course.order.expired';
import { template as quizAutoSubmitted } from './keys/assessment.quiz.auto_submitted';
import { template as attemptInvalidated } from './keys/assessment.attempt.invalidated';
import { template as courseCompleted } from './keys/course.completed';
import { template as deviceRegistered } from './keys/device.registered';
import { template as deviceRemoved } from './keys/device.removed';
import { template as deviceLimitReached } from './keys/device.limit_reached';
import { template as sessionTakenOver } from './keys/session.taken_over';
import { template as announcementPublished } from './keys/announcement.published';
import { template as digestDaily } from './keys/digest.daily';
// P64 C5 — tenant lifecycle sequences (plan §26 T1–T6, §27 S1–S10).
import { template as lifecycleTrialStarted } from './keys/lifecycle.trial.started';
import { template as lifecycleTrialEndingSoon } from './keys/lifecycle.trial.ending_soon';
import { template as lifecycleTrialExpired } from './keys/lifecycle.trial.expired';
import { template as lifecycleTrialFollowup3d } from './keys/lifecycle.trial.followup_3d';
import { template as lifecycleTrialFollowup14d } from './keys/lifecycle.trial.followup_14d';
import { template as lifecycleTrialReactivation45d } from './keys/lifecycle.trial.reactivation_45d';
import { template as lifecycleSubscriptionActivated } from './keys/lifecycle.subscription.activated';
import { template as lifecycleSubscriptionPaymentSubmitted } from './keys/lifecycle.subscription.payment_submitted';
import { template as lifecycleSubscriptionRenewalDue } from './keys/lifecycle.subscription.renewal_due';
import { template as lifecycleSubscriptionRenewalTomorrow } from './keys/lifecycle.subscription.renewal_tomorrow';
import { template as lifecycleSubscriptionGraceStarted } from './keys/lifecycle.subscription.grace_started';
import { template as lifecycleSubscriptionGraceEnding } from './keys/lifecycle.subscription.grace_ending';
import { template as lifecycleSubscriptionExpired } from './keys/lifecycle.subscription.expired';
import { template as lifecycleSubscriptionCancelScheduled } from './keys/lifecycle.subscription.cancel_scheduled';
import { template as lifecycleSubscriptionCancelled } from './keys/lifecycle.subscription.cancelled';
import { template as lifecycleSubscriptionFollowup7d } from './keys/lifecycle.subscription.followup_7d';
import { template as lifecycleSubscriptionFollowup30d } from './keys/lifecycle.subscription.followup_30d';
// P64 C6 — hosted-video retention (plan §31/§32).
import { template as retentionVideoWarning30d } from './keys/retention.video.warning_30d';
import { template as retentionVideoWarning14d } from './keys/retention.video.warning_14d';
import { template as retentionVideoWarning7d } from './keys/retention.video.warning_7d';
import { template as retentionVideoWarning24h } from './keys/retention.video.warning_24h';
import { template as retentionVideoDeleted } from './keys/retention.video.deleted';
import { template as retentionVideoDeletionFailed } from './keys/retention.video.deletion_failed';

export const TEMPLATES: Record<string, CommunicationTemplate> = {
  'provisioning.completed': provisioningCompleted,
  'provisioning.failed': provisioningFailed,
  'course.order.paid': courseOrderPaid,
  'course.order.payment_failed': courseOrderPaymentFailed,
  'course.order.refunded': courseOrderRefunded,
  'platform.payment.approved': platformPaymentApproved,
  'platform.payment.rejected': platformPaymentRejected,
  'support.case.reply': supportCaseReply,
  'support.case.status_changed': supportCaseStatusChanged,
  'auth.password.changed': authPasswordChanged,
  'account.academy.joined': accountAcademyJoined,
  'auth.identity.linked': authIdentityLinked,
  'auth.identity.unlinked': authIdentityUnlinked,
  'auth.email.verification': authEmailVerification,
  'auth.email.otp': authEmailOtp,
  'auth.password.reset': authPasswordReset,
  'auth.password.reset_confirmed': authPasswordResetConfirmed,
  'live_session.recording_available': liveSessionRecordingAvailable,
  'live_session.scheduled': liveSessionScheduled,
  'live_session.rescheduled': liveSessionRescheduled,
  'live_session.cancelled': liveSessionCancelled,
  'live_session.starting_soon': liveSessionStartingSoon,
  'live_provider.deauthorized': liveProviderDeauthorized,
  'assessment.assignment.graded': assignmentGraded,
  'assessment.quiz.graded': quizGraded,
  'assessment.exception.granted': exceptionGranted,
  'assessment.exception.activated': exceptionActivated,
  'assessment.exception.revoked': exceptionRevoked,
  'certificate.issued': certificateIssued,
  'certificate.revoked': certificateRevoked,
  'enrollment.granted': enrollmentGranted,
  'enrollment.revoked': enrollmentRevoked,
  'enrollment.expiry_changed': enrollmentExpiryChanged,
  'roster.student.approved': rosterStudentApproved,
  'roster.student.rejected': rosterStudentRejected,
  'roster.student.blocked': rosterStudentBlocked,
  'roster.student.unblocked': rosterStudentUnblocked,
  'course.order.proof_submitted': courseOrderProofSubmitted,
  'review.moderated': reviewModerated,
  'lifecycle.trial.started': lifecycleTrialStarted,
  'lifecycle.trial.ending_soon': lifecycleTrialEndingSoon,
  'lifecycle.trial.expired': lifecycleTrialExpired,
  'lifecycle.trial.followup_3d': lifecycleTrialFollowup3d,
  'lifecycle.trial.followup_14d': lifecycleTrialFollowup14d,
  'lifecycle.trial.reactivation_45d': lifecycleTrialReactivation45d,
  'lifecycle.subscription.activated': lifecycleSubscriptionActivated,
  'lifecycle.subscription.payment_submitted': lifecycleSubscriptionPaymentSubmitted,
  'lifecycle.subscription.renewal_due': lifecycleSubscriptionRenewalDue,
  'lifecycle.subscription.renewal_tomorrow': lifecycleSubscriptionRenewalTomorrow,
  'lifecycle.subscription.grace_started': lifecycleSubscriptionGraceStarted,
  'lifecycle.subscription.grace_ending': lifecycleSubscriptionGraceEnding,
  'lifecycle.subscription.expired': lifecycleSubscriptionExpired,
  'lifecycle.subscription.cancel_scheduled': lifecycleSubscriptionCancelScheduled,
  'lifecycle.subscription.cancelled': lifecycleSubscriptionCancelled,
  'lifecycle.subscription.followup_7d': lifecycleSubscriptionFollowup7d,
  'lifecycle.subscription.followup_30d': lifecycleSubscriptionFollowup30d,
  'retention.video.warning_30d': retentionVideoWarning30d,
  'retention.video.warning_14d': retentionVideoWarning14d,
  'retention.video.warning_7d': retentionVideoWarning7d,
  'retention.video.warning_24h': retentionVideoWarning24h,
  'retention.video.deleted': retentionVideoDeleted,
  'retention.video.deletion_failed': retentionVideoDeletionFailed,
  'academy.member.invited': academyMemberInvited,
  'academy.member.added': academyMemberAdded,
  'review.submitted': reviewSubmitted,
  'roster.student.awaiting_approval': rosterStudentAwaitingApproval,
  'enrollment.self_enrolled': enrollmentSelfEnrolled,
  'course.order.created': courseOrderCreated,
  'course.order.expired': courseOrderExpired,
  'assessment.quiz.auto_submitted': quizAutoSubmitted,
  'assessment.attempt.invalidated': attemptInvalidated,
  'course.completed': courseCompleted,
  'device.registered': deviceRegistered,
  'device.removed': deviceRemoved,
  'device.limit_reached': deviceLimitReached,
  'session.taken_over': sessionTakenOver,
  'announcement.published': announcementPublished,
  'digest.daily': digestDaily,
};

export const DIGEST_TEMPLATE = 'digest.daily';

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** `${templateId}@${version}` — recorded on the delivery row. */
  readonly version: string;
}

export interface RenderInput {
  readonly branding: BrandingContext;
  readonly actionUrl: string | null;
  readonly settingsUrl: string;
}

export class TemplateRegistry {
  static has(templateId: string): boolean {
    return Object.prototype.hasOwnProperty.call(TEMPLATES, templateId);
  }

  static render(
    templateId: string,
    locale: CommunicationLocale,
    input: RenderInput,
    values: TemplateValues = {},
  ): RenderedEmail {
    const template = TEMPLATES[templateId];
    if (!template) throw new Error(`Unknown communication template: ${templateId}`);
    const copy = template[locale];
    const context = {
      locale,
      branding: input.branding,
      actionUrl: input.actionUrl,
      settingsUrl: input.settingsUrl,
    };
    return {
      subject: copy.subject(values, context),
      text: copy.text(values, context),
      html: copy.html(values, context),
      version: `${templateId}@${template.version}`,
    };
  }
}
