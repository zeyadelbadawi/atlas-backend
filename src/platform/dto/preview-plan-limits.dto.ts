/** `POST platform-plans/:key/limits/preview` request — the proposed limit set, validated by `assertValidLimits` in the service against the real `PLAN_LIMIT_KEYS`. */
import { IsObject } from 'class-validator';

export class PreviewPlanLimitsDto {
  @IsObject()
  readonly limits!: Record<string, number | 'unlimited'>;
}
