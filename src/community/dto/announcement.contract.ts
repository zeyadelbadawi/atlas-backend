/** `Announcement` response contract — matches `announcement.types.ts` field-for-field. `authorName` is always a real join to `users`, never denormalized onto the row itself (same "resolved via a join at query time, never duplicated" convention as `AcademyMember`'s own doc comment, P3). */
import type { Announcement as PrismaAnnouncement } from '@prisma/client';

export interface AnnouncementResponse {
  readonly id: string;
  readonly audience: PrismaAnnouncement['audience'];
  readonly academyId?: string;
  readonly courseId?: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly title: string;
  readonly body: string;
  readonly status: PrismaAnnouncement['status'];
  readonly scheduledAt?: string;
  readonly publishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAnnouncementResponse(
  announcement: PrismaAnnouncement,
  authorName: string,
): AnnouncementResponse {
  return {
    id: announcement.id,
    audience: announcement.audience,
    academyId: announcement.academyId ?? undefined,
    courseId: announcement.courseId ?? undefined,
    authorId: announcement.authorId,
    authorName,
    title: announcement.title,
    body: announcement.body,
    status: announcement.status,
    scheduledAt: announcement.scheduledAt?.toISOString(),
    publishedAt: announcement.publishedAt?.toISOString(),
    createdAt: announcement.createdAt.toISOString(),
    updatedAt: announcement.updatedAt.toISOString(),
  };
}
