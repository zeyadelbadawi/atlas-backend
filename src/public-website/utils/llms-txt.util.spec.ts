import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  pageFaqs,
  pageSummary,
  type LlmsTxtInput,
} from './llms-txt.util';

const lt = (en: string, ar: string) => ({ en, ar });

const pages = [
  {
    id: 'p-home',
    pageType: 'core',
    coreType: 'home',
    title: 'Home',
    slug: 'home',
    visible: true,
    seo: {},
    sections: [
      {
        type: 'hero',
        config: {
          title: lt('Learn', 'تعلّم'),
          description: lt('Practical courses [with] projects.', 'دورات عملية.'),
        },
      },
    ],
  },
  {
    id: 'p-faqs',
    pageType: 'core',
    coreType: 'faqs',
    title: 'FAQs',
    slug: 'faqs',
    visible: true,
    seo: {},
    sections: [
      { type: 'pageHeader', config: { description: lt('Answers.', 'إجابات.') } },
      {
        type: 'faq',
        config: {
          libraryEntries: [
            {
              id: 'l1',
              question: lt('Is it online?', 'هل هي عبر الإنترنت؟'),
              answer: lt('Yes, fully.', 'نعم.'),
            },
          ],
          items: [
            {
              id: 'i1',
              question: lt('Can I pay later?', 'هل أدفع لاحقًا؟'),
              answer: lt('No.\n# Not a heading', 'لا.'),
            },
            { id: 'i2', question: lt('Is it online?', 'x'), answer: lt('dup', 'dup') },
          ],
        },
      },
    ],
  },
  {
    id: 'p-hidden',
    pageType: 'custom',
    coreType: null,
    title: 'Secret',
    slug: 'secret',
    visible: false,
    seo: {},
    sections: [],
  },
  {
    id: 'p-noindex',
    pageType: 'custom',
    coreType: null,
    title: 'Draft-ish',
    slug: 'noindex',
    visible: true,
    seo: { indexable: false },
    sections: [],
  },
  {
    id: 'p-cd',
    pageType: 'core',
    coreType: 'courseDetails',
    title: 'Course Details',
    slug: 'course-details',
    visible: true,
    seo: {},
    sections: [],
  },
];

const input: LlmsTxtInput = {
  origin: 'https://horizon.example',
  academyName: 'Horizon Academy',
  academyDescription: 'Design courses taught by working designers.',
  contactEmail: 'hello@horizon.example',
  defaultLocale: 'en',
  pages,
  navigation: [{ pageId: 'p-faqs', label: lt('Questions', 'أسئلة') }],
  courses: [
    {
      title: 'UX Foundations',
      slug: 'ux-foundations',
      status: 'published',
      visibility: 'public',
      shortDescription: 'Research and wireframes.',
      description: 'A long description.',
      level: 'beginner',
      pricing: { type: 'paid', amount: 49, currency: 'USD' },
      outcomes: ['Run interviews'],
      requirements: ['None'],
      instructors: [{ name: 'Layla' }],
    },
    { title: 'Draft', slug: 'draft', status: 'draft', visibility: 'public' },
    { title: 'Private', slug: 'private', status: 'published', visibility: 'private' },
    {
      title: 'Free one',
      slug: 'free-one',
      status: 'published',
      visibility: 'public',
      pricing: { type: 'free' },
    },
  ],
  sitemapEnabled: true,
};

