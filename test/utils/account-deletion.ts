/**
 * Authentication audit (Decision 1) — self-deletion needs the code emailed
 * to the account's verified address. Tests go through the real flow: the
 * challenge is requested over HTTP and the code read from the outbox row the
 * mailer would have sent (admin connection, test setup only).
 */
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';

export async function deletionCodeFor(
  app: INestApplication,
  admin: PrismaClient,
  accessToken: string,
): Promise<{ challengeId: string; code: string }> {
  const me = await request(app.getHttpServer())
    .get('/users/me')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  // The code only goes to a verified address; fixtures created with the
  // emailed sign-in code off have not verified theirs yet.
  await admin.user.updateMany({
    where: { id: me.body.id as string, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });
  const issued = await request(app.getHttpServer())
    .post('/users/me/delete/request')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  const challengeId = issued.body.challengeId as string;
  const row = await admin.communicationOutbox.findFirstOrThrow({
    where: { key: 'auth.account.deletion_code', entityId: challengeId },
  });
  return { challengeId, code: (row.values as { code: string }).code };
}
