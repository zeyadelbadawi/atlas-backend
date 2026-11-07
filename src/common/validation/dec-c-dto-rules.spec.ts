/**
 * Owner-approved backend support for the UX audit's "Not changed" items
 * (B3 price maximum, B5/B8 Arabic catalog names, B6 V17 review filters,
 * B8 subscription payer reference, B8 V08 notice preview): the request
 * DTOs' rules, as the person sees them — one violation per field, with
 * the key the frontend translates.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { classValidatorErrorsToViolations } from './class-validator-violations.util';
import { CoursePricingInputDto } from '../../course/dto/course-pricing-input.dto';
import {
  AssignmentSubmissionListQueryDto,
  QuizAttemptListQueryDto,
} from '../../instructor/dto/instructor-list-query.dto';
import { SubmitPaymentProofDto } from '../../billing/dto/submit-payment-proof.dto';
import {
  CreatePlatformInstapayMethodDto,
  UpdatePlatformPaymentMethodDto,
} from '../../billing/dto/platform-payment-method.dto';
import { UpdateAddOnArabicTextDto } from '../../platform/dto/update-add-on-arabic-text.dto';
import { PreviewPlanNoticeDto } from '../../platform/dto/preview-plan-notice.dto';

function violationsFor<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
) {
  return classValidatorErrorsToViolations(validateSync(plainToInstance(cls, plain)));
}

describe('CoursePricingInputDto — B3 price maximum', () => {
  it.each([1, 99.99, 1_000_000])('accepts a paid price of %p', (amount) => {
    expect(violationsFor(CoursePricingInputDto, { type: 'paid', amount })).toEqual([]);
  });

  it('refuses a price above 1,000,000 with the form’s own message and maximum', () => {
    expect(
      violationsFor(CoursePricingInputDto, { type: 'paid', amount: 1_000_000.01 }),
    ).toEqual([
      {
        field: 'amount',
        messageKey: 'course:validation.priceTooHigh',
        values: { max: '1,000,000' },
      },
    ]);
  });

  it('does not check the amount of a free course', () => {
    expect(
      violationsFor(CoursePricingInputDto, { type: 'free', amount: 5_000_000 }),
    ).toEqual([]);
  });
});

describe('QuizAttemptListQueryDto — B6 V17 filters', () => {
  it('accepts every documented filter with paging', () => {
    const query = plainToInstance(QuizAttemptListQueryDto, {
      page: '2',
      pageSize: '10',
      status: 'submitted',
      gradingStatus: 'pending',
      flagged: 'true',
      late: 'false',
      search: 'nour',
    });
    expect(validateSync(query)).toEqual([]);
    expect(query.flagged).toBe(true);
    expect(query.late).toBe(false);
  });

  it.each([
    ['status', 'not_started'],
    ['status', 'bogus'],
    ['gradingStatus', 'ungraded'],
    ['flagged', 'yes'],
    ['late', '1'],
  ])('refuses %s=%p as one invalid-field violation', (field, value) => {
    expect(violationsFor(QuizAttemptListQueryDto, { [field]: value })).toEqual([
      { field, messageKey: 'validation:invalid' },
    ]);
  });
});

describe('AssignmentSubmissionListQueryDto — B6 V17 filters', () => {
  it('accepts grading status and late', () => {
    expect(
      violationsFor(AssignmentSubmissionListQueryDto, {
        gradingStatus: 'ungraded',
        late: 'true',
      }),
    ).toEqual([]);
  });

  it('refuses a quiz-only grading status', () => {
    expect(
      violationsFor(AssignmentSubmissionListQueryDto, { gradingStatus: 'pending' }),
    ).toEqual([{ field: 'gradingStatus', messageKey: 'validation:invalid' }]);
  });
});

describe('SubmitPaymentProofDto — subscription payer reference', () => {
  const proof = {
    fileData: 'data:image/png;base64,AAAA',
    fileName: 'receipt.png',
    mimeType: 'image/png',
  };

  it('accepts a proof with or without a payer reference', () => {
    expect(violationsFor(SubmitPaymentProofDto, proof)).toEqual([]);
    expect(
      violationsFor(SubmitPaymentProofDto, { ...proof, payerReference: 'TRX-0042' }),
    ).toEqual([]);
  });

  it('refuses a reference over 120 characters, as for a course-order proof', () => {
    const violations = violationsFor(SubmitPaymentProofDto, {
      ...proof,
      payerReference: 'x'.repeat(121),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].field).toBe('payerReference');
  });
});

describe('Payment method DTOs — B5/B8 Arabic name and description', () => {
  const instapay = {
    displayName: 'InstaPay',
    instructions: {
      accountName: 'Atlas',
      instructions: 'Send the amount.',
      referenceInstructions: 'Use the Checkout ID.',
      instapayAddress: 'atlas@instapay',
    },
  };

  it('accepts optional Arabic texts', () => {
    expect(
      violationsFor(CreatePlatformInstapayMethodDto, {
        ...instapay,
        displayNameAr: 'إنستاباي',
        descriptionAr: 'تحويل فوري',
      }),
    ).toEqual([]);
    expect(violationsFor(UpdatePlatformPaymentMethodDto, { displayNameAr: '' })).toEqual(
      [],
    );
  });

  it('caps the Arabic name at 80 and the description at 300 characters', () => {
    const fields = violationsFor(UpdatePlatformPaymentMethodDto, {
      displayNameAr: 'ا'.repeat(81),
      descriptionAr: 'ا'.repeat(301),
    }).map((violation) => violation.field);
    expect(fields.sort()).toEqual(['descriptionAr', 'displayNameAr']);
  });
});

describe('UpdateAddOnArabicTextDto — B5 add-on Arabic name', () => {
  it('accepts texts (blank clears) with the version', () => {
    expect(
      violationsFor(UpdateAddOnArabicTextDto, {
        nameAr: 'الشهادات',
        descriptionAr: '',
        expectedVersion: 3,
      }),
    ).toEqual([]);
  });

  it('requires both fields and the version, within their lengths', () => {
    const fields = violationsFor(UpdateAddOnArabicTextDto, {
      nameAr: 'ا'.repeat(81),
    }).map((violation) => violation.field);
    expect([...new Set(fields)].sort()).toEqual([
      'descriptionAr',
      'expectedVersion',
      'nameAr',
    ]);
  });
});

describe('PreviewPlanNoticeDto — B8 V08', () => {
  it('accepts a proposed price and limits', () => {
    expect(
      violationsFor(PreviewPlanNoticeDto, {
        pricing: { amount: 990, currency: 'EGP', billingCycle: 'monthly' },
        limits: { courses: 10 },
      }),
    ).toEqual([]);
  });

  it('checks the price like the save does', () => {
    expect(
      violationsFor(PreviewPlanNoticeDto, {
        pricing: { amount: 0, currency: 'EGP', billingCycle: 'monthly' },
      }).map((violation) => violation.field),
    ).toEqual(['pricing.amount']);
  });
});
