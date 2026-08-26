/** `GET organizations/:id/payments` / `GET /payments` query contract — the shared `CollectionQuery` base only; neither `PaymentService.getPayments` nor `PlatformPaymentService.getPayments` defines a typed filter beyond pagination/search/sort (`payment.types.ts`). */
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export class PaymentListQueryDto extends CollectionQueryDto {}
