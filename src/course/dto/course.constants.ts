/**
 * Course validation constants — matches `atlas frontend/src/features/
 * course/constants/course.constants.ts` exactly (max lengths, slug regex).
 */
export const COURSE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_COURSE_TITLE_LENGTH = 150;
export const MAX_COURSE_SLUG_LENGTH = 100;
export const MAX_COURSE_SHORT_DESCRIPTION_LENGTH = 200;
export const MAX_COURSE_DESCRIPTION_LENGTH = 5000;

export const MAX_SECTION_TITLE_LENGTH = 150;
export const MAX_SECTION_DESCRIPTION_LENGTH = 500;

export const MAX_LESSON_TITLE_LENGTH = 150;
export const MAX_LESSON_DESCRIPTION_LENGTH = 2000;

export const COURSE_STATUS_VALUES = ['draft', 'published', 'archived'] as const;
export const COURSE_VISIBILITY_VALUES = ['public', 'private'] as const;
export const COURSE_PRICING_TYPE_VALUES = ['free', 'paid'] as const;
export const COURSE_LESSON_CONTENT_TYPE_VALUES = ['text', 'video', 'file'] as const;
export const COURSE_LESSON_STATUS_VALUES = ['draft', 'published'] as const;
