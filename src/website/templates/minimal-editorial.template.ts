/**
 * Minimal Editorial — restrained, content-first template.
 *
 * Matches `minimal-editorial.theme.ts`'s documented personality ("for
 * academies that want their content to speak for itself") with
 * deliberately the sparsest Home composition — a theme built around
 * restraint should not be generated with the most sections. See the
 * Bilingual Academy Websites specification, §5.
 */
import type { WebsiteTemplateDefinition } from './website-template.types';
import { lt } from './template-content.util';
import { buildSharedSupportPages } from './shared-support-pages.template';

export const minimalEditorialTemplate: WebsiteTemplateDefinition = {
  themeKey: 'minimal-editorial',
  pages: [
    {
      coreType: 'home',
      sections: [
        {
          type: 'hero',
          ctaTargets: { cta: 'courses' },
          starterContent: {
            title: lt('{{academyName}}', '{{academyName}}'),
            description: lt(
              'Courses worth your attention, nothing else.',
              'دورات تستحق اهتمامك، ولا شيء غير ذلك.',
            ),
            cta: { label: lt('View Courses', 'عرض الدورات') },
          },
        },
        {
          type: 'about',
          starterContent: {
            title: lt('About', 'نبذة'),
            body: lt('{{academyName}}.', '{{academyName}}.'),
          },
        },
        {
          type: 'featuredCourses',
          dynamicDefaults: {
            mode: 'latest',
            layout: 'grid',
            count: 4,
            showPrice: true,
            showInstructor: false,
          },
          starterContent: {
            title: lt('Courses', 'الدورات'),
          },
        },
        {
          type: 'cta',
          ctaTargets: { cta: 'signUp' },
          starterContent: {
            title: lt('Start Learning', 'ابدأ التعلّم'),
            cta: { label: lt('Sign Up', 'إنشاء حساب') },
          },
        },
      ],
    },
    ...buildSharedSupportPages(),
  ],
};
