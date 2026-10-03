import {
  buildAcademyCourseOrderWhere,
  escapeLikePattern,
} from './academy-course-orders.repository';

describe('academy course order search', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(escapeLikePattern('plain@example.test')).toBe('plain@example.test');
  });

  it('matches the order id verbatim and every ILIKE field as a literal', () => {
    const where = buildAcademyCourseOrderWhere('academy-1', { search: ' %@x.test ' });
    expect(where.OR).toEqual([
      { id: '%@x.test' },
      { course: { title: { contains: '\\%@x.test', mode: 'insensitive' } } },
      { student: { name: { contains: '\\%@x.test', mode: 'insensitive' } } },
      { student: { email: { equals: '\\%@x.test', mode: 'insensitive' } } },
    ]);
  });
});
