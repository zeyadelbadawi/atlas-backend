import {
  toLearnerCoursePaymentResponse,
  type LearnerCoursePaymentRow,
} from './learner-course-payment.contract';

function row(overrides: Partial<LearnerCoursePaymentRow> = {}): LearnerCoursePaymentRow {
  return {
    id: 'p2',
    courseOrderId: 'o1',
    payeeAcademyId: 'a1',
    methodType: 'manual_instapay',
    provider: 'academy_manual',
    amountMinorUnits: 150000n,
    currency: 'EGP',
    status: 'failed',
    reviewStatus: 'rejected',
    reviewNotes: 'Amount did not match',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T11:00:00Z'),
    courseOrder: {
      id: 'o1',
      status: 'pending_payment',
      courseId: 'c1',
      snapshot: { course: { id: 'c1', title: 'Calligraphy' } },
      payments: [{ id: 'p2' }],
    },
    proofs: [
      {
        id: 'pr1',
        fileName: 'r.png',
        mimeType: 'image/png',
        payerReference: 'TRX-1',
        uploadedAt: new Date('2026-10-01T10:05:00Z'),
      },
    ],
    ...overrides,
  } as LearnerCoursePaymentRow;
}

describe('learner course payment contract', () => {
  it('a rejected newest payment on an open order can be paid again, with its reason', () => {
    const res = toLearnerCoursePaymentResponse(row());
    expect(res).toMatchObject({
      course: { id: 'c1', title: 'Calligraphy' },
      money: { amountMinorUnits: 150000, currency: 'EGP' },
      rejectionReason: 'Amount did not match',
      canSubmitNewPayment: true,
      awaitingProof: false,
      proof: {
        payerReference: 'TRX-1',
        fileUrl: '/course-orders/o1/payments/p2/proof/file',
      },
    });
  });

  it('an older rejected payment, or one on a closed order, cannot be paid again', () => {
    const older = row({
      courseOrder: { ...row().courseOrder!, payments: [{ id: 'p9' }] },
    });
    expect(toLearnerCoursePaymentResponse(older).canSubmitNewPayment).toBe(false);
    const paid = row({ courseOrder: { ...row().courseOrder!, status: 'paid' } });
    expect(toLearnerCoursePaymentResponse(paid).canSubmitNewPayment).toBe(false);
  });

  it('never exposes reviewer notes on a payment that was not rejected', () => {
    const approved = row({
      status: 'succeeded',
      reviewStatus: 'approved',
      reviewNotes: 'internal',
    });
    expect(toLearnerCoursePaymentResponse(approved).rejectionReason).toBeUndefined();
  });

  it('flags a payment that is waiting for the learner’s proof', () => {
    const waiting = row({ status: 'pending', reviewStatus: 'not_required', proofs: [] });
    const res = toLearnerCoursePaymentResponse(waiting);
    expect(res.awaitingProof).toBe(true);
    expect(res.proof).toBeUndefined();
  });
});
