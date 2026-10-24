/**
 * The caller's own push devices (`push_devices`, own-row FORCE RLS).
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../tenancy/services/tenancy-context.service';
import type { AuthContext } from '../identity/guards/jwt-auth.guard';
import type { RegisterPushDeviceDto } from './dto/register-push-device.dto';

export interface PushDeviceResponse {
  readonly id: string;
  readonly platform: string;
  readonly locale: string;
  readonly appVersion: string;
  readonly createdAt: string;
}

@Injectable()
export class PushDevicesService {
  constructor(private readonly tenancy: TenancyContextService) {}

  /**
   * Registers (or refreshes) this install's token for the caller's academy
   * session. A token another account registered on this phone earlier is
   * released first, so the phone stops receiving that account's pushes.
   * Only academy sessions: the app is the learner app.
   */
  async register(
    auth: AuthContext,
    dto: RegisterPushDeviceDto,
  ): Promise<PushDeviceResponse> {
    if (auth.surface !== 'academy' || !auth.academyId) {
      throw new ForbiddenException({ messageKey: 'errors.push.academySessionRequired' });
    }
    const academyId = auth.academyId;
    const row = await this.tenancy.runInUserContext(auth.userId, async (tx) => {
      await tx.$executeRaw`SELECT release_push_token(${dto.token})`;
      return tx.pushDevice.upsert({
        where: { token: dto.token },
        create: {
          userId: auth.userId,
          academyId,
          sessionId: auth.sessionId,
          platform: dto.platform,
          token: dto.token,
          appVersion: dto.appVersion,
          locale: dto.locale,
        },
        update: {
          academyId,
          sessionId: auth.sessionId,
          platform: dto.platform,
          appVersion: dto.appVersion,
          locale: dto.locale,
        },
      });
    });
    return toResponse(row);
  }

  /** Removes one of the caller's own devices (sign-out, notifications turned off). */
  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.tenancy.runInUserContext(userId, (tx) =>
      tx.pushDevice.deleteMany({ where: { id, userId } }),
    );
    if (count === 0) throw new NotFoundException({ messageKey: 'errors.notFound' });
  }
}

function toResponse(row: {
  id: string;
  platform: string;
  locale: string;
  appVersion: string;
  createdAt: Date;
}): PushDeviceResponse {
  return {
    id: row.id,
    platform: row.platform,
    locale: row.locale,
    appVersion: row.appVersion,
    createdAt: row.createdAt.toISOString(),
  };
}
