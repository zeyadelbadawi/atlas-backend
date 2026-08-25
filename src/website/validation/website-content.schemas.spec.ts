import {
  createFaqEntrySchema,
  createTestimonialEntrySchema,
  updateFaqEntrySchema,
  updateTestimonialEntrySchema,
} from './website-content.schemas';
import {
  MAX_FAQ_ANSWER_LENGTH,
  MAX_FAQ_QUESTION_LENGTH,
  MAX_TESTIMONIAL_AUTHOR_NAME_LENGTH,
  MAX_TESTIMONIAL_AUTHOR_ROLE_LENGTH,
  MAX_TESTIMONIAL_QUOTE_LENGTH,
} from '../constants/website.constants';

describe('createFaqEntrySchema', () => {
  const valid = {
    question: { en: 'What is this?', ar: 'ما هذا؟' },
    answer: { en: 'An answer.', ar: 'جواب.' },
  };

  it('accepts a well-formed bilingual entry', () => {
    expect(createFaqEntrySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a missing Arabic question (both languages required)', () => {
    const result = createFaqEntrySchema.safeParse({
      ...valid,
      question: { en: 'What is this?', ar: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing English question', () => {
    const result = createFaqEntrySchema.safeParse({
      ...valid,
      question: { en: '', ar: 'ما هذا؟' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a question missing the `ar` key entirely', () => {
    const result = createFaqEntrySchema.safeParse({ ...valid, question: { en: 'x' } });
    expect(result.success).toBe(false);
  });

  it('rejects a question over MAX_FAQ_QUESTION_LENGTH', () => {
    const result = createFaqEntrySchema.safeParse({
      ...valid,
      question: { en: 'x'.repeat(MAX_FAQ_QUESTION_LENGTH + 1), ar: 'ما هذا؟' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a question at exactly MAX_FAQ_QUESTION_LENGTH', () => {
    const result = createFaqEntrySchema.safeParse({
      ...valid,
      question: { en: 'x'.repeat(MAX_FAQ_QUESTION_LENGTH), ar: 'ما هذا؟' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an answer over MAX_FAQ_ANSWER_LENGTH', () => {
    const result = createFaqEntrySchema.safeParse({
      ...valid,
      answer: { en: 'x'.repeat(MAX_FAQ_ANSWER_LENGTH + 1), ar: 'جواب' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required `answer` field entirely', () => {
    const withoutAnswer = { question: valid.question } as Record<string, unknown>;
    expect(createFaqEntrySchema.safeParse(withoutAnswer).success).toBe(false);
  });
});

describe('updateFaqEntrySchema', () => {
  it('accepts a fully empty object — every field optional', () => {
    expect(updateFaqEntrySchema.safeParse({}).success).toBe(true);
  });

  it('accepts an `order`-only update', () => {
    expect(updateFaqEntrySchema.safeParse({ order: 3 }).success).toBe(true);
  });

  it('accepts a `visible`-only update', () => {
    expect(updateFaqEntrySchema.safeParse({ visible: false }).success).toBe(true);
  });

  it('rejects a non-integer `order`', () => {
    expect(updateFaqEntrySchema.safeParse({ order: 1.5 }).success).toBe(false);
  });

  it('rejects a non-boolean `visible`', () => {
    expect(updateFaqEntrySchema.safeParse({ visible: 'yes' }).success).toBe(false);
  });

  it('still enforces both-languages-required when `question` IS provided', () => {
    const result = updateFaqEntrySchema.safeParse({ question: { en: 'x', ar: '' } });
    expect(result.success).toBe(false);
  });

  it('silently rejects an unknown `status` field being treated as a real transition — status is not part of this schema at all', () => {
    // Zod objects strip unrecognized keys by default rather than erroring —
    // this documents that `status` passing through here has NO effect,
    // proving the service can never derive a status transition from it.
    const result = updateFaqEntrySchema.safeParse({ status: 'published' });
    expect(result.success).toBe(true);
    expect(result.success && 'status' in result.data).toBe(false);
  });
});

describe('createTestimonialEntrySchema', () => {
  const valid = {
    quote: { en: 'Great course!', ar: 'دورة رائعة!' },
    authorName: 'Jane Doe',
  };

  it('accepts a minimal valid entry (authorRole/avatar both omitted)', () => {
    expect(createTestimonialEntrySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a missing required `authorName`', () => {
    const withoutAuthorName = { quote: valid.quote } as Record<string, unknown>;
    expect(createTestimonialEntrySchema.safeParse(withoutAuthorName).success).toBe(false);
  });

  it('rejects an empty `authorName`', () => {
    expect(
      createTestimonialEntrySchema.safeParse({ ...valid, authorName: '' }).success,
    ).toBe(false);
  });

  it('rejects `authorName` over MAX_TESTIMONIAL_AUTHOR_NAME_LENGTH', () => {
    const result = createTestimonialEntrySchema.safeParse({
      ...valid,
      authorName: 'x'.repeat(MAX_TESTIMONIAL_AUTHOR_NAME_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects `quote` over MAX_TESTIMONIAL_QUOTE_LENGTH', () => {
    const result = createTestimonialEntrySchema.safeParse({
      ...valid,
      quote: { en: 'x'.repeat(MAX_TESTIMONIAL_QUOTE_LENGTH + 1), ar: 'دورة' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an authorRole with BOTH keys present, even if empty (optional-content shape)', () => {
    const result = createTestimonialEntrySchema.safeParse({
      ...valid,
      authorRole: { en: '', ar: '' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an authorRole missing the `ar` key when the field is present at all', () => {
    const result = createTestimonialEntrySchema.safeParse({
      ...valid,
      authorRole: { en: 'CEO' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an authorRole over MAX_TESTIMONIAL_AUTHOR_ROLE_LENGTH', () => {
    const result = createTestimonialEntrySchema.safeParse({
      ...valid,
      authorRole: { en: 'x'.repeat(MAX_TESTIMONIAL_AUTHOR_ROLE_LENGTH + 1), ar: 'رئيس' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a plain string `avatar`', () => {
    const result = createTestimonialEntrySchema.safeParse({
      ...valid,
      avatar: 'data:image/png;base64,aaaa',
    });
    expect(result.success).toBe(true);
  });
});

describe('updateTestimonialEntrySchema', () => {
  it('accepts a fully empty object', () => {
    expect(updateTestimonialEntrySchema.safeParse({}).success).toBe(true);
  });

  it('accepts an `avatar`-only update, including clearing it with an empty string', () => {
    expect(updateTestimonialEntrySchema.safeParse({ avatar: '' }).success).toBe(true);
  });

  it('still enforces the min-length rule on `authorName` when provided', () => {
    expect(updateTestimonialEntrySchema.safeParse({ authorName: '' }).success).toBe(
      false,
    );
  });
});
