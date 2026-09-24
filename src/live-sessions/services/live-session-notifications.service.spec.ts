/**
 * Live Session notification fan-out — who is told, and how duplicates are
 * suppressed WITHOUT suppressing genuine news.
 *
 * Deduplication is the delicate part. Too loose and a retried job notifies
 * a class of 200 twice; too tight and the second reschedule — the one that
 * actually matters — is silently swallowed and everybody turns up on the
 * wrong day.
 *
 * WHERE THE RULES LIVE NOW. The service used to pass `dedupeKey`,
 * `priority` and the translation keys itself; the communications
 * catalogue owns all three since every event became a catalogue entry.
 * The behaviour is unchanged, so this spec still proves it — it just
 * proves each half where it now lives: the service is checked on WHO it
 * emits for and WHAT it passes, and the catalogue on the keys and
 * priority it derives from that payload.
 */
import { Test } from '@nestjs/testing';
import { LiveSessionNotificationsService } from './live-session-notifications.service';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CommunicationService } from '../../communications/services/communication.service';
import {
  COMMUNICATION_CATALOG,
  type CommunicationEventKey,
} from '../../communications/catalog/communication-catalog';

describe('LiveSessionNotificationsService.notifyEnrolledStudents', () => {
  let service: LiveSessionNotificationsService;
  let emit: jest.Mock;
  let enrollmentFindMany: jest.Mock;

  const MONDAY = new Date('2026-10-05T10:00:00Z');
  const FRIDAY = new Date('2026-10-09T10:00:00Z');

  beforeEach(async () => {
    emit = jest.fn().mockResolvedValue({ created: true, outboxId: 'outbox-1' });
    enrollmentFindMany = jest
      .fn()
      .mockResolvedValue([{ studentId: 'student-1' }, { studentId: 'student-2' }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSessionNotificationsService,
        { provide: PrismaService, useValue: {} },
        { provide: TenancyContextService, useValue: {} },
        { provide: CommunicationService, useValue: { emit } },
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

  /** The dedupe keys the catalogue derives from what the service actually emitted. */
  const keysFor = (event: string): string[] =>
    emit.mock.calls
      .map(([, input]) => input as { key: CommunicationEventKey })
      .filter((input) => input.key === `live_session.${event}`)
      .map((input) => {
        const dedupe = COMMUNICATION_CATALOG[input.key].dedupe;
        return String(dedupe?.(input as never) ?? '');
      });

  it('notifies every enrolled student', async () => {
    await send('scheduled', MONDAY);
    expect(emit).toHaveBeenCalledTimes(2);
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
    emit.mockClear();
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
    emit.mockClear();
    await send('rescheduled', FRIDAY);
    expect(keysFor('rescheduled')).not.toEqual(monday);
  });

  /* Same reasoning: the reminder belongs to the occurrence, not the row. */
  it('produces a different starting-soon key after a reschedule', async () => {
    await send('starting_soon', MONDAY);
    const monday = keysFor('starting_soon');
    emit.mockClear();
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
      emit.mockClear();
      await send(event, FRIDAY);
      expect(keysFor(event)).toEqual(monday);
    },
  );

  it('keys separately per student, so one student cannot swallow another notification', async () => {
    await send('scheduled', MONDAY);
    expect(new Set(keysFor('scheduled')).size).toBe(2);
  });

  it('marks a cancellation high priority and a reminder medium', () => {
    expect(COMMUNICATION_CATALOG['live_session.cancelled'].priority).toBe('high');
    expect(COMMUNICATION_CATALOG['live_session.starting_soon'].priority).toBe('medium');
  });

  /*
   * TRANSLATION KEYS, NOT SENTENCES. The reader's own client resolves
   * these, which is what keeps a notification correct in the language the
   * READER chose rather than the language of whoever triggered it.
   */
  it('sends translation keys and raw values, never rendered text', async () => {
    await send('rescheduled', FRIDAY);
    const [, input] = emit.mock.calls[0];
    const entry = COMMUNICATION_CATALOG['live_session.rescheduled'];
    expect(entry.titleKey).toBe('notifications:liveSession.rescheduled.title');
    expect(entry.messageKey).toBe('notifications:liveSession.rescheduled.message');
    expect((input as { values: { startsAt: string } }).values.startsAt).toBe(
      FRIDAY.toISOString(),
    );
  });

  /* Email is deliberately not a channel for these — the feed is enough. */
  it('keeps live-session announcements in-app only', () => {
    for (const event of ['scheduled', 'rescheduled', 'cancelled', 'starting_soon'] as const) {
      expect(COMMUNICATION_CATALOG[`live_session.${event}`].channels).toEqual({
        inApp: 'always',
        email: 'never',
      });
    }
  });
});
