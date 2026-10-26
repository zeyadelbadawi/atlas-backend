/**
 * G1 — audit actions, messageKeys and error codes of `platform-growth/*`.
 */
export const GROWTH_ROLE = 'platform_owner';

export const GROWTH_AUDIT = {
  settingsUpdated: 'platform.growth.settings_updated',
  spendCreated: 'platform.growth.spend_created',
  spendUpdated: 'platform.growth.spend_updated',
  spendDeleted: 'platform.growth.spend_deleted',
  organizationChannelSet: 'platform.growth.organization_channel_set',
} as const;

export const GROWTH_ERRORS = {
  settingsStale: 'errors.growth.settingsStale',
  spendStale: 'errors.growth.spendStale',
  spendNotFound: 'errors.growth.spendNotFound',
  monthRangeInvalid: 'errors.growth.monthRangeInvalid',
  monthRangeTooLong: 'errors.growth.monthRangeTooLong',
  seasonRangeInvalid: 'errors.growth.seasonRangeInvalid',
  hireThresholdsInvalid: 'errors.growth.hireThresholdsInvalid',
  organizationNotFound: 'errors.notFound',
} as const;

export const GROWTH_SETTINGS_STALE_CODE = 'GROWTH_SETTINGS_STALE';
export const MARKETING_SPEND_STALE_CODE = 'MARKETING_SPEND_STALE';

/** Default report windows, in Cairo calendar months including the current one. */
export const SPEND_DEFAULT_MONTHS = 12;
export const CAC_DEFAULT_MONTHS = 6;
export const CAPACITY_WEEKS = 12;
