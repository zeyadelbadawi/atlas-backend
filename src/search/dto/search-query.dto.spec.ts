import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchQueryDto, MAX_SEARCH_QUERY_LENGTH } from './search-query.dto';

async function validateQuery(q: unknown) {
  const dto = plainToInstance(SearchQueryDto, { q });
  return validate(dto);
}

describe('SearchQueryDto', () => {
  it('accepts a normal query', async () => {
    expect(await validateQuery('academy')).toHaveLength(0);
  });

  it('rejects a missing q', async () => {
    const errors = await validateQuery(undefined);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty string', async () => {
    const errors = await validateQuery('');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a whitespace-only query (trimmed before validation)', async () => {
    const errors = await validateQuery('   ');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a single-character query (below the minimum)', async () => {
    const errors = await validateQuery('a');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an excessively long query', async () => {
    const errors = await validateQuery('a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a query at exactly the maximum length', async () => {
    const errors = await validateQuery('a'.repeat(MAX_SEARCH_QUERY_LENGTH));
    expect(errors).toHaveLength(0);
  });

  it('trims surrounding whitespace', async () => {
    const dto = plainToInstance(SearchQueryDto, { q: '  academy  ' });
    expect(dto.q).toBe('academy');
  });
});
