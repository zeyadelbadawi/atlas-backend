import {
  courseCompletionRecomputeJobId,
  countsTowardCompletion,
  isCompletionRelevantItemChange,
  type CompletionRelevantItem,
} from './course-completion-recompute.types';

describe('courseCompletionRecomputeJobId', () => {
  it('is one stable id per course (and per follow-up), never containing a colon', () => {
    const courseId = 'a7b17e99-0783-447f-b13f-cedc3f79baa0';
    expect(courseCompletionRecomputeJobId(courseId)).toBe(
      `course-completion-recompute-${courseId}`,
    );
    expect(courseCompletionRecomputeJobId(courseId, 'followup')).toBe(
      `course-completion-recompute-${courseId}-followup`,
    );
    // BullMQ throws "Custom Id cannot contain :" (see `quizDeadlineJobId`).
    expect(courseCompletionRecomputeJobId(courseId)).not.toContain(':');
    expect(courseCompletionRecomputeJobId(courseId, 'followup')).not.toContain(':');
  });
});

describe('isCompletionRelevantItemChange', () => {
  const counted: CompletionRelevantItem = {
    status: 'published',
    sectionId: 'unit-1',
    requiredForCompletion: true,
  };

  it('counts exactly the published items placed in a unit (as evaluate() does)', () => {
    expect(countsTowardCompletion(counted)).toBe(true);
    expect(countsTowardCompletion({ ...counted, status: 'draft' })).toBe(false);
    expect(countsTowardCompletion({ ...counted, sectionId: null })).toBe(false);
  });

  it.each<[string, CompletionRelevantItem | null, CompletionRelevantItem | null]>([
    ['detached from its unit', counted, { ...counted, sectionId: null }],
    ['placed in a unit', { ...counted, sectionId: null }, counted],
    ['unpublished', counted, { ...counted, status: 'draft' }],
    ['published', { ...counted, status: 'draft' }, counted],
    ['made optional', counted, { ...counted, requiredForCompletion: false }],
    ['made required', { ...counted, requiredForCompletion: false }, counted],
    ['deleted (counted)', counted, null],
    ['created (counted)', null, counted],
    // An optional counted item still matters: in a course with no lessons
    // and nothing marked required, every counted item is required.
    ['deleted (counted, optional)', { ...counted, requiredForCompletion: false }, null],
  ])('is relevant when a counted item is %s', (_label, before, after) => {
    expect(isCompletionRelevantItemChange(before, after)).toBe(true);
  });

  it.each<[string, CompletionRelevantItem | null, CompletionRelevantItem | null]>([
    ['moved to another unit', counted, { ...counted, sectionId: 'unit-2' }],
    ['left unchanged (title edit)', counted, { ...counted }],
    [
      'a draft made required',
      { ...counted, status: 'draft', requiredForCompletion: false },
      { ...counted, status: 'draft' },
    ],
    [
      'an unplaced item made optional',
      { ...counted, sectionId: null },
      { ...counted, sectionId: null, requiredForCompletion: false },
    ],
    ['a draft deleted', { ...counted, status: 'draft' }, null],
    ['an unplaced item created', null, { ...counted, sectionId: null }],
  ])('is not relevant when %s', (_label, before, after) => {
    expect(isCompletionRelevantItemChange(before, after)).toBe(false);
  });
});
