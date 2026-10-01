-- P4 — full-screen exams. The browser reports when it cannot go full
-- screen (no Fullscreen API, or the request was refused), so the reviewer
-- sees "unavailable" instead of an unexplained absence. Context only:
-- never counted as a violation (`VIOLATION_TYPES`). Additive; existing
-- rows and values are untouched.
ALTER TYPE "quiz_attempt_event_type" ADD VALUE IF NOT EXISTS 'fullscreen_unavailable' AFTER 'fullscreen_enter';
