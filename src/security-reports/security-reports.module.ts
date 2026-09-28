import { Module } from '@nestjs/common';
import { CspReportsController } from './csp-reports.controller';

/** Browser-sent security reports (Content-Security-Policy, authentication audit Decision 4). */
@Module({ controllers: [CspReportsController] })
export class SecurityReportsModule {}
