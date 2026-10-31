/** The due-date push sweep (mobile opt-in). Same shape as `live-session-sweep.types`. */
export const DUE_REMINDER_SWEEP_QUEUE = 'due-reminder-sweep';
export const DUE_REMINDER_SWEEP_JOB = 'run';
/** Fixed repeat-job id, so every boot and instance registers the same one. */
export const DUE_REMINDER_SWEEP_REPEAT_JOB_ID = 'due-reminder-sweep-recurring';

/** Fifteen minutes: the reminder is about "tomorrow", not "now". */
export const DUE_REMINDER_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** A reminder goes out once the due date is less than this far away. */
export const DUE_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Learner-item pairs handled per tick; the rest wait for the next one. */
export const DUE_REMINDER_MAX_PER_TICK = 500;

export type DueReminderSweepJobPayload = Record<string, never>;

export type DueItemKind = 'quiz' | 'assignment';
