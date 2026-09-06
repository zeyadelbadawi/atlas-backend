/**
 * Website Template Registry — one file per theme key, aggregated here.
 * Mirrors the frontend's `website-theme.registry.ts` exactly: "one file
 * per key, a registry aggregates them, adding one never touches another."
 * See `website-template.types.ts` for why this is a second, parallel
 * registry rather than folded into the (frontend-only) theme registry.
 */
import { WEBSITE_THEME_KEYS } from '../constants/website.constants';
import { modernEducationTemplate } from './modern-education.template';
import { premiumAcademyTemplate } from './premium-academy.template';
import { corporateLearningTemplate } from './corporate-learning.template';
import { minimalEditorialTemplate } from './minimal-editorial.template';
import { boldCreativeTemplate } from './bold-creative.template';
import type { WebsiteTemplateDefinition, WebsiteTemplateThemeKey } from './website-template.types';

const WEBSITE_TEMPLATE_REGISTRY: Record<WebsiteTemplateThemeKey, WebsiteTemplateDefinition> = {
  'modern-education': modernEducationTemplate,
  'premium-academy': premiumAcademyTemplate,
  'corporate-learning': corporateLearningTemplate,
  'minimal-editorial': minimalEditorialTemplate,
  'bold-creative': boldCreativeTemplate,
};

export function getWebsiteTemplate(themeKey: WebsiteTemplateThemeKey): WebsiteTemplateDefinition {
  return WEBSITE_TEMPLATE_REGISTRY[themeKey];
}

export function listWebsiteTemplates(): readonly WebsiteTemplateDefinition[] {
  return WEBSITE_THEME_KEYS.map((key) => WEBSITE_TEMPLATE_REGISTRY[key]);
}
