/**
 * Premium Academy — elegant, selective template.
 *
 * Matches `premium-academy.theme.ts`'s documented personality (upscale,
 * editorial-luxury, spacious) with the sparsest Home composition after
 * Minimal Editorial — a premium brand doesn't crowd its homepage. See the
 * Bilingual Academy Websites specification, §5.
 */
import type { WebsiteTemplateDefinition } from './website-template.types';
import { lt } from './template-content.util';
import { buildSharedSupportPages } from './shared-support-pages.template';

export const premiumAcademyTemplate: WebsiteTemplateDefinition = {
  themeKey: 'premium-academy',
  pages: [
    {
      coreType: 'home',
      sections: [
        {
          type: 'hero',
          ctaTargets: { cta: 'courses' },
          starterContent: {
            eyebrow: lt('{{academyName}}', '{{academyName}}'),
            title: lt('Elevate Your Craft', 'ارتقِ بحرفتك'),
            description: lt(
              'A refined learning experience for those who expect more — thoughtfully designed courses, taught by instructors at the top of their field.',
              'تجربة تعلّم راقية لمن يتوقعون الأفضل — دورات مصمّمة بعناية، يقدّمها مدرّبون في صدارة مجالهم.'
            ),
            cta: { label: lt('Explore Courses', 'اكتشف الدورات') },
          },
        },
        {
          type: 'about',
          starterContent: {
            title: lt('The {{academyName}} Standard', 'معيار {{academyName}}'),
            body: lt(
              'Every course we offer is held to the same standard: real expertise, genuine craftsmanship, and an experience worth your time. We believe premium learning should feel like it.',
              'تخضع كل دورة نقدّمها لنفس المعيار: خبرة حقيقية، وإتقان أصيل، وتجربة تستحق وقتك. نؤمن بأن التعلّم الراقي يجب أن يكون كذلك فعلاً.'
            ),
          },
        },
        {
          type: 'featuredCourses',
          dynamicDefaults: { mode: 'latest', layout: 'grid', count: 3, showPrice: true, showInstructor: true },
          starterContent: {
            title: lt('Signature Courses', 'دورات مختارة'),
          },
        },
        {
          type: 'testimonials',
          starterContent: {
            title: lt('In Their Words', 'بكلماتهم'),
          },
        },
        {
          type: 'cta',
          ctaTargets: { cta: 'signUp' },
          starterContent: {
            title: lt('Begin Your Journey', 'ابدأ رحلتك'),
            description: lt('Join {{academyName}} and experience learning done right.', 'انضم إلى {{academyName}} واختبر تعلّمًا كما ينبغي أن يكون.'),
            cta: { label: lt('Join Now', 'انضم الآن') },
          },
        },
      ],
    },
    ...buildSharedSupportPages(),
  ],
};
