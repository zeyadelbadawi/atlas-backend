/**
 * Extracts the few fields Atlas needs from a Zoom webhook body.
 *
 * WHY AN EXTRACTOR RATHER THAN PASSING THE PAYLOAD AROUND. A Zoom body
 * carries participant emails, display names and join URLs. Anything that
 * travels onward gets persisted in a Redis job payload and printed in a
 * failure log, so only the non-sensitive identifiers leave this function.
 *
 * TOTAL AND DEFENSIVE. Every field is optional in practice — Zoom varies
 * its shape by event type and has added fields over time — so this returns
 * `null` rather than throwing on anything unexpected. A malformed body is
 * an ignorable event, not a 500.
 *
 * `participantKey` is read from `customer_key`, which is the value Atlas
 * itself supplied when the join signature was minted. It is the ONLY
 * identity bridge: no name, email or display-name matching happens
 * anywhere in this feature.
 */

export interface ExtractedZoomEvent {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerMeetingId?: string;
  readonly participantKey?: string;
  readonly providerParticipantId?: string;
  readonly joinedAt?: string;
  readonly leftAt?: string;
  readonly occurredAt: string;
  /** Only present on the `endpoint.url_validation` handshake. */
  readonly plainToken?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractZoomEvent(body: unknown): ExtractedZoomEvent | null {
  const root = asRecord(body);
  if (!root) return null;

  const eventType = asString(root.event);
  if (!eventType) return null;

  const payload = asRecord(root.payload);
  const object = asRecord(payload?.object);
  const participant = asRecord(object?.participant);

  // `event_ts` is Zoom's own per-delivery timestamp. Combined with the
  // meeting and participant identifiers it is stable across redeliveries
  // of the SAME event, which is exactly what the unique constraint needs.
  const eventTs = root.event_ts;
  const occurredAtMs =
    typeof eventTs === 'number' ? eventTs : Number(asString(eventTs) ?? NaN);

  const providerMeetingId = asString(object?.id) ?? asString(object?.uuid) ?? undefined;

  /*
    A STABLE EVENT IDENTITY. Zoom does not send a dedicated event id, so
    one is derived from the parts that identify this delivery. Including
    the participant and its join/leave time matters: without them, two
    different students joining in the same second would collapse into one
    "already seen" event and the second student's attendance would vanish.
  */
  const participantKey = asString(participant?.customer_key);
  const joinTime = asString(participant?.join_time);
  const leaveTime = asString(participant?.leave_time);

  const providerEventId = [
    eventType,
    providerMeetingId ?? 'no-meeting',
    participantKey ?? asString(participant?.user_id) ?? 'no-participant',
    joinTime ?? leaveTime ?? String(occurredAtMs || 0),
  ].join('|');

  return {
    providerEventId,
    eventType,
    providerMeetingId,
    participantKey,
    providerParticipantId:
      asString(participant?.id) ?? asString(participant?.user_id) ?? undefined,
    joinedAt: joinTime,
    leftAt: leaveTime,
    occurredAt: Number.isFinite(occurredAtMs)
      ? new Date(occurredAtMs).toISOString()
      : new Date().toISOString(),
    plainToken: asString(payload?.plainToken),
  };
}
