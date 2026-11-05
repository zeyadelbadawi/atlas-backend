-- ============================================================================
-- Quiz integrity events from the mobile app: screenshots and screen capture.
--
-- The Atlas mobile app blocks screenshots and recording during a quiz on
-- Android (FLAG_SECURE). iOS cannot block them, only report them:
--   screenshot            the learner took a screenshot (reported after it).
--   screen_capture_start  the screen started being recorded, mirrored or
--                         cast; the app hides the questions meanwhile.
--   screen_capture_stop   it stopped.
-- `screenshot` and `screen_capture_start` count towards the attempt's
-- violation budget like leaving the app does; `screen_capture_stop` is
-- context. Additive: no existing row, policy or function changes.
--
-- ADD VALUE alone in its own migration (this repository's rule: PostgreSQL
-- cannot use a new enum value in the transaction that adds it).
--
-- Recovery: an enum value cannot be dropped in place. Before any row uses
-- them, recreate the type without them (rename, CREATE TYPE with the old
-- values, ALTER quiz_attempt_events.type ... USING type::text::..., drop old).
-- ============================================================================

ALTER TYPE "quiz_attempt_event_type" ADD VALUE 'screenshot';
ALTER TYPE "quiz_attempt_event_type" ADD VALUE 'screen_capture_start';
ALTER TYPE "quiz_attempt_event_type" ADD VALUE 'screen_capture_stop';
