import { z } from 'zod';
import { zodIssuesToViolations } from './zod-violations.util';

describe('zodIssuesToViolations', () => {
  const schema = z.object({
    title: z.object({ en: z.string().max(5, 'validation:maxLength') }),
    slug: z.string().min(2, 'validation:minLength'),
    tags: z.array(z.string()).max(1, 'validation:maxItems'),
    kind: z.enum(['a', 'b']),
  });

  it('carries the limit a length or size message needs', () => {
    const result = schema.safeParse({
      title: { en: 'toolong' },
      slug: 'x',
      tags: ['a', 'b'],
      kind: 'a',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(zodIssuesToViolations(result.error.issues)).toEqual([
      { field: 'title.en', messageKey: 'validation:maxLength', values: { count: 5 } },
      { field: 'slug', messageKey: 'validation:minLength', values: { count: 2 } },
      { field: 'tags', messageKey: 'validation:maxItems', values: { count: 1 } },
    ]);
  });

  it('adds no values where the message needs none', () => {
    const result = schema.safeParse({
      title: { en: 'ok' },
      slug: 'ok',
      tags: [],
      kind: 'z',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const [violation] = zodIssuesToViolations(result.error.issues);
    expect(violation.field).toBe('kind');
    expect(violation.values).toBeUndefined();
  });
});
