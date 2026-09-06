/** PaymentMethodsController — `/payment-methods` (master plan §10). Platform-owned catalog: every authenticated caller reads the same list, no organization scoping — matches `PlansController`'s identical "only `JwtAuthGuard` applies" precedent. */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PaymentService } from '../services/payment.service';
import type { PaymentMethodResponse } from '../dto/payment-method.contract';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('payment-methods')
@UseGuards(JwtAuthGuard)
export class PaymentMethodsController {
  constructor(private readonly paymentService: PaymentService) {}

  /** Phase 4.5.3 (Change 4) — paginated; see `PaymentService.getPaymentMethods`'s own doc comment. */
  @Get()
  async list(
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<PaymentMethodResponse>> {
    return this.paymentService.getPaymentMethods(query);
  }
}
