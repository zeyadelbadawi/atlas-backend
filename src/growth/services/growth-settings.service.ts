/**
 * GrowthSettingsService — G1: the season / capacity settings singleton
 * (`growth_settings`, id 1, seeded by the migration). Platform Owner only,
 * reads included (RLS).
 *
 * An edit compares `version` → 409 `errors.growth.settingsStale` (code
 * `GROWTH_SETTINGS_STALE`). Cross-field rules are checked on the MERGED
 * values: the season must end after it starts, and "hire now" must not be
 * below "warn". A save that changes nothing writes nothing.
 */
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type GrowthSettings } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { UpdateGrowthSettingsDto } from '../dto/growth.dto';
import { isRealDate } from '../dto/growth.dto';
import type { GrowthSettingsResponse } from '../dto/growth.contract';
import {
  GROWTH_AUDIT,
  GROWTH_ERRORS,
  GROWTH_ROLE,
  GROWTH_SETTINGS_STALE_CODE,
} from '../growth.constants';
import type { CapacitySettings } from '../growth-math';
import { dateColumnToString, daysBetween } from '../growth-time';
import { userNames } from '../user-names';

const SETTINGS_ID = 1;

type SettingsField = keyof Omit<UpdateGrowthSettingsDto, 'version'>;
const FIELDS: readonly SettingsField[] = [
  'seasonStart',
  'seasonEnd',
  'weeklyOwnerHours',
  'onboardingCapPerWeek',
  'minutesPerOnboarding',
  'supportMinutesPerPayingOrgPerWeek',
  'hireWarnPayingOrgs',
  'hireNowPayingOrgs',
];

/** The stored row as plain values (dates `YYYY-MM-DD`, hours a number). */
export function toCapacitySettings(row: GrowthSettings): CapacitySettings {
  return {
    seasonStart: dateColumnToString(row.seasonStart),
    seasonEnd: dateColumnToString(row.seasonEnd),
    weeklyOwnerHours: Number(row.weeklyOwnerHours),
    onboardingCapPerWeek: row.onboardingCapPerWeek,
    minutesPerOnboarding: row.minutesPerOnboarding,
    supportMinutesPerPayingOrgPerWeek: row.supportMinutesPerPayingOrgPerWeek,
    hireWarnPayingOrgs: row.hireWarnPayingOrgs,
    hireNowPayingOrgs: row.hireNowPayingOrgs,
  };
}

/** The fields an edit actually changes, after the cross-field checks on the merged values. */
export function settingsChanges(
  current: CapacitySettings,
  payload: UpdateGrowthSettingsDto,
): Partial<CapacitySettings> {
  for (const key of ['seasonStart', 'seasonEnd'] as const) {
    const value = payload[key];
    if (value !== undefined && !isRealDate(value)) {
      throw new BadRequestException({
        messageKey: 'errors.validation.failed',
        violations: [{ field: key, messageKey: 'validation:invalid' }],
      });
    }
  }
  const merged: CapacitySettings = { ...current };
  const changes: Partial<Record<SettingsField, string | number>> = {};
  for (const key of FIELDS) {
    const value = payload[key];
    if (value !== undefined && value !== current[key]) {
      changes[key] = value;
      (merged as unknown as Record<string, string | number>)[key] = value;
    }
  }
  if (daysBetween(merged.seasonStart, merged.seasonEnd) <= 0) {
    throw new BadRequestException({ messageKey: GROWTH_ERRORS.seasonRangeInvalid });
  }
  if (merged.hireNowPayingOrgs < merged.hireWarnPayingOrgs) {
    throw new BadRequestException({ messageKey: GROWTH_ERRORS.hireThresholdsInvalid });
  }
  return changes as Partial<CapacitySettings>;
}

@Injectable()
export class GrowthSettingsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async get(platformOwnerId: string): Promise<GrowthSettingsResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) =>
      this.toResponse(tx, await this.load(tx)),
    );
  }

  /** The current settings, inside an open Platform Owner transaction. */
  async load(tx: Prisma.TransactionClient): Promise<GrowthSettings> {
    return tx.growthSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
  }

  async update(
    platformOwnerId: string,
    payload: UpdateGrowthSettingsDto,
  ): Promise<GrowthSettingsResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM growth_settings WHERE id = ${SETTINGS_ID} FOR UPDATE`;
      const current = await this.load(tx);
      if (current.version !== payload.version) {
        throw new ConflictException({
          messageKey: GROWTH_ERRORS.settingsStale,
          code: GROWTH_SETTINGS_STALE_CODE,
        });
      }
      const changes = settingsChanges(toCapacitySettings(current), payload);
      const changed = Object.keys(changes);
      if (changed.length === 0) return this.toResponse(tx, current);

      const data: Prisma.GrowthSettingsUpdateInput = {
        updatedByUserId: platformOwnerId,
        version: { increment: 1 },
      };
      if (changes.seasonStart)
        data.seasonStart = new Date(`${changes.seasonStart}T00:00:00.000Z`);
      if (changes.seasonEnd)
        data.seasonEnd = new Date(`${changes.seasonEnd}T00:00:00.000Z`);
      if (changes.weeklyOwnerHours !== undefined) {
        data.weeklyOwnerHours = new Prisma.Decimal(changes.weeklyOwnerHours);
      }
      for (const key of [
        'onboardingCapPerWeek',
        'minutesPerOnboarding',
        'supportMinutesPerPayingOrgPerWeek',
        'hireWarnPayingOrgs',
        'hireNowPayingOrgs',
      ] as const) {
        if (changes[key] !== undefined) data[key] = changes[key];
      }
      const updated = await tx.growthSettings.update({
        where: { id: SETTINGS_ID },
        data,
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: GROWTH_ROLE,
        action: GROWTH_AUDIT.settingsUpdated,
        targetType: 'growth_settings',
        targetId: String(SETTINGS_ID),
        context: { changedFields: changed.join(',') },
      });
      return this.toResponse(tx, updated);
    });
  }

  private async toResponse(
    tx: Prisma.TransactionClient,
    row: GrowthSettings,
  ): Promise<GrowthSettingsResponse> {
    const names = await userNames(tx, [row.updatedByUserId]);
    return {
      ...toCapacitySettings(row),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
      updatedByName: row.updatedByUserId
        ? (names.get(row.updatedByUserId) ?? null)
        : null,
    };
  }
}
