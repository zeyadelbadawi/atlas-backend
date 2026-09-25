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
import { template as authEmailVerification } from './keys/auth.email.verification';
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
import { template as digestDaily } from './keys/digest.daily';

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
  'auth.email.verification': authEmailVerification,
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
