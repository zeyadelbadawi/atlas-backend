import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.isHealthy();
      return this.getStatus(key, true);
    } catch (error) {
      const result = this.getStatus(key, false, { message: this.describe(error) });
      throw new HealthCheckError('Database check failed', result);
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown database error';
  }
}
