/**
 * UsersRepository — the only place `prisma.user.*` is called from.
 *
 * Matches the master plan §11 "Repository / Data Access" layer: services
 * decide business rules, repositories only talk to Postgres.
 */
import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { normalizeEmail } from '../utils/email.util';

export interface CreateUserInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly name: string;
}

export interface UpdateProfileInput {
  readonly name?: string;
  readonly avatarUrl?: string;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        name: input.name,
        // `status` defaults to 'active' per the schema — matches the P1
        // spec's "default status = active unless the existing frontend
        // contract proves another value" (it doesn't; `invited` is a
        // future admin-invitation flow with no P1 endpoint that creates it).
      },
    });
  }

  updateProfile(id: string, input: UpdateProfileInput): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      },
    });
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  touchLastSignInAt(id: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { lastSignInAt: new Date() } });
  }

  /**
   * Atomically shallow-merges `partial` into the stored `preferences` JSONB
   * document using Postgres's `||` jsonb concatenation operator, so two
   * concurrent preference updates for the same user can never lose one
   * write to a read-modify-write race. Parameters are bound (not
   * interpolated), so this is not a SQL-injection surface despite being raw
   * SQL — Prisma's tagged-template `$executeRaw` parameterizes every `${}`.
   */
  async mergePreferences(id: string, partial: Record<string, unknown>): Promise<User> {
    await this.prisma.$executeRaw`
      UPDATE users
      SET preferences = preferences || ${JSON.stringify(partial)}::jsonb,
          updated_at = now()
      WHERE id = ${id}
    `;
    return this.prisma.user.findUniqueOrThrow({ where: { id } });
  }
}
