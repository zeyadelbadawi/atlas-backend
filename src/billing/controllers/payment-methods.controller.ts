/** PaymentMethodsController — `/payment-methods` (master plan §10). Platform-owned catalog: every authenticated caller reads the same list, no organization scoping — matches `PlansController`'s identical "only `JwtAuthGuard` applies" precedent. */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PaymentService } from '../services/payment.service';
import type { PaymentMethodResponse } from '../dto/payment-method.contract';

@Controller('payment-methods')
@UseGuards(JwtAuthGuard)
export class PaymentMethodsController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get()
  async list(): Promise<PaymentMethodResponse[]> {
    return this.paymentService.getPaymentMethods();
  }
}
