import { Module } from '@nestjs/common';
import { RumController } from './rum.controller';

/** Real-user monitoring ingestion (P6). The aggregated view lives in the platform observability API. */
@Module({ controllers: [RumController] })
export class RumModule {}
