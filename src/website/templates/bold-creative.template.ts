/**
 * Bold Creative — expressive, visual template.
 *
 * Matches `bold-creative.theme.ts`'s documented personality ("for
 * creative/vocational academies that want to stand out") by leaning on
 * the two most visual, personality-driven section types — Gallery and
 * Testimonials — alongside the conventional core. See the Bilingual
 * Academy Websites specification, §5.
 */
import type { WebsiteTemplateDefinition } from './website-template.types';
import { lt } from './template-content.util';
import { buildSharedSupportPages } from './shared-support-pages.template';

export const boldCreativeTemplate: WebsiteTemplateDefinition = {
  themeKey: 'bold-creative',
  pages: [
    {
      coreType: 'home',
      sections: [
        {
          type: 'hero',
          ctaTargets: { cta: 'courses' },
          starterContent: {
            eyebrow: lt('Make Something Real', 'اصنع شيئًا حقيقيًا'),
            title: lt(
              'Create, Build, and Stand Out at {{academyName}}',
              'أبدع وابنِ وتميّز مع {{academyName}}',
            ),
            description: lt(
              'Hands-on courses for makers, designers, and creators who want more than theory.',
              'دورات عملية للمبدعين والمصممين وصنّاع المحتوى الذين يبحثون عن أكثر من مجرد النظرية.',
            ),
            cta: { label: lt('See What You Can Learn', 'اكتشف ما يمكنك تعلّمه') },
          },
        },
        {
          type: 'about',
          starterContent: {
            title: lt('Learn by Doing', 'تعلّم من خلال الممارسة'),
            body: lt(
              'At {{academyName}}, every course is built around making real things — not just watching, but doing. That’s how skills that actually stick get built.',
              'في {{academyName}}، كل دورة مبنية حول صنع أشياء حقيقية — ليس فقط المشاهدة، بل الممارسة الفعلية. هكذا تُبنى المهارات التي تدوم.',
            ),
          },
        },
        {
          type: 'featuredCourses',
          dynamicDefaults: {
            mode: 'latest',
            layout: 'carousel',
            count: 4,
            showPrice: true,
            showInstructor: true,
          },
          starterContent: {
            title: lt('Start Creating', 'ابدأ الإبداع'),
          },
        },
        {
          type: 'gallery',
          starterContent: {
            title: lt('From Our Students', 'من إبداع طلابنا'),
            images: [],
          },
        },
        {
          type: 'testimonials',
          starterContent: {
            title: lt('Real Work, Real Voices', 'أعمال حقيقية، أصوات حقيقية'),
          },
        },
        {
          type: 'features',
          starterContent: {
            title: lt('Why Learn With Us', 'لماذا تتعلّم معنا'),
            items: [
              {
                id: 'feature-projects',
                title: lt('Real Projects', 'مشاريع حقيقية'),
                description: lt(
                  'Build a portfolio, not just a certificate.',
                  'ابنِ معرض أعمال، لا مجرد شهادة.',
                ),
                icon: 'Sparkles',
              },
              {
                id: 'feature-creators',
                title: lt('Taught by Creators', 'يُقدَّم من قبل مبدعين'),
                description: lt(
                  'Instructors who make a living doing this work.',
                  'مدرّبون يعملون فعليًا في هذا المجال.',
                ),
                icon: 'Video',
              },
            ],
          },
        },
        {
          type: 'cta',
          ctaTargets: { cta: 'signUp' },
          starterContent: {
            title: lt('Your Next Project Starts Here', 'مشروعك القادم يبدأ من هنا'),
            cta: { label: lt('Join {{academyName}}', 'انضم إلى {{academyName}}') },
          },
        },
      ],
    },
    ...buildSharedSupportPages(),
  ],
};
