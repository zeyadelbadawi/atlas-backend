/**
 * P64 Phase 3 (D6, D7) — data access for certificates and templates. Every
 * method runs inside a caller-supplied transaction whose RLS context the
 * caller established (learner = user context, staff = tenant context).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Certificate, CertificateTemplate } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export interface CertificateListFilter {
  readonly courseId?: string;
  readonly status?: 'issued' | 'revoked';
  readonly search?: string;
  readonly skip: number;
  readonly take: number;
}

export type CertificateWithNames = Certificate & {
  student: { id: string; name: string; email: string };
  course: { id: string; title: string; slug: string };
};

const WITH_NAMES = {
  student: { select: { id: true, name: true, email: true } },
  course: { select: { id: true, title: true, slug: true } },
} as const;

export interface VerifiedCertificateRow {
  readonly serial: string;
  readonly status: 'issued' | 'revoked';
  readonly issued_to: string | null;
  readonly course_title: string | null;
  readonly academy_name: string | null;
  readonly academy_slug: string;
  readonly academy_id: string;
  readonly issued_at: Date;
  readonly completed_at: string | null;
  readonly revoked_at: Date | null;
  readonly version: number;
}

@Injectable()
export class CertificatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<CertificateWithNames | null> {
    return tx.certificate.findUnique({
      where: { id },
      include: WITH_NAMES,
    }) as Promise<CertificateWithNames | null>;
  }

  findByEnrollment(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
  ): Promise<Certificate | null> {
    return tx.certificate.findUnique({ where: { enrollmentId } });
  }

  async findManyForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    academyId: string,
  ): Promise<CertificateWithNames[]> {
    return tx.certificate.findMany({
      where: { studentId, academyId },
      include: WITH_NAMES,
      orderBy: { issuedAt: 'desc' },
    }) as Promise<CertificateWithNames[]>;
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: CertificateListFilter,
  ): Promise<{ items: CertificateWithNames[]; totalItems: number }> {
    const where: Prisma.CertificateWhereInput = {
      academyId,
      ...(filter.courseId ? { courseId: filter.courseId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.search
        ? {
            OR: [
              { serial: { contains: filter.search, mode: 'insensitive' } },
              { student: { name: { contains: filter.search, mode: 'insensitive' } } },
              { student: { email: { contains: filter.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, totalItems] = await Promise.all([
      tx.certificate.findMany({
        where,
        include: WITH_NAMES,
        orderBy: { issuedAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }) as Promise<CertificateWithNames[]>,
      tx.certificate.count({ where }),
    ]);
    return { items, totalItems };
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.CertificateUncheckedCreateInput,
  ): Promise<Certificate> {
    return tx.certificate.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CertificateUpdateInput,
  ): Promise<Certificate> {
    return tx.certificate.update({ where: { id }, data });
  }

  /** Atomic per-academy per-year serial (SECURITY DEFINER; refuses a foreign tenant context). */
  async nextSerialValue(
    tx: Prisma.TransactionClient,
    academyId: string,
    year: number,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ next_certificate_serial: number }[]>(
      Prisma.sql`SELECT next_certificate_serial(${academyId}, ${year}::int)`,
    );
    return Number(rows[0]?.next_certificate_serial ?? 0);
  }

  /** Public verification projection (no context needed — SECURITY DEFINER). */
  async verify(code: string): Promise<VerifiedCertificateRow | null> {
    const rows = await this.prisma.$queryRaw<VerifiedCertificateRow[]>(
      Prisma.sql`SELECT * FROM verify_certificate(${code})`,
    );
    return rows[0] ?? null;
  }

  // --- templates -------------------------------------------------------------

  findDefaultTemplate(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<CertificateTemplate | null> {
    return tx.certificateTemplate.findFirst({
      where: { academyId, isDefault: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  findTemplateById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<CertificateTemplate | null> {
    return tx.certificateTemplate.findUnique({ where: { id } });
  }

  createTemplate(
    tx: Prisma.TransactionClient,
    data: Prisma.CertificateTemplateUncheckedCreateInput,
  ): Promise<CertificateTemplate> {
    return tx.certificateTemplate.create({ data });
  }

  updateTemplate(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CertificateTemplateUpdateInput,
  ): Promise<CertificateTemplate> {
    return tx.certificateTemplate.update({ where: { id }, data });
  }
}
