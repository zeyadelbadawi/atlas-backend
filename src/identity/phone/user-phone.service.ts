/**
 * The caller's OWN phone number — `GET|PUT|DELETE /users/me/phone`.
 *
 * WHO CAN READ IT. Only the account itself. `user_phones` is FORCE-RLS'd to
 * `app.current_user_id` for every command (migration
 * `20261110000200_user_phone`), and every read/write here runs inside
 * `runInUserContext(userId)` for the access token's own subject — there is
 * no user id parameter anywhere, so there is nothing to swap. Academy staff,
 * organization owners and the Platform Owner have no route and no policy.
 *
 * WHAT IS LOGGED. Never the number. The audit rows carry only the country
 * code and what kind of change it was; nothing here logs the value.
 */
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Prisma, UserPhone } from '@prisma/client';
import { parsePhoneNumberWithError } from 'libphonenumber-js/max';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AuthRateLimiterService } from '../services/auth-rate-limiter.service';
import { normalizePhoneNumber } from './phone-number.policy';
import type { NormalizedPhoneNumber } from './phone-number.policy';
import { PhoneVerificationService } from './phone-verification.service';
import type { PhoneVerificationAvailability } from './phone-verification.service';

/**
 * Changes and removals per account per hour. Generous for a person fixing a
 * typo; tight enough that the endpoint is no use for scripted churn (and,
 * once verification exists, cannot be used to re-trigger sends cheaply).
 */
export const PHONE_CHANGE_LIMIT = { max: 6, windowSeconds: 60 * 60 } as const;

export interface UserPhoneDetails {
  /** `+201001234567` */
  readonly e164: string;
  /** ISO 3166-1 alpha-2, as chosen. */
  readonly country: string;
  /** `20` */
  readonly callingCode: string;
  /** `1001234567` — for the edit field, so it opens with what was saved. */
  readonly nationalNumber: string;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly updatedAt: string;
}

/** Mirrors the frontend's `UserPhone` (`src/types/identity.types.ts`). */
export interface UserPhoneResponse {
  readonly phone: UserPhoneDetails | null;
  readonly verification: PhoneVerificationAvailability;
}

/** The single validation failure shape every phone endpoint answers with. */
export function phoneValidationError(
  reason: 'invalid_country' | 'invalid_number' | 'country_mismatch' | 'not_mobile',
): HttpException {
  const [field, messageKey] =
    reason === 'invalid_country'
      ? ['phoneCountry', 'validation:invalidPhoneCountry']
      : reason === 'country_mismatch'
        ? ['phoneNumber', 'validation:phoneCountryMismatch']
        : reason === 'not_mobile'
          ? ['phoneNumber', 'validation:phoneNotMobile']
          : ['phoneNumber', 'validation:invalidPhone'];
  // The exact shape the global ValidationPipe produces for a DTO violation.
  return new BadRequestException({
    messageKey: 'errors.validation.failed',
    violations: [{ field, messageKey }],
  });
}

/**
 * Re-normalises on the server (the DTO has already validated, but a service
 * never relies on its caller for the stored value) and throws the same 400
 * a DTO violation would.
 */
export function requireNormalizedPhone(
  phoneNumber: unknown,
  phoneCountry: unknown,
): NormalizedPhoneNumber {
  const result = normalizePhoneNumber(phoneNumber, phoneCountry);
  if (!result.ok) throw phoneValidationError(result.reason);
  return result.phone;
}

/** Inserts the phone row for a brand-new account, inside the registration transaction (the new user's own RLS context is already set). */
export async function createPhoneForNewAccount(
  tx: Prisma.TransactionClient,
  userId: string,
  phone: NormalizedPhoneNumber,
): Promise<void> {
  await tx.userPhone.create({
    data: { userId, phoneE164: phone.e164, countryCode: phone.country },
  });
}

@Injectable()
export class UserPhoneService {
  private readonly logger = new Logger(UserPhoneService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly phoneVerificationService: PhoneVerificationService,
  ) {}

