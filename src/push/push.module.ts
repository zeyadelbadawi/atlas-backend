/**
 * Atlas mobile app push notifications (B1, docs/mobile/MOBILE_APP_BACKEND.md).
 *
 * FCM when `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY` are all
 * set; otherwise the stub (sends nothing). A missing or bad credential never
 * stops the API from booting. Sending is gated by `FLAG_PUSH_MODE=on`.
 */
import { Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PUSH_QUEUE } from './push.constants';
import { PUSH_PROVIDER } from './providers/push-provider';
import type { PushProvider } from './providers/push-provider';
import { FcmPushProvider } from './providers/fcm-push.provider';
import { StubPushProvider } from './providers/stub-push.provider';
import { PushDevicesController } from './push-devices.controller';
import { PushDevicesService } from './push-devices.service';
import { PushDeliveryService } from './push-delivery.service';
import { PushProducer } from './push.producer';
import { PushProcessor } from './push.processor';

export function createPushProvider(config: ConfigService): PushProvider {
  const projectId = config.get<string>('FCM_PROJECT_ID');
  const clientEmail = config.get<string>('FCM_CLIENT_EMAIL');
  const privateKey = config.get<string>('FCM_PRIVATE_KEY');
  if (projectId && clientEmail && privateKey) {
    return new FcmPushProvider({ projectId, clientEmail, privateKey });
  }
  if (config.get<string>('FLAG_PUSH_MODE') === 'on') {
    new Logger('PushModule').warn(
      'FLAG_PUSH_MODE=on but FCM_* is not fully configured; pushes go to the stub provider.',
    );
  }
  return new StubPushProvider();
}

@Module({
  imports: [
    AuthCoreModule,
    TenancyModule,
    BullModule.registerQueue({ name: PUSH_QUEUE }),
  ],
  controllers: [PushDevicesController],
  providers: [
    { provide: PUSH_PROVIDER, useFactory: createPushProvider, inject: [ConfigService] },
    PushDevicesService,
    PushDeliveryService,
    PushProducer,
    PushProcessor,
  ],
  exports: [PushProducer],
})
export class PushModule {}
