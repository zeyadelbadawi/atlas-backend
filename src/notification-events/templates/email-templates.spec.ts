import { renderEmailTemplate, EMAIL_TEMPLATE_KEYS } from './email-templates';

describe('renderEmailTemplate', () => {
  it('renders every registered template key without throwing, producing a non-empty subject/text', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const { subject, text } = renderEmailTemplate(key, {
        academyName: 'Test Academy',
        courseTitle: 'Test Course',
        amount: '10.00',
        currency: 'USD',
        subject: 'Test subject',
        reason: 'Test reason',
      });
      expect(subject.length).toBeGreaterThan(0);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('interpolates provided values into the rendered text', () => {
    const { text } = renderEmailTemplate('course_order_paid', {
      courseTitle: 'Spanish 101',
    });
    expect(text).toContain('Spanish 101');
  });

  it('falls back gracefully when a value is missing (never throws, never renders "undefined")', () => {
    const { text } = renderEmailTemplate('course_order_paid', {});
    expect(text).not.toContain('undefined');
  });

  it('omits the optional reason clause on platform_payment_rejected when no reason is given', () => {
    const withoutReason = renderEmailTemplate('platform_payment_rejected', {
      amount: '10',
      currency: 'USD',
    });
    expect(withoutReason.text).not.toContain('Reason:');

    const withReason = renderEmailTemplate('platform_payment_rejected', {
      amount: '10',
      currency: 'USD',
      reason: 'insufficient proof',
    });
    expect(withReason.text).toContain('Reason: insufficient proof');
  });
});
