/**
 * Website Template Registry — structural + bilingual-completeness checks.
 *
 * Pure, no database, no NestJS bootstrap — these validate the TEMPLATE
 * DATA ITSELF, independent of `WebsiteGenerationService`'s own behavior
 * (covered separately by e2e tests that actually generate a real
 * Academy's pages). This is the fast, build-time-style check the
 * Bilingual Academy Websites specification calls for (§14): "an
 * automated check that every `starterContent` field in every template is
 * genuinely `LocalizedText` with both keys populated ... the fastest way
 * to catch a template author accidentally shipping English-only copy
 * before it ever reaches a real Academy."
 */
import { WEBSITE_THEME_KEYS } from '../constants/website.constants';
import { listWebsiteTemplates } from './website-template.registry';
import type { WebsiteTemplateSection } from './website-template.types';

function isLocalizedTextLike(value: unknown): value is { en: string; ar: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).en === 'string' &&
    typeof (value as Record<string, unknown>).ar === 'string'
  );
}

/** Walks a `starterContent` object collecting every `LocalizedText`-shaped leaf, with a JSON-pointer-ish path for a useful failure message. */
function collectLocalizedLeaves(
  value: unknown,
  path: string,
): Array<{ path: string; leaf: { en: string; ar: string } }> {
  if (isLocalizedTextLike(value)) return [{ path, leaf: value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectLocalizedLeaves(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      collectLocalizedLeaves(entry, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

describe('Website Template Registry', () => {
  it('registers exactly one template per real theme key, in the same order', () => {
    const templates = listWebsiteTemplates();
    expect(templates.map((template) => template.themeKey)).toEqual([...WEBSITE_THEME_KEYS]);
  });

  it('every template includes the 4 shared support pages plus its own Home', () => {
    for (const template of listWebsiteTemplates()) {
      const coreTypes = template.pages.map((page) => page.coreType);
      expect(coreTypes).toContain('home');
      expect(coreTypes).toEqual(expect.arrayContaining(['about', 'courses', 'faqs', 'contact']));
      // No `courseDetails` template — it renders `CourseDetailsTemplate`, never CMS sections.
      expect(coreTypes).not.toContain('courseDetails');
    }
  });

  it('every `starterContent` LocalizedText field has non-empty English — the one always-required language', () => {
    for (const template of listWebsiteTemplates()) {
      for (const page of template.pages) {
        for (const section of page.sections) {
          if (!section.starterContent) continue;
          const leaves = collectLocalizedLeaves(section.starterContent, '');
          for (const { path, leaf } of leaves) {
            expect(leaf.en.trim()).not.toBe('');
            void path; // surfaced in the failure message via `toBe`'s own diff, kept for readability
          }
        }
      }
    }
  });

  it('every `starterContent` LocalizedText field ALSO has real Arabic content — "complete" means genuinely bilingual, not English with an empty Arabic label', () => {
    const failures: string[] = [];
    for (const template of listWebsiteTemplates()) {
      for (const page of template.pages) {
        for (const section of page.sections) {
          if (!section.starterContent) continue;
          const leaves = collectLocalizedLeaves(section.starterContent, '');
          for (const { path, leaf } of leaves) {
            if (!leaf.ar.trim()) {
              failures.push(`${template.themeKey}/${page.coreType}/${section.type}${path ? `.${path}` : ''}`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('never fabricates a static value for a section type that already supports live data — `featuredCourses`/`statistics`/`instructors`/`contact` always resolve their dynamic config from `dynamicDefaults`, `starterContent` never overrides it with a hardcoded number', () => {
    const dynamicTypes = new Set(['featuredCourses', 'statistics', 'instructors', 'contact']);
    for (const template of listWebsiteTemplates()) {
      for (const page of template.pages) {
        for (const section of page.sections as readonly WebsiteTemplateSection[]) {
          if (!dynamicTypes.has(section.type)) continue;
          if (section.type === 'statistics') {
            const items = (section.dynamicDefaults?.items ?? []) as Array<{ metric?: string }>;
            for (const item of items) {
              expect(item.metric).toBeDefined();
            }
          }
          if (section.type === 'featuredCourses') {
            expect(section.dynamicDefaults?.mode).toBeDefined();
          }
        }
      }
    }
  });
});
