/** CourseSectionsRepository. */
import { Injectable } from '@nestjs/common';
import type { CourseLesson, CourseSection, Prisma } from '@prisma/client';

export type CourseSectionWithLessons = CourseSection & { lessons: CourseLesson[] };

@Injectable()
export class CourseSectionsRepository {
  findById(tx: Prisma.TransactionClient, id: string): Promise<CourseSection | null> {
    return tx.courseSection.findUnique({ where: { id } });
  }

  findManyForCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<CourseSectionWithLessons[]> {
    return tx.courseSection.findMany({
      where: { courseId },
      orderBy: { order: 'asc' },
      include: { lessons: { orderBy: { order: 'asc' } } },
    });
  }

  /** All section ids for a course, in current order — used to validate a reorder request's `orderedIds` set. */
  findIdsForCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<{ id: string }[]> {
    return tx.courseSection.findMany({ where: { courseId }, select: { id: true } });
  }

  maxOrder(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<{ _max: { order: number | null } }> {
    return tx.courseSection.aggregate({ where: { courseId }, _max: { order: true } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.CourseSectionCreateInput,
  ): Promise<CourseSection> {
    return tx.courseSection.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CourseSectionUpdateInput,
  ): Promise<CourseSection> {
    return tx.courseSection.update({ where: { id }, data });
  }

  updateOrder(
    tx: Prisma.TransactionClient,
    id: string,
    order: number,
  ): Promise<CourseSection> {
    return tx.courseSection.update({ where: { id }, data: { order } });
  }

  delete(tx: Prisma.TransactionClient, id: string): Promise<CourseSection> {
    return tx.courseSection.delete({ where: { id } });
  }
}
