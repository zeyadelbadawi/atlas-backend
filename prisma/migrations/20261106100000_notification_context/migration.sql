-- Notification context isolation.
--
-- ROOT CAUSE: `notifications` had no notion of WHERE a notification
-- belongs. One Atlas identity can be a Management user and a learner at
-- several academies at once, and every feed read was `WHERE user_id = me`,
-- so the Management dashboard and every academy's learner area showed the
-- same mixed list (and one unread count, and "mark all read" across all
-- of them). The writer already knew the context — the catalogue entry's
-- audience and the event's academy — and dropped it.
--
-- This migration adds the context and the academy, and backfills existing
-- rows ONLY where the context is certain. Nothing is deleted:
--   1. account    — the global credential's own security notices
--                    (password, sign-in methods, 2FA, account joined):
--                    shown in every context, because the credential is.
--   2. management — every staff- and platform-audience event type. The
--                    title key maps 1:1 to a catalogue key (generated from
--                    the catalogue; no title key maps to two audiences).
--   3. academy    — learner-audience rows whose academy is recorded:
--                    a) by the communication outbox row the same event
--                       wrote (same recipient + dedupe key), or
--                    b) by the campaign they came from.
--   4. unscoped   — anything else (e.g. learner rows older than the
--                    outbox's 90-day retention). The academy is NOT guessed
--                    from memberships (a person can leave an academy); such
--                    rows are shown on no surface and age out under the
--                    existing 180/365-day feed retention.
-- Idempotent: every UPDATE only touches rows still `unscoped`.

-- CreateEnum
CREATE TYPE "notification_context" AS ENUM ('management', 'academy', 'account', 'unscoped');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "academy_id" TEXT,
ADD COLUMN     "context" "notification_context" NOT NULL DEFAULT 'unscoped';

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1. Account-wide security notices.
UPDATE "notifications" SET "context" = 'account'
 WHERE "context" = 'unscoped' AND "title_key" IN (
  'notifications:events.academyJoined.title',
  'notifications:events.googleLinked.title',
  'notifications:events.googleUnlinked.title',
  'notifications:events.passwordChanged.title',
  'notifications:events.passwordResetConfirmed.title',
  'notifications:events.twoFactorDisabled.title',
  'notifications:events.twoFactorEnabled.title'
 );

-- 2. Management (staff- and platform-audience event types).
UPDATE "notifications" SET "context" = 'management'
 WHERE "context" = 'unscoped' AND "title_key" IN (
  'notifications:events.academyMemberAdded.title',
  'notifications:events.academyPaymentSubmitted.title',
  'notifications:events.lifecycleSubscriptionActivated.title',
  'notifications:events.lifecycleSubscriptionCancelScheduled.title',
  'notifications:events.lifecycleSubscriptionCancelled.title',
  'notifications:events.lifecycleSubscriptionExpired.title',
  'notifications:events.lifecycleSubscriptionGraceEnding.title',
  'notifications:events.lifecycleSubscriptionGraceStarted.title',
  'notifications:events.lifecycleSubscriptionPaymentSubmitted.title',
  'notifications:events.lifecycleSubscriptionRenewalDue.title',
  'notifications:events.lifecycleSubscriptionRenewalTomorrow.title',
  'notifications:events.lifecycleTrialEndingSoon.title',
  'notifications:events.lifecycleTrialExpired.title',
  'notifications:events.lifecycleTrialStarted.title',
  'notifications:events.platformBroadcastSent.title',
  'notifications:events.platformContactSubmissionReceived.title',
  'notifications:events.platformPaymentApproved.title',
  'notifications:events.platformPaymentRejected.title',
  'notifications:events.provisioningCompleted.title',
  'notifications:events.provisioningFailed.title',
  'notifications:events.retentionVideoDeleted.title',
  'notifications:events.retentionVideoDeletionFailed.title',
  'notifications:events.retentionVideoWarning14d.title',
  'notifications:events.retentionVideoWarning24h.title',
  'notifications:events.retentionVideoWarning30d.title',
  'notifications:events.retentionVideoWarning7d.title',
  'notifications:events.reviewSubmitted.title',
  'notifications:events.rosterStudentAwaitingApproval.title',
  'notifications:events.supportCaseReply.title',
  'notifications:events.supportCaseStatusChanged.title',
  'notifications:liveProvider.deauthorized.title',
  'notifications:liveSession.recordingAvailable.title'
 );

-- 3a. Learner rows: the academy the same event recorded on its outbox row.
UPDATE "notifications" n
   SET "context" = 'academy', "academy_id" = o."academy_id"
  FROM "communication_outbox" o
 WHERE n."context" = 'unscoped'
   AND n."dedupe_key" IS NOT NULL
   AND o."recipient_user_id" = n."user_id"
   AND o."dedupe_key" = n."dedupe_key"
   AND o."academy_id" IS NOT NULL
   AND n."title_key" IN (
  'notifications:events.academyLearnerAdded.title',
  'notifications:events.academyMessageSent.title',
  'notifications:events.announcementPublished.title',
  'notifications:events.assignmentGraded.title',
  'notifications:events.attemptInvalidated.title',
  'notifications:events.certificateIssued.title',
  'notifications:events.certificateRevoked.title',
  'notifications:events.courseCompleted.title',
  'notifications:events.courseOrderCreated.title',
  'notifications:events.courseOrderExpired.title',
  'notifications:events.courseOrderPaid.title',
  'notifications:events.courseOrderPaymentFailed.title',
  'notifications:events.courseOrderProofSubmitted.title',
  'notifications:events.courseOrderRefunded.title',
  'notifications:events.coursePaymentApproved.title',
  'notifications:events.coursePaymentRejected.title',
  'notifications:events.deviceLimitReached.title',
  'notifications:events.deviceRegistered.title',
  'notifications:events.deviceRemoved.title',
  'notifications:events.enrollmentExpiryChanged.title',
  'notifications:events.enrollmentGranted.title',
  'notifications:events.enrollmentRevoked.title',
  'notifications:events.enrollmentSelfEnrolled.title',
  'notifications:events.exceptionActivated.title',
  'notifications:events.exceptionGranted.title',
  'notifications:events.exceptionRevoked.title',
  'notifications:events.exceptionScheduled.title',
  'notifications:events.quizAutoSubmitted.title',
  'notifications:events.quizGraded.title',
  'notifications:events.reviewModerated.title',
  'notifications:events.rosterStudentApproved.title',
  'notifications:events.rosterStudentBlocked.title',
  'notifications:events.rosterStudentRejected.title',
  'notifications:events.rosterStudentUnblocked.title',
  'notifications:events.sessionTakenOver.title',
  'notifications:liveSession.cancelled.title',
  'notifications:liveSession.rescheduled.title',
  'notifications:liveSession.scheduled.title',
  'notifications:liveSession.starting_soon.title'
 );

-- 3b. Campaign rows: a platform broadcast or an academy campaign to its
-- staff is Management; an academy campaign to learners belongs to it.
UPDATE "notifications" n
   SET "context" = CASE
         WHEN c."scope" = 'academy' AND COALESCE(c."audience"->>'type', '') <> 'staff'
           THEN 'academy'::"notification_context"
         ELSE 'management'::"notification_context"
       END,
       "academy_id" = CASE
         WHEN c."scope" = 'academy' AND COALESCE(c."audience"->>'type', '') <> 'staff'
           THEN c."academy_id"
         ELSE NULL
       END
  FROM "communication_campaigns" c
 WHERE n."context" = 'unscoped'
   AND n."metadata"->>'campaignId' = c."id"
   AND (c."scope" <> 'academy' OR c."academy_id" IS NOT NULL);

-- An academy notification always names its academy; no other context does.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_context_academy_check"
  CHECK (("context" = 'academy') = ("academy_id" IS NOT NULL));

-- CreateIndex — the scoped feed, unread count and mark-all reads.
CREATE INDEX "notifications_user_id_context_academy_id_is_read_created_at_idx" ON "notifications"("user_id", "context", "academy_id", "is_read", "created_at" DESC);