  async getOwn(userId: string): Promise<UserPhoneResponse> {
    const row = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.userPhone.findUnique({ where: { userId } }),
    );
    return this.toResponse(row);
  }

  async setOwn(
    userId: string,
    input: { readonly phoneNumber: string; readonly phoneCountry: string },
  ): Promise<UserPhoneResponse> {
    const phone = requireNormalizedPhone(input.phoneNumber, input.phoneCountry);
    const current = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.userPhone.findUnique({ where: { userId } }),
    );
    // Saving what is already stored changes nothing — no budget spent, and a
    // verification (once there is one) is kept.
    if (
      current &&
      current.phoneE164 === phone.e164 &&
      current.countryCode === phone.country
    ) {
      return this.toResponse(current);
    }
    await this.consumeChangeBudget(userId);

    const updated = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const before = await tx.userPhone.findUnique({ where: { userId } });
        const numberChanged = before?.phoneE164 !== phone.e164;
        const row = await tx.userPhone.upsert({
          where: { userId },
          create: { userId, phoneE164: phone.e164, countryCode: phone.country },
          update: {
            phoneE164: phone.e164,
            countryCode: phone.country,
            // A verification proves one number; the DB trigger enforces the
            // same rule for any writer that forgets this line.
            ...(numberChanged ? { verifiedAt: null } : {}),
          },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          action: 'account.phone.updated',
          targetType: 'user',
          targetId: userId,
          context: {
            change: before ? (numberChanged ? 'changed' : 'country_changed') : 'added',
            country: phone.country,
            ...(before ? { previousCountry: before.countryCode } : {}),
            verificationCleared: Boolean(before?.verifiedAt && numberChanged),
          },
        });
        return row;
      },
    );
    return this.toResponse(updated);
  }

  async removeOwn(userId: string): Promise<UserPhoneResponse> {
    const current = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.userPhone.findUnique({ where: { userId } }),
    );
    if (!current) return this.toResponse(null);
    await this.consumeChangeBudget(userId);
    await this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const removed = await tx.userPhone.deleteMany({ where: { userId } });
      if (removed.count === 0) return;
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        action: 'account.phone.removed',
        targetType: 'user',
        targetId: userId,
        context: {
          country: current.countryCode,
          wasVerified: Boolean(current.verifiedAt),
        },
      });
    });
    return this.toResponse(null);
  }

  /** Per-account change budget; a Redis failure allows the change (logged) — the same posture as the profile rename budget. */
  private async consumeChangeBudget(userId: string): Promise<void> {
    let allowed = true;
    let retryAfterSeconds = 0;
    try {
      const check = await this.rateLimiter.consume(
        `profile-phone:${userId}`,
        PHONE_CHANGE_LIMIT.max,
        PHONE_CHANGE_LIMIT.windowSeconds,
      );
      allowed = check.allowed;
      retryAfterSeconds = check.retryAfterSeconds;
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : String(error) },
        'Phone change budget could not be checked; allowing this change.',
      );
    }
    if (!allowed) {
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited', details: { retryAfterSeconds } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private toResponse(row: UserPhone | null): UserPhoneResponse {
    return {
      phone: row ? toPhoneDetails(row) : null,
      verification: this.phoneVerificationService.availability(),
    };
  }
}

function toPhoneDetails(row: UserPhone): UserPhoneDetails {
  // The stored value passed the policy and the table's CHECK; parsing it
  // back only splits it into calling code and national number for display.
  let callingCode = '';
  let nationalNumber = row.phoneE164.replace(/^\+/, '');
  try {
    const parsed = parsePhoneNumberWithError(row.phoneE164);
    callingCode = parsed.countryCallingCode;
    nationalNumber = parsed.nationalNumber;
  } catch {
    // A number stored under older metadata that no longer parses is still
    // shown — as its E.164 digits — rather than hidden from its owner.
  }
  return {
    e164: row.phoneE164,
    country: row.countryCode,
    callingCode,
    nationalNumber,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
