import type {
  PrivacyRequest,
  PrivacyRequestStatus,
  PrivacyRequestType,
} from '@prisma/client';

/** What the requester sees about their own request. */
export interface MyPrivacyRequestResponse {
  readonly id: string;
  readonly type: PrivacyRequestType;
  readonly status: PrivacyRequestStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
  /** The reason given when the request was declined. */
  readonly resolutionNote: string | null;
  readonly exportAvailableUntil: string | null;
  /** `true` while a fulfilled export can still be downloaded. */
  readonly canDownload: boolean;
}

/** A row in the Platform Owner queue. */
export interface PlatformPrivacyRequestResponse {
  readonly id: string;
  readonly type: PrivacyRequestType;
  readonly status: PrivacyRequestStatus;
  readonly userId: string | null;
  readonly requesterName: string;
  readonly requesterEmail: string;
  readonly academyId: string | null;
  readonly academyName: string | null;
  readonly resolutionNote: string | null;
  readonly handledByUserId: string | null;
  readonly exportAvailableUntil: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function canDownloadExport(row: PrivacyRequest, now: Date = new Date()): boolean {
  return (
    row.type === 'export' &&
    row.status === 'completed' &&
    row.exportAvailableUntil !== null &&
    row.exportAvailableUntil.getTime() > now.getTime()
  );
}

export function toMyPrivacyRequestResponse(
  row: PrivacyRequest,
  now: Date = new Date(),
): MyPrivacyRequestResponse {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    resolutionNote: row.status === 'rejected' ? row.resolutionNote : null,
    exportAvailableUntil: row.exportAvailableUntil?.toISOString() ?? null,
    canDownload: canDownloadExport(row, now),
  };
}

export function toPlatformPrivacyRequestResponse(
  row: PrivacyRequest,
  academyName: string | null,
): PlatformPrivacyRequestResponse {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    userId: row.userId,
    requesterName: row.requesterName,
    requesterEmail: row.requesterEmail,
    academyId: row.academyId,
    academyName,
    resolutionNote: row.resolutionNote,
    handledByUserId: row.handledByUserId,
    exportAvailableUntil: row.exportAvailableUntil?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
