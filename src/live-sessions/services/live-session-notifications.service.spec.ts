/**
 * Live Session notification fan-out — who is told, and how duplicates are
 * suppressed WITHOUT suppressing genuine news.
 *
 * Deduplication is the delicate part. Too loose and a retried job notifies
 * a class of 200 twice; too tight and the second reschedule — the one that
 * actually matters — is silently swallowed and everybody turns up on the
 * wrong day.
 */
import { Test } from '@nestjs/testing';
import { LiveSessionNotificationsService } from './live-session-notifications.service';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';

describe('LiveSessionNotificationsService.notifyEnrolledStudents', () => {
  let service: LiveSessionNotificationsService;
  let notify: jest.Mock;
  let enrollmentFindMany: jest.Mock;

  const MONDAY = new Date('2026-10-05T10:00:00Z');
  const FRIDAY = new Date('2026-10-09T10:00:00Z');

  beforeEach(async () => {
    notify = jest.fn().mockResolvedValue(true);
    enrollmentFindMany = jest
      .fn()
      .mockResolvedValue([{ studentId: 'student-1' }, { studentId: 'student-2' }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSessionNotificationsService,
        { provide: PrismaService, useValue: {} },
        { provide: TenancyContextService, useValue: {} },
        { provide: NotificationFanoutService, useValue: { notify } },
      ],
    }).compile();

    service = moduleRef.get(LiveSessionNotificationsService);
  });

  const tx = () => ({ enrollment: { findMany: enrollmentFindMany } }) as never;

  const send = (
    event: 'scheduled' | 'rescheduled' | 'cancelled' | 'starting_soon',
    at: Date,
  ) =>
    service.notifyEnrolledStudents(tx(), {
      liveSessionId: 'session-1',
      courseId: 'course-1',
      academyId: 'academy-1',
      title: 'Algebra II',
      scheduledStartAt: at,
      event,
    });

  const keysFor = (event: string) =>
    notify.mock.calls
      .map((call) => call[1].dedupeKey as string)
      .filter((key) => key.includes(`:${event}`));

  it('notifies every enrolled student', async () => {
    await send('scheduled', MONDAY);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  /*
   * ONLY REAL RELATIONSHIPS. `available`/`pending` describe a catalog
   * offer, not a student who is in the class.
   */
  it('only notifies students with an active enrollment', async () => {
    await send('scheduled', MONDAY);
    expect(enrollmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['enrolled', 'completed'] },
        }),
      }),
    );
  });

  /* A retried job announcing the SAME time must still collapse to one. */
  it('produces an identical key when the same announcement is retried', async () => {
    await send('rescheduled', FRIDAY);
    const first = keysFor('rescheduled');
    notify.mockClear();
    await send('rescheduled', FRIDAY);
    expect(keysFor('rescheduled')).toEqual(first);
  });

  /*
   * THE REGRESSION THIS FIXES. An instructor moves a class to Monday, then
   * again to Friday. Keyed on the session alone, the Friday announcement
   * is discarded as a duplicate and every student is left holding the
   * Monday time — the reschedule nobody hears about is exactly the one
   * that matters.
   */
  it('produces a DIFFERENT key for a second reschedule to a new time', async () => {
    await send('rescheduled', MONDAY);
    const monday = keysFor('rescheduled');
    notify.mockClear();
    await send('rescheduled', FRIDAY);
    expect(keysFor('rescheduled')).not.toEqual(monday);
  });

  /* Same reasoning: the reminder belongs to the occurrence, not the row. */
  it('produces a different starting-soon key after a reschedule', async () => {
    await send('starting_soon', MONDAY);
    const monday = keysFor('starting_soon');
    notify.mockClear();
    await send('starting_soon', FRIDAY);
    expect(keysFor('starting_soon')).not.toEqual(monday);
  });

  /*
   * `scheduled` and `cancelled` happen ONCE in a session's life, so they
   * stay keyed on the session alone — including the time would let a
   * repeated announcement through.
   */
  it.each(['scheduled', 'cancelled'] as const)(
    'keeps the %s key stable regardless of the time',
    async (event) => {
      await send(event, MONDAY);
      const monday = keysFor(event);
      notify.mockClear();
      await send(event, FRIDAY);
      expect(keysFor(event)).toEqual(monday);
    },
  );

  it('keys separately per student, so one student cannot swallow another notification', async () => {
    await send('scheduled', MONDAY);
    const keys = notify.mock.calls.map((call) => call[1].dedupeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('marks a cancellation high priority and a reminder medium', async () => {
    await send('cancelled', MONDAY);
    expect(notify.mock.calls[0][1].priority).toBe('high');
    notify.mockClear();
    await send('starting_soon', MONDAY);
    expect(notify.mock.calls[0][1].priority).toBe('medium');
  });

  /*
   * TRANSLATION KEYS, NOT SENTENCES. The reader's own client resolves
   * these, which is what keeps a notification correct in the language the
   * READER chose rather than the language of whoever triggered it.
   */
  it('sends translation keys and raw values, never rendered text', async () => {
    await send('rescheduled', FRIDAY);
    const payload = notify.mock.calls[0][1];
    expect(payload.titleKey).toBe('notifications:liveSession.rescheduled.title');
    expect(payload.messageKey).toBe('notifications:liveSession.rescheduled.message');
    expect(payload.values.startsAt).toBe(FRIDAY.toISOString());
  });
});
