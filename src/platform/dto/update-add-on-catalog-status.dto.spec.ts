/**
 * The status-change body is validated before any handler runs: only the
 * three real catalog states are accepted, and a version token is required.
 */
// `platform-add-on-query.dto` (which this DTO's enum comes from) extends
// `CollectionQueryDto`, whose `@Type()` decorators need `Reflect.getMetadata`;
// polyfill it here since this file's module graph doesn't otherwise trigger it.
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateAddOnCatalogStatusDto } from './update-add-on-catalog-status.dto';

const check = async (value: Record<string, unknown>) =>
  validate(plainToInstance(UpdateAddOnCatalogStatusDto, value));

describe('UpdateAddOnCatalogStatusDto', () => {
  it.each(['draft', 'coming_soon', 'published'])(
    'accepts the valid catalog status %s',
    async (catalogStatus) => {
      await expect(check({ catalogStatus, expectedVersion: 0 })).resolves.toHaveLength(0);
    },
  );

  it.each([
    ['an unknown status', { catalogStatus: 'archived', expectedVersion: 0 }],
    ['no status', { expectedVersion: 0 }],
    ['no version', { catalogStatus: 'published' }],
    ['a negative version', { catalogStatus: 'published', expectedVersion: -1 }],
    ['a non-integer version', { catalogStatus: 'published', expectedVersion: 1.5 }],
    ['nothing at all', {}],
  ])('rejects %s', async (_label, value) => {
    await expect(check(value)).resolves.not.toHaveLength(0);
  });
});
