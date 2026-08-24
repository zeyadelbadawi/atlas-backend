/** CourseLessonsRepository. */
import { Injectable } from '@nestjs/common';
import type { CourseLesson, Prisma } from '@prisma/client';

@Injectable()
export class CourseLessonsRepository {
  findById(tx: Prisma.TransactionClient, id: string): Promise<CourseLesson | null> {
    return tx.courseLesson.findUnique({ where: { id } });
  }

  findIdsForSection(
    tx: Prisma.TransactionClient,
    sectionId: string,
  ): Promise<{ id: string }[]> {
    return tx.courseLesson.findMany({ where: { sectionId }, select: { id: true } });
  }

  maxOrder(
    tx: Prisma.TransactionClient,
    sectionId: string,
  ): Promise<{ _max: { order: number | null } }> {
    return tx.courseLesson.aggregate({ where: { sectionId }, _max: { order: true } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.CourseLessonCreateInput,
  ): Promise<CourseLesson> {
    return tx.courseLesson.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CourseLessonUpdateInput,
  ): Promise<CourseLesson> {
    return tx.courseLesson.update({ where: { id }, data });
  }

  updateOrder(
    tx: Prisma.TransactionClient,
    id: string,
    order: number,
  ): Promise<CourseLesson> {
    return tx.courseLesson.update({ where: { id }, data: { order } });
  }

  delete(tx: Prisma.TransactionClient, id: string): Promise<CourseLesson> {
    return tx.courseLesson.delete({ where: { id } });
  }
}