describe('buildLlmsTxt', () => {
  const text = buildLlmsTxt(input);

  it('follows the llms.txt shape: H1 name, blockquote summary, H2 link lists, Optional last', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Horizon Academy');
    expect(lines[2]).toBe('> Design courses taught by working designers.');
    const headings = lines.filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '# Horizon Academy',
      '## Pages',
      '## Courses',
      '## Optional',
    ]);
  });

  it('lists visible, indexable pages with absolute URLs, their navigation name and own summary', () => {
    expect(text).toContain(
      '- [Home](https://horizon.example/): Practical courses (with) projects.',
    );
    expect(text).toContain('- [Questions](https://horizon.example/faqs): Answers.');
    expect(text).not.toContain('/secret');
    expect(text).not.toContain('/noindex');
    expect(text).not.toContain('course-details');
  });

  it('lists published public courses only, with their facts', () => {
    expect(text).toContain(
      '- [UX Foundations](https://horizon.example/courses/ux-foundations): Research and wireframes. (Level: beginner · Price: 49 USD)',
    );
    expect(text).toContain(
      '- [Free one](https://horizon.example/courses/free-one): (Price: Free)',
    );
    expect(text).not.toContain('/courses/draft');
    expect(text).not.toContain('/courses/private');
  });

  it('links the other language, the full text and the sitemap under Optional', () => {
    expect(text).toContain(
      '- [Full text of this site for AI assistants](https://horizon.example/llms-full.txt)',
    );
    expect(text).toContain('- [Arabic (العربية) version](https://horizon.example/ar)');
    expect(text).toContain('- [Sitemap](https://horizon.example/sitemap.xml)');
    expect(text).toContain('Contact: email hello@horizon.example.');
  });

  it('on an Arabic-default site, lists Arabic names at the root and English under /en', () => {
    const ar = buildLlmsTxt({ ...input, defaultLocale: 'ar', sitemapEnabled: false });
    expect(ar).toContain('- [الرئيسية](https://horizon.example/): دورات عملية.');
    expect(ar).toContain('- [أسئلة](https://horizon.example/faqs): إجابات.');
    expect(ar).toContain('- [English version](https://horizon.example/en)');
    expect(ar).not.toContain('sitemap.xml');
  });

  it('never lets content open a heading or a link of its own', () => {
    const hostile = buildLlmsTxt({
      ...input,
      academyName: 'Evil\n## Injected',
      courses: [
        {
          title: '[x](https://evil.example)',
          slug: 's',
          status: 'published',
          visibility: 'public',
        },
      ],
    });
    expect(
      hostile.split('\n').filter((line) => line.startsWith('## Injected')),
    ).toHaveLength(0);
    expect(hostile).not.toContain('[x](https://evil.example)');
  });
});

describe('buildLlmsFullTxt', () => {
  const text = buildLlmsFullTxt(input);

  it('carries every FAQ answer once, as H3 question + answer, with markdown neutralised', () => {
    expect(text).toContain('### Is it online?\n\nYes, fully.');
    expect(text).toContain('### Can I pay later?\n\nNo.\n\\# Not a heading');
    expect(text.match(/### Is it online\?/g)).toHaveLength(1);
  });

  it('carries each course in full: URL, facts, instructors, description, outcomes, requirements', () => {
    expect(text).toContain(
      '### UX Foundations\n\nURL: https://horizon.example/courses/ux-foundations',
    );
    expect(text).toContain('Level: beginner · Price: 49 USD');
    expect(text).toContain('Instructors: Layla');
    expect(text).toContain('A long description.');
    expect(text).toContain('What you will learn:\n\n- Run interviews');
    expect(text).toContain('Requirements:\n\n- None');
  });
});

describe('pageSummary / pageFaqs', () => {
  it('prefers the owner’s meta description, then the opening section’s text', () => {
    expect(pageSummary(pages[0], 'en')).toBe('Practical courses [with] projects.');
    expect(
      pageSummary({ ...pages[0], seo: { metaDescription: lt('Own.', 'خاص.') } }, 'ar'),
    ).toBe('خاص.');
  });

  it('cuts to maxItems like the public page', () => {
    const faq = pages[1];
    const limited = {
      ...faq,
      sections: [
        {
          type: 'faq',
          config: { ...(faq.sections[1] as { config: object }).config, maxItems: 1 },
        },
      ],
    };
    expect(pageFaqs(limited, 'en').map((item) => item.question)).toEqual([
      'Is it online?',
    ]);
  });
});
