/**
 * G1 — request validation (the global ValidationPipe's rules: whitelist +
 * forbidNonWhitelisted), the month window, the settings cross-field rules,
 * the heardFrom fields on signup / contact, and optimistic concurrency
 * (409 on a stale version) in the settings and spend services.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, type GrowthSettings, type MarketingSpendEntry } from '@prisma/client';
import {
  CreateSpendEntryDto,
  MonthRangeQueryDto,
  SetOrganizationChannelDto,
  UpdateGrowthSettingsDto,
  UpdateSpendEntryDto,
  isRealDate,
} from './dto/growth.dto';
import { resolveMonthRange } from './month-range';
import {
  GrowthSettingsService,
  settingsChanges,
  toCapacitySettings,
} from './services/growth-settings.service';
import { MarketingSpendService } from './services/marketing-spend.service';
import { RegisterDto } from '../identity/dto/register.dto';
import { SubmitPlatformContactDto } from '../platform-contact/dto/submit-platform-contact.dto';
import {
  GROWTH_SETTINGS_STALE_CODE,
  MARKETING_SPEND_STALE_CODE,
} from './growth.constants';

async function errors(cls: new () => object, body: object): Promise<string[]> {
  const result = await validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return result.map((error) => error.property);
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function responseOf(error: unknown): Record<string, unknown> {
  return (error as BadRequestException).getResponse() as Record<string, unknown>;
}

describe('CreateSpendEntryDto', () => {
  const valid = { month: '2026-10', channel: 'meta_ads', amountMinorUnits: 150_000 };

  it('accepts a valid entry, with or without a description', async () => {
    expect(await errors(CreateSpendEntryDto, valid)).toEqual([]);
    expect(
      await errors(CreateSpendEntryDto, { ...valid, description: 'Reels boost' }),
    ).toEqual([]);
  });

  it.each([
    '2026-13',
    '2026-00',
    '2026-1',
    '26-10',
    '2026-10-01',
    '2019-12',
    '2101-01',
    '',
  ])('refuses the month %j', async (month) => {
    expect(await errors(CreateSpendEntryDto, { ...valid, month })).toContain('month');
  });

  it.each([0, -1, 1.5, 10_000_000_001, '100', null])(
    'refuses the amount %j',
    async (amountMinorUnits) => {
      expect(await errors(CreateSpendEntryDto, { ...valid, amountMinorUnits })).toContain(
        'amountMinorUnits',
      );
    },
  );

  it('accepts the bounds 1 and 10,000,000,000', async () => {
    expect(await errors(CreateSpendEntryDto, { ...valid, amountMinorUnits: 1 })).toEqual(
      [],
    );
    expect(
      await errors(CreateSpendEntryDto, { ...valid, amountMinorUnits: 10_000_000_000 }),
    ).toEqual([]);
  });

  it.each(['unknown', 'linkedin', '', 'META_ADS'])(
    'refuses the channel %j',
    async (channel) => {
      expect(await errors(CreateSpendEntryDto, { ...valid, channel })).toContain(
        'channel',
      );
    },
  );

  it('refuses a description over 200 characters and unknown keys', async () => {
    expect(
      await errors(CreateSpendEntryDto, { ...valid, description: 'x'.repeat(201) }),
    ).toContain('description');
    expect(await errors(CreateSpendEntryDto, { ...valid, currency: 'USD' })).toContain(
      'currency',
    );
  });

  it('a blank description becomes null', () => {
    const dto = plainToInstance(CreateSpendEntryDto, { ...valid, description: '   ' });
    expect(dto.description).toBeNull();
  });
});

describe('UpdateSpendEntryDto', () => {
  it('needs a version; fields are optional; null is refused except for description', async () => {
    expect(await errors(UpdateSpendEntryDto, { amountMinorUnits: 5 })).toContain(
      'version',
    );
    expect(await errors(UpdateSpendEntryDto, { version: 1 })).toEqual([]);
    expect(await errors(UpdateSpendEntryDto, { version: 1, description: null })).toEqual(
      [],
    );
    expect(await errors(UpdateSpendEntryDto, { version: 1, month: null })).toContain(
      'month',
    );
    expect(
      await errors(UpdateSpendEntryDto, { version: 1, channel: 'unknown' }),
    ).toContain('channel');
  });
});

describe('UpdateGrowthSettingsDto', () => {
  it.each([
    ['weeklyOwnerHours', 0.5],
    ['weeklyOwnerHours', 80.1],
    ['weeklyOwnerHours', 15.25],
    ['onboardingCapPerWeek', 0],
    ['onboardingCapPerWeek', 51],
    ['minutesPerOnboarding', 14],
    ['minutesPerOnboarding', 601],
    ['supportMinutesPerPayingOrgPerWeek', -1],
    ['supportMinutesPerPayingOrgPerWeek', 241],
    ['hireWarnPayingOrgs', 0],
    ['hireNowPayingOrgs', 2.5],
    ['seasonStart', '2027-6-1'],
    ['seasonEnd', null],
  ])('refuses %s = %j', async (field, value) => {
    expect(
      await errors(UpdateGrowthSettingsDto, { version: 1, [field]: value }),
    ).toContain(field);
  });

  it('accepts the bounds and one decimal of hours', async () => {
    expect(
      await errors(UpdateGrowthSettingsDto, {
        version: 3,
        weeklyOwnerHours: 12.5,
        onboardingCapPerWeek: 50,
        minutesPerOnboarding: 15,
        supportMinutesPerPayingOrgPerWeek: 0,
        hireWarnPayingOrgs: 1,
        hireNowPayingOrgs: 10_000,
        seasonStart: '2027-06-01',
        seasonEnd: '2027-09-30',
      }),
    ).toEqual([]);
    expect(await errors(UpdateGrowthSettingsDto, {})).toContain('version');
  });

  it('real calendar dates only', () => {
    expect(isRealDate('2027-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('2027-04-31')).toBe(false);
  });
});

describe('SetOrganizationChannelDto', () => {
  it('a channel of the 16, or null to clear; note ≤ 200', async () => {
    expect(
      await errors(SetOrganizationChannelDto, { channel: 'whatsapp', note: 'call' }),
    ).toEqual([]);
    expect(await errors(SetOrganizationChannelDto, { channel: null })).toEqual([]);
    expect(await errors(SetOrganizationChannelDto, { channel: 'unknown' })).toEqual([]);
    expect(await errors(SetOrganizationChannelDto, {})).toContain('channel');
    expect(await errors(SetOrganizationChannelDto, { channel: 'linkedin' })).toContain(
      'channel',
    );
    expect(
      await errors(SetOrganizationChannelDto, {
        channel: 'event',
        note: 'x'.repeat(201),
      }),
    ).toContain('note');
  });
});

describe('heardFrom on signup and contact', () => {
  const register = {
    name: 'Owner',
    email: 'o@example.com',
    password: 'correct-horse-battery',
  };
  const contact = {
    name: 'Visitor',
    email: 'v@example.com',
    topic: 'sales',
    message: 'Hello, I run an academy and want to know more.',
    locale: 'en',
  };

  it.each([
    ['RegisterDto', RegisterDto, register],
    ['SubmitPlatformContactDto', SubmitPlatformContactDto, contact],
  ] as const)('%s accepts the self-reported options only', async (_n, cls, body) => {
    for (const heardFrom of ['facebook', 'teacher_referral', 'ai_assistant', 'other']) {
      expect(await errors(cls, { ...body, heardFrom })).not.toContain('heardFrom');
    }
    for (const heardFrom of [
      'unknown',
      'google_ads',
      'meta_ads',
      'email',
      'partner',
      'x',
    ]) {
      expect(await errors(cls, { ...body, heardFrom })).toContain('heardFrom');
    }
    expect(
      await errors(cls, { ...body, heardFrom: 'other', heardFromOther: 'x'.repeat(100) }),
    ).not.toContain('heardFromOther');
    expect(
      await errors(cls, { ...body, heardFrom: 'other', heardFromOther: 'x'.repeat(101) }),
    ).toContain('heardFromOther');
    expect(await errors(cls, body)).not.toContain('heardFrom');
  });
});

describe('resolveMonthRange', () => {
  const NOW = new Date('2026-10-26T10:00:00Z');

  it('defaults to the last N Cairo months including the current one', () => {
    expect(resolveMonthRange({}, NOW, 6)).toEqual({ from: '2026-05', to: '2026-10' });
    // 31 Oct 22:30 UTC is already November in Cairo.
    expect(resolveMonthRange({}, new Date('2026-10-31T22:30:00Z'), 6)).toEqual({
      from: '2026-06',
      to: '2026-11',
    });
    expect(resolveMonthRange({ to: '2026-03' }, NOW, 12)).toEqual({
      from: '2025-04',
      to: '2026-03',
    });
    expect(resolveMonthRange({ from: '2026-01' }, NOW, 6)).toEqual({
      from: '2026-01',
      to: '2026-10',
    });
  });

  it('from after to → monthRangeInvalid; more than 36 months → monthRangeTooLong', () => {
    let invalid: unknown;
    try {
      resolveMonthRange({ from: '2026-05', to: '2026-04' }, NOW, 6);
    } catch (error) {
      invalid = error;
    }
    expect(responseOf(invalid)).toEqual({
      messageKey: 'errors.growth.monthRangeInvalid',
    });
    expect(() =>
      resolveMonthRange({ from: '2023-11', to: '2026-10' }, NOW, 6),
    ).not.toThrow();
    let tooLong: unknown;
    try {
      resolveMonthRange({ from: '2023-10', to: '2026-10' }, NOW, 6);
    } catch (error) {
      tooLong = error;
    }
    expect(responseOf(tooLong)).toEqual({
      messageKey: 'errors.growth.monthRangeTooLong',
      details: { maxMonths: 36 },
    });
  });

  it('the query DTO refuses malformed months', async () => {
    expect(await errors(MonthRangeQueryDto, { from: '2026-1' })).toContain('from');
    expect(await errors(MonthRangeQueryDto, { to: 'now' })).toContain('to');
    expect(await errors(MonthRangeQueryDto, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Settings and spend services: merged-value rules and 409 on a stale version
// ---------------------------------------------------------------------------

const PO = 'po-user';
const NOW = new Date('2026-10-26T12:00:00.000Z');

function settingsRow(overrides: Partial<GrowthSettings> = {}): GrowthSettings {
  return {
    id: 1,
    seasonStart: new Date('2027-06-01T00:00:00Z'),
    seasonEnd: new Date('2027-09-30T00:00:00Z'),
    weeklyOwnerHours: new Prisma.Decimal(15),
    onboardingCapPerWeek: 5,
    minutesPerOnboarding: 120,
    supportMinutesPerPayingOrgPerWeek: 10,
    hireWarnPayingOrgs: 33,
    hireNowPayingOrgs: 40,
    version: 1,
    updatedByUserId: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function txHarness() {
  let settings = settingsRow();
  const spend = new Map<string, MarketingSpendEntry>([
    [
      'spend-1',
      {
        id: 'spend-1',
        month: new Date('2026-10-01T00:00:00Z'),
        channel: 'meta_ads',
        amountMinorUnits: BigInt(150_000),
        currency: 'EGP',
        description: null,
        version: 2,
        createdByUserId: PO,
        updatedByUserId: PO,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  ]);
  const tx = {
    growthSettings: {
      findUniqueOrThrow: jest.fn(async () => settings),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const next = { ...settings } as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          next[key] =
            value && typeof value === 'object' && 'increment' in (value as object)
              ? (next[key] as number) + 1
              : value;
        }
        settings = next as unknown as GrowthSettings;
        return settings;
      }),
    },
    marketingSpendEntry: {
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => ({
        ...spend.get(where.id)!,
      })),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => spend.get(where.id) ?? null,
      ),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: { findMany: jest.fn(async () => [{ id: PO, name: 'Platform Owner' }]) },
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, id: string | number) =>
      typeof id === 'number' || spend.has(id) ? [{ id }] : [],
    ),
  };
  const tenancy = {
    runInUserContext: jest.fn(async (_u: string, work: (t: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  const audit = { write: jest.fn(async () => undefined) };
  return { tx, tenancy, audit };
}

describe('GrowthSettingsService', () => {
  it('409 GROWTH_SETTINGS_STALE on a stale version, nothing written', async () => {
    const { tx, tenancy, audit } = txHarness();
    const service = new GrowthSettingsService(tenancy as never, audit as never);
    const error = await thrown(
      service.update(PO, { version: 7, onboardingCapPerWeek: 6 }),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(responseOf(error)).toEqual({
      messageKey: 'errors.growth.settingsStale',
      code: GROWTH_SETTINGS_STALE_CODE,
    });
    expect(tx.growthSettings.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('saves the changed fields, bumps the version and audits them', async () => {
    const { tx, tenancy, audit } = txHarness();
    const service = new GrowthSettingsService(tenancy as never, audit as never);
    const result = await service.update(PO, {
      version: 1,
      weeklyOwnerHours: 12.5,
      onboardingCapPerWeek: 5, // unchanged
      seasonEnd: '2027-10-15',
    });
    expect(result).toMatchObject({
      weeklyOwnerHours: 12.5,
      seasonEnd: '2027-10-15',
      version: 2,
      updatedByName: 'Platform Owner',
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'platform.growth.settings_updated',
        targetType: 'growth_settings',
        context: { changedFields: 'seasonEnd,weeklyOwnerHours' },
      }),
    );
  });

  it('a save that changes nothing writes nothing', async () => {
    const { tx, tenancy, audit } = txHarness();
    const service = new GrowthSettingsService(tenancy as never, audit as never);
    const result = await service.update(PO, { version: 1, weeklyOwnerHours: 15 });
    expect(result.version).toBe(1);
    expect(tx.growthSettings.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('cross-field rules on the MERGED values', () => {
    const current = toCapacitySettings(settingsRow());
    const fail = (payload: UpdateGrowthSettingsDto) => {
      try {
        settingsChanges(current, payload);
      } catch (error) {
        return responseOf(error).messageKey;
      }
      return null;
    };
    expect(fail({ version: 1, seasonEnd: '2027-06-01' })).toBe(
      'errors.growth.seasonRangeInvalid',
    );
    expect(fail({ version: 1, seasonStart: '2027-10-01' })).toBe(
      'errors.growth.seasonRangeInvalid',
    );
    expect(fail({ version: 1, hireNowPayingOrgs: 32 })).toBe(
      'errors.growth.hireThresholdsInvalid',
    );
    expect(fail({ version: 1, hireWarnPayingOrgs: 41 })).toBe(
      'errors.growth.hireThresholdsInvalid',
    );
    expect(fail({ version: 1, hireWarnPayingOrgs: 40 })).toBeNull();
    expect(fail({ version: 1, seasonStart: '2027-02-29' })).toBe(
      'errors.validation.failed',
    );
    expect(
      fail({ version: 1, seasonStart: '2028-06-01', seasonEnd: '2028-09-30' }),
    ).toBeNull();
  });
});

describe('MarketingSpendService', () => {
  it('409 MARKETING_SPEND_STALE on a stale version, nothing written', async () => {
    const { tx, tenancy, audit } = txHarness();
    const service = new MarketingSpendService(tenancy as never, audit as never);
    const error = await thrown(
      service.update(PO, 'spend-1', { version: 1, amountMinorUnits: 200_000 }),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(responseOf(error)).toEqual({
      messageKey: 'errors.growth.spendStale',
      code: MARKETING_SPEND_STALE_CODE,
    });
    expect(tx.marketingSpendEntry.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('404 for an unknown entry (update and delete)', async () => {
    const { tenancy, audit } = txHarness();
    const service = new MarketingSpendService(tenancy as never, audit as never);
    const update = await thrown(service.update(PO, 'nope', { version: 1 }));
    expect(responseOf(update)).toEqual({ messageKey: 'errors.growth.spendNotFound' });
    const remove = await thrown(service.remove(PO, 'nope'));
    expect(responseOf(remove)).toEqual({ messageKey: 'errors.growth.spendNotFound' });
  });

  it('an unchanged save returns the row without writing', async () => {
    const { tx, tenancy, audit } = txHarness();
    const service = new MarketingSpendService(tenancy as never, audit as never);
    const result = await service.update(PO, 'spend-1', {
      version: 2,
      month: '2026-10',
      channel: 'meta_ads',
      amountMinorUnits: 150_000,
    });
    expect(result).toMatchObject({
      id: 'spend-1',
      month: '2026-10',
      amountMinorUnits: 150_000,
      currency: 'EGP',
      version: 2,
      createdByName: 'Platform Owner',
    });
    expect(tx.marketingSpendEntry.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
