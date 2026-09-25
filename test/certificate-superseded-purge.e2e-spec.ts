/**
 * Superseded certificate PDFs are deleted (cloud remediation, deletion
 * workstream). PDF keys are versioned; a re-issue or regeneration bumps the
 * version and used to leave every earlier PDF — with the holder's real
 * name — in the protected bucket forever, including after the holder
 * deleted their account (anonymisation re-renders only the current one).
 *
 * Pinned against real Postgres and the S3-compatible test store:
 *   - every version BEFORE the current one is deleted and verified absent;
 *   - the current version is never touched;
 *   - another certificate's PDFs are never touched;
 *   - a replay is harmless (already-absent counts as success).
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedCourse,
  seedEnrollment,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import {
  CertificatesService,
  certificatePdfKey,
} from '../src/certificates/services/certificates.service';
import { ProtectedMediaStorage } from '../src/media/storage/protected-media-storage.provider';
import type { PrismaClient } from '@prisma/client';

describe('Superseded certificate PDF purge (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let certificates: CertificatesService;
  let storage: ProtectedMediaStorage;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    admin = createAdminPrisma();
    certificates = app.get(CertificatesService);
    storage = app.get(ProtectedMediaStorage);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function seedCertificate(label: string, version: number) {
    const owner = await admin.user.create({
      data: {
        email: `${label}-o-${randomUUID()}@example.test`,
        name: label,
        passwordHash: 'x',
      },
    });
    const student = await admin.user.create({
      data: {
        email: `${label}-s-${randomUUID()}@example.test`,
        name: 'Real Name',
        passwordHash: 'x',
      },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course`, {
      status: 'published',
    });
    await seedAcademyStudent(admin, academy.id, student.id);
    const enrollment = await seedEnrollment(admin, student.id, course.id, academy.id, {
      status: 'completed',
    });
    const certificate = await admin.certificate.create({
      data: {
        academyId: academy.id,
        courseId: course.id,
        enrollmentId: enrollment.id,
        studentId: student.id,
        serial: `ATL-${randomUUID().slice(0, 8)}`,
        verificationCode: randomUUID().replace(/-/g, '').slice(0, 16),
        snapshot: { learnerName: 'Real Name' },
        version,
      },
    });
    for (let v = 1; v <= version; v += 1) {
      await storage.putObject(
        certificatePdfKey(academy.id, certificate.id, v),
        Buffer.from(`%PDF v${v} Real Name`),
        'application/pdf',
      );
    }
    return { academyId: academy.id, certificateId: certificate.id };
  }

  const present = async (academyId: string, certificateId: string, v: number) =>
    (await storage.headObject(certificatePdfKey(academyId, certificateId, v))) !== null;

  it('deletes every superseded version, keeps the current one and other certificates', async () => {
    const target = await seedCertificate('purge-target', 3);
    const bystander = await seedCertificate('purge-bystander', 2);

    expect(
      await certificates.purgeSupersededPdfs(target.certificateId, target.academyId),
    ).toBe(2);

    expect(await present(target.academyId, target.certificateId, 1)).toBe(false);
    expect(await present(target.academyId, target.certificateId, 2)).toBe(false);
    expect(await present(target.academyId, target.certificateId, 3)).toBe(true);
    expect(await present(bystander.academyId, bystander.certificateId, 1)).toBe(true);
    expect(await present(bystander.academyId, bystander.certificateId, 2)).toBe(true);

    // Replay: already absent is success, and still nothing current is touched.
    expect(
      await certificates.purgeSupersededPdfs(target.certificateId, target.academyId),
    ).toBe(2);
    expect(await present(target.academyId, target.certificateId, 3)).toBe(true);
  });

  it('does nothing for a certificate that does not belong to the named academy', async () => {
    const target = await seedCertificate('purge-wrong-academy', 2);
    const other = await seedCertificate('purge-other-academy', 1);
    expect(
      await certificates.purgeSupersededPdfs(target.certificateId, other.academyId),
    ).toBe(0);
    expect(await present(target.academyId, target.certificateId, 1)).toBe(true);
  });
});
