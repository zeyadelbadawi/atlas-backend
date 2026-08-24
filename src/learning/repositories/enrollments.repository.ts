/**
 * EnrollmentsRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService`, never the raw `PrismaService`,
 * matching every other repository in this codebase's established rule.
 */
import { Injectable } from '@nestjs/common';
import type { Enrollment, Prisma } from '@prisma/client';

@Injectable()
export class EnrollmentsRepository {
  findByStudentAndCourse(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<Enrollment | null> {
    return tx.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<Enrollment | null> {
    return tx.enrollment.findUnique({ where: { id } });
  }

  async findManyForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: Enrollment[]; totalItems: number }> {
    const where: Prisma.EnrollmentWhereInput = { studentId };
    const [items, totalItems] = await Promise.all([
      tx.enrollment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.enrollment.count({ where }),
    ]);
    return { items, totalItems };
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.EnrollmentCreateInput,
  ): Promise<Enrollment> {
    return tx.enrollment.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.EnrollmentUpdateInput,
  ): Promise<Enrollment> {
    return tx.enrollment.update({ where: { id }, data });
  }
}
