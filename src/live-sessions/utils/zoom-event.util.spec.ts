/**
 * Zoom event extraction.
 *
 * Two things matter here and both are security-relevant:
 *
 *   1. The derived event id must be STABLE across redeliveries of the same
 *      event (so the unique constraint dedupes it) but DISTINCT between
 *      genuinely different events (so one student's attendance cannot
 *      swallow another's).
 *   2. Nothing sensitive may escape. A Zoom body carries emails, display
 *      names and join URLs; the extract is what travels onward into a
 *      Redis job payload and a failure log.
 */
import { extractZoomEvent } from './zoom-event.util';

const participantJoined = (over: Record<string, unknown> = {}) => ({
  event: 'meeting.participant_joined',
  event_ts: 1789000000000,
  payload: {
    object: {
      id: '87654321',
      participant: {
        id: 'zoom-participant-1',
        user_id: 'zoom-user-1',
        user_name: 'Ahmed Hassan',
        email: 'ahmed@example.com',
        customer_key: 'atlas_abc123',
        join_time: '2026-06-01T10:01:00Z',
        ...over,
      },
    },
  },
});

describe('extractZoomEvent', () => {
  it('extracts the identifiers Atlas needs', () => {
    const result = extractZoomEvent(participantJoined());
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('meeting.participant_joined');
    expect(result!.providerMeetingId).toBe('87654321');
    expect(result!.participantKey).toBe('atlas_abc123');
    expect(result!.joinedAt).toBe('2026-06-01T10:01:00Z');
  });

  /*
   * NOTHING SENSITIVE TRAVELS. The extract is persisted in a queue payload
   * and printed on failure, so an email or display name leaking here would
   * end up in Redis and in logs.
   */
  it('carries NO email and NO display name', () => {
    const result = extractZoomEvent(participantJoined());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ahmed@example.com');
    expect(serialized).not.toContain('Ahmed Hassan');
  });

  it('produces a STABLE id for a redelivery of the same event', () => {
    const a = extractZoomEvent(participantJoined());
    const b = extractZoomEvent(participantJoined());
    expect(a!.providerEventId).toBe(b!.providerEventId);
  });

  /*
   * THE ONE THAT PROTECTS ATTENDANCE. Two students joining in the same
   * second must not collapse into one "already seen" event — the second
   * student's attendance would silently disappear.
   */
  it('produces DISTINCT ids for two different participants', () => {
    const first = extractZoomEvent(participantJoined({ customer_key: 'atlas_aaa' }));
    const second = extractZoomEvent(participantJoined({ customer_key: 'atlas_bbb' }));
    expect(first!.providerEventId).not.toBe(second!.providerEventId);
  });

  it('produces distinct ids for a join and a later rejoin', () => {
    const join1 = extractZoomEvent(
      participantJoined({ join_time: '2026-06-01T10:01:00Z' }),
    );
    const join2 = extractZoomEvent(
      participantJoined({ join_time: '2026-06-01T10:07:00Z' }),
    );
    expect(join1!.providerEventId).not.toBe(join2!.providerEventId);
  });

  it('distinguishes a join from a leave for the same participant', () => {
    const joined = extractZoomEvent(participantJoined());
    const left = extractZoomEvent({
      event: 'meeting.participant_left',
      event_ts: 1789000000000,
      payload: {
        object: {
          id: '87654321',
          participant: {
            customer_key: 'atlas_abc123',
            leave_time: '2026-06-01T10:20:00Z',
          },
        },
      },
    });
    expect(joined!.providerEventId).not.toBe(left!.providerEventId);
  });

  it('reads the url-validation handshake token', () => {
    const result = extractZoomEvent({
      event: 'endpoint.url_validation',
      event_ts: 1789000000000,
      payload: { plainToken: 'tok-123' },
    });
    expect(result!.eventType).toBe('endpoint.url_validation');
    expect(result!.plainToken).toBe('tok-123');
  });

  /* A malformed body is an ignorable event, never a 500. */
  it.each([
    ['null', null],
    ['a string', 'not-an-object'],
    ['an empty object', {}],
    ['a body with no event type', { payload: {} }],
    ['an array', []],
  ])('returns null for %s', (_label, body) => {
    expect(extractZoomEvent(body)).toBeNull();
  });

  it('tolerates a missing participant without throwing', () => {
    const result = extractZoomEvent({
      event: 'meeting.started',
      event_ts: 1789000000000,
      payload: { object: { id: '999' } },
    });
    expect(result!.providerMeetingId).toBe('999');
    expect(result!.participantKey).toBeUndefined();
  });
});
