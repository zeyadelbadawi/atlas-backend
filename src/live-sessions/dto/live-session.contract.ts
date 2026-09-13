/**
 * `LiveSession` response contract.
 *
 * WHAT IS DELIBERATELY ABSENT: `providerMeetingId` and any provider join
 * URL. A student's client has no use for either — they join through an
 * Atlas-minted grant and the embedded SDK — and shipping a meeting id to
 * every curriculum render would make the room joinable by anyone who
 * opened dev tools. The host's own tooling reads it server-side.
 */
import type { LiveSession, User } from '@prisma/client';

export interface LiveSessionResponse {
  readonly id: string;
  readonly courseId: string;
  readonly sectionId?: string;
  readonly title: string;
  readonly description?: string;
  readonly order: number;
  readonly status: LiveSession['status'];
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly host?: { readonly id: string; readonly name: string };
  readonly recordingEnabled: boolean;
  /** Present only once a recording exists — `undefined` means none was made. */
  readonly recording?: {
    readonly status: string;
    readonly availableAt?: string;
  };
  readonly startedAt?: string;
  readonly endedAt?: string;
}

type LiveSessionWithRelations = LiveSession & {
  hostUser?: Pick<User, 'id' | 'name'> | null;
  recording?: { status: string; availableAt: Date | null } | null;
};

export function toLiveSessionResponse(
  session: LiveSessionWithRelations,
): LiveSessionResponse {
  return {
    id: session.id,
    courseId: session.courseId,
    sectionId: session.sectionId ?? undefined,
    title: session.title,
    description: session.description ?? undefined,
    order: session.order,
    status: session.status,
    scheduledStartAt: session.scheduledStartAt.toISOString(),
    scheduledEndAt: session.scheduledEndAt.toISOString(),
    host: session.hostUser
      ? { id: session.hostUser.id, name: session.hostUser.name }
      : undefined,
    recordingEnabled: session.recordingEnabled,
    recording: session.recording
      ? {
          status: session.recording.status,
          availableAt: session.recording.availableAt?.toISOString(),
        }
      : undefined,
    startedAt: session.startedAt?.toISOString(),
    endedAt: session.endedAt?.toISOString(),
  };
}
