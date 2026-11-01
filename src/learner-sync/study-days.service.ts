/**
 * The days a learner studied, for the app's streak (Atlas mobile app).
 *
 * Derived from what the learner already does — completing a lesson,
 * submitting a quiz attempt, submitting an assignment — in the academy the
 * session serves. Nothing new is stored. Days are the learner's local
 * dates in the time zone the phone sends; the app joins them with the days
 * it marked itself and works out the streak.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { TenancyContextService } from '../tenancy/services/tenancy-context.service';
import type { StudyDaysResponse } from './dto/learner-sync.dto';

/** Far enough back for a long streak; a streak longer than this shows as this. */
export const STUDY_DAYS_LOOKBACK = 120;

export function validTimeZone(tz: string | undefined): string {
  const zone = tz?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    throw new BadRequestException({ messageKey: 'errors.validation' });
  }
}

@Injectable()
export class StudyDaysService {
  constructor(private readonly tenancy: TenancyContextService) {}

  async days(
    userId: string,
    academyId: string,
    tz: string | undefined,
    now: Date = new Date(),
  ): Promise<StudyDaysResponse> {
    const timeZone = validTimeZone(tz);
    const since = new Date(now.getTime() - (STUDY_DAYS_LOOKBACK + 1) * 86_400_000);
    const rows = await this.tenancy.runInUserContext(
      userId,
      (tx) =>
        tx.$queryRaw<{ day: string }[]>`
        SELECT DISTINCT to_char((x.t AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day
          FROM (
            SELECT lp.completed_at AS t
              FROM lesson_progress lp
              JOIN enrollments e ON e.id = lp.enrollment_id
             WHERE e.student_id = ${userId} AND e.academy_id = ${academyId}
               AND lp.completed_at >= ${since}
            UNION ALL
            SELECT qa.submitted_at
              FROM quiz_attempts qa
              JOIN quizzes q ON q.id = qa.quiz_id
              JOIN courses c ON c.id = q.course_id
             WHERE qa.student_id = ${userId} AND c.academy_id = ${academyId}
               AND qa.submitted_at >= ${since}
            UNION ALL
            SELECT s.submitted_at
              FROM assignment_submissions s
              JOIN assignments a ON a.id = s.assignment_id
              JOIN courses c ON c.id = a.course_id
             WHERE s.student_id = ${userId} AND c.academy_id = ${academyId}
               AND s.submitted_at >= ${since}
          ) x
         ORDER BY day DESC
         LIMIT ${STUDY_DAYS_LOOKBACK}`,
    );
    return { timeZone, days: rows.map((r) => r.day) };
  }
}
