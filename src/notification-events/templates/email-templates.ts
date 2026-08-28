/**
 * Email content templates — Phase P17.
 *
 * SPECIFICATION-UNDEFINED, documented rather than fabricated: no
 * server-side email-templating or localization system exists anywhere in
 * this codebase (the frontend's i18next setup only ever renders inside
 * the SPA, never into an email an external inbox receives), and neither
 * the master plan nor the frontend defines one for P17. Building a full
 * localized-email-template engine mirroring the frontend's i18next setup
 * is disproportionate to this phase's scope (master plan §21 P17's own
 * "keep P17 appropriately scoped" instruction) — every template below is
 * a small, English-only, server-side function, not a claim that this is
 * the final production email design. Revisit if/when Atlas needs
 * localized transactional email.
 */
import type { TransactionalEmailInput } from '../../identity/services/email-provider.interface';

export const EMAIL_TEMPLATE_KEYS = [
  'provisioning_completed',
  'provisioning_failed',
  'course_order_paid',
  'course_order_payment_failed',
  'course_order_refunded',
  'platform_payment_approved',
  'platform_payment_rejected',
  'support_case_reply',
  'password_changed',
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

type TemplateBody = Pick<TransactionalEmailInput, 'subject' | 'text'>;
type TemplateRenderer = (values: Record<string, unknown>) => TemplateBody;

function str(values: Record<string, unknown>, key: string, fallback = ''): string {
  const value = values[key];
  return typeof value === 'string' ? value : fallback;
}

const TEMPLATES: Record<EmailTemplateKey, TemplateRenderer> = {
  provisioning_completed: (v) => ({
    subject: 'Your academy is ready',
    text: `Good news — "${str(v, 'academyName')}" has finished provisioning and is ready to use.`,
  }),
  provisioning_failed: (v) => ({
    subject: 'We could not finish setting up your academy',
    text: `We ran into a problem provisioning "${str(v, 'academyName')}". Our team has been notified — please contact support if this persists.`,
  }),
  course_order_paid: (v) => ({
    subject: 'Purchase confirmed',
    text: `Your purchase of "${str(v, 'courseTitle')}" is confirmed. You now have access to the course.`,
  }),
  course_order_payment_failed: (v) => ({
    subject: 'Payment failed',
    text: `Your payment for "${str(v, 'courseTitle')}" could not be completed. Please try again or use a different payment method.`,
  }),
  course_order_refunded: (v) => ({
    subject: 'Refund processed',
    text: `Your purchase of "${str(v, 'courseTitle')}" has been refunded.`,
  }),
  platform_payment_approved: (v) => ({
    subject: 'Payment approved',
    text: `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} has been approved.`,
  }),
  platform_payment_rejected: (v) => ({
    subject: 'Payment rejected',
    text: `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} was rejected.${
      str(v, 'reason') ? ` Reason: ${str(v, 'reason')}` : ''
    }`,
  }),
  support_case_reply: (v) => ({
    subject: `New reply on "${str(v, 'subject')}"`,
    text: `There's a new reply on your support case "${str(v, 'subject')}".`,
  }),
  password_changed: () => ({
    subject: 'Your password was changed',
    text: 'Your Atlas account password was just changed. If this was not you, contact support immediately.',
  }),
};

export function renderEmailTemplate(
  key: EmailTemplateKey,
  values: Record<string, unknown>,
): TemplateBody {
  return TEMPLATES[key](values);
}
