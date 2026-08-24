/** AddOnsRepository — see `PlansRepository`'s doc comment: `add_ons` is also PLATFORM-owned, no RLS, raw `PrismaService`. */
import { Injectable } from '@nestjs/common';
import type { AddOn } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AddOnsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<AddOn[]> {
    return this.prisma.addOn.findMany({ orderBy: { name: 'asc' } });
  }

  findByKey(key: string): Promise<AddOn | null> {
    return this.prisma.addOn.findUnique({ where: { key } });
  }

  findByIds(ids: readonly string[]): Promise<AddOn[]> {
    return this.prisma.addOn.findMany({ where: { id: { in: [...ids] } } });
  }
}
