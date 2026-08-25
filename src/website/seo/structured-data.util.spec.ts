import {
  buildBreadcrumbJsonLd,
  buildCourseJsonLd,
  buildOrganizationJsonLd,
} from './structured-data.util';

describe('buildOrganizationJsonLd', () => {
  it('builds a complete, correctly-typed Organization fragment from full input', () => {
    const result = buildOrganizationJsonLd({
      name: 'Acme Academy',
      description: 'We teach things',
      logo: 'https://x/logo.png',
      contactEmail: 'hello@acme.dev',
      contactPhone: '+1-555-0100',
    });
    expect(result).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Acme Academy',
      description: 'We teach things',
      logo: 'https://x/logo.png',
      email: 'hello@acme.dev',
      telephone: '+1-555-0100',
    });
  });

  it('omits optional fields rather than inventing placeholder values when absent', () => {
    const result = buildOrganizationJsonLd({ name: 'Acme Academy' });
    expect(result.name).toBe('Acme Academy');
    expect(result.description).toBeUndefined();
    expect(result.logo).toBeUndefined();
    expect(result.email).toBeUndefined();
    expect(result.telephone).toBeUndefined();
  });

  it('always carries the correct required @context/@type, regardless of input', () => {
    const result = buildOrganizationJsonLd({ name: 'X' });
    expect(result['@context']).toBe('https://schema.org');
    expect(result['@type']).toBe('Organization');
  });

  it('is deterministic for identical input', () => {
    const input = { name: 'Acme Academy', logo: 'https://x/logo.png' };
    expect(buildOrganizationJsonLd(input)).toEqual(buildOrganizationJsonLd(input));
  });
});

describe('buildCourseJsonLd', () => {
  const academy = { name: 'Acme Academy' };

  it("prefers shortDescription over description, matching resolveCourseSeo's own precedence", () => {
    const result = buildCourseJsonLd(
      {
        title: 'Intro to Testing',
        slug: 'intro-to-testing',
        shortDescription: 'Short',
        description: 'Long',
        status: 'published',
        visibility: 'public',
      },
      academy,
    );
    expect(result.description).toBe('Short');
  });

  it('falls back to description when shortDescription is absent', () => {
    const result = buildCourseJsonLd(
      {
        title: 'Intro to Testing',
        slug: 'intro-to-testing',
        description: 'Long',
        status: 'published',
        visibility: 'public',
      },
      academy,
    );
    expect(result.description).toBe('Long');
  });

  it('omits description entirely when the course has neither', () => {
    const result = buildCourseJsonLd(
      { title: 'X', slug: 'x', status: 'draft', visibility: 'private' },
      academy,
    );
    expect(result.description).toBeUndefined();
  });

  it('nests the provider Organization by name, never a duplicated Academy projection', () => {
    const result = buildCourseJsonLd(
      { title: 'X', slug: 'x', status: 'draft', visibility: 'private' },
      academy,
    );
    expect(result.provider).toEqual({ '@type': 'Organization', name: 'Acme Academy' });
  });

  it('carries the correct required @type', () => {
    const result = buildCourseJsonLd(
      { title: 'X', slug: 'x', status: 'draft', visibility: 'private' },
      academy,
    );
    expect(result['@type']).toBe('Course');
  });
});

describe('buildBreadcrumbJsonLd', () => {
  it('builds an empty BreadcrumbList for an empty item list', () => {
    const result = buildBreadcrumbJsonLd([]);
    expect(result.itemListElement).toEqual([]);
    expect(result['@type']).toBe('BreadcrumbList');
  });

  it('assigns 1-based position, in the given order, never re-sorting', () => {
    const result = buildBreadcrumbJsonLd([
      { name: 'Home', path: '/' },
      { name: 'About', path: '/about' },
    ]);
    expect(result.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: '/' },
      { '@type': 'ListItem', position: 2, name: 'About', item: '/about' },
    ]);
  });

  it('is deterministic for identical input', () => {
    const items = [{ name: 'Home', path: '/' }];
    expect(buildBreadcrumbJsonLd(items)).toEqual(buildBreadcrumbJsonLd(items));
  });

  it('never mutates the input array', () => {
    const items = [{ name: 'Home', path: '/' }];
    const copy = [...items];
    buildBreadcrumbJsonLd(items);
    expect(items).toEqual(copy);
  });
});
