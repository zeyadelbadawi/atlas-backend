/**
 * Corporate Learning — enterprise, credibility-forward template.
 *
 * Matches `corporate-learning.theme.ts`'s documented personality ("built
 * for B2B training providers and enterprise academies") by leading with
 * scale/credibility signals (statistics, instructor credentials) and a
 * dense features section. See the Bilingual Academy Websites
 * specification, §5.
 */
import type { WebsiteTemplateDefinition } from './website-template.types';
import { lt } from './template-content.util';
import { buildSharedSupportPages } from './shared-support-pages.template';

export const corporateLearningTemplate: WebsiteTemplateDefinition = {
  themeKey: 'corporate-learning',
  pages: [
    {
      coreType: 'home',
      sections: [
        {
          type: 'hero',
          ctaTargets: { cta: 'contact' },
          starterContent: {
            eyebrow: lt('Corporate Training', 'التدريب المؤسسي'),
            title: lt(
              'Workforce Training That Delivers Results',
              'تدريب للموظفين يحقق نتائج ملموسة',
            ),
            description: lt(
              '{{academyName}} partners with organizations to build the skills their teams need to perform — structured, measurable, and built for scale.',
              'تتعاون {{academyName}} مع المؤسسات لبناء المهارات التي تحتاجها فرقها للأداء بكفاءة — بشكل منظم وقابل للقياس ومصمم للتوسّع.',
            ),
            cta: { label: lt('Talk to Us', 'تواصل معنا') },
          },
        },
        {
          type: 'statistics',
          dynamicDefaults: {
            items: [
              {
                id: 'stat-courses',
                metric: 'courses',
                value: lt('0'),
                label: lt('Training Programs', 'برنامج تدريبي'),
              },
              {
                id: 'stat-students',
                metric: 'students',
                value: lt('0'),
                label: lt('Professionals Trained', 'محترف تم تدريبه'),
              },
              {
                id: 'stat-instructors',
                metric: 'instructors',
                value: lt('0'),
                label: lt('Expert Instructors', 'مدرّب خبير'),
              },
            ],
          },
        },
        {
          type: 'features',
          starterContent: {
            title: lt('Built for Organizations', 'مصمم للمؤسسات'),
            items: [
              {
                id: 'feature-structured',
                title: lt('Structured Curriculum', 'منهج منظم'),
                description: lt(
                  'Clear learning paths mapped to real job competencies.',
                  'مسارات تعليمية واضحة مرتبطة بكفاءات وظيفية حقيقية.',
                ),
                icon: 'ShieldCheck',
              },
              {
                id: 'feature-scale',
                title: lt('Built to Scale', 'قابل للتوسّع'),
                description: lt(
                  'From a single team to your entire organization.',
                  'من فريق واحد إلى مؤسستك بأكملها.',
                ),
                icon: 'Globe',
              },
              {
                id: 'feature-tracking',
                title: lt('Progress You Can Track', 'تقدّم يمكن قياسه'),
                description: lt(
                  'Visibility into completion and performance across your teams.',
                  'رؤية واضحة لمعدلات الإنجاز والأداء عبر فرقك.',
                ),
                icon: 'Award',
              },
            ],
          },
        },
        {
          type: 'featuredCourses',
          dynamicDefaults: {
            mode: 'latest',
            layout: 'grid',
            count: 3,
            showPrice: false,
            showInstructor: true,
          },
          starterContent: {
            title: lt('Training Programs', 'برامج تدريبية'),
          },
        },
        {
          type: 'instructors',
          dynamicDefaults: { count: 4 },
          starterContent: {
            title: lt('Our Training Team', 'فريق التدريب لدينا'),
          },
        },
        {
          type: 'faq',
          starterContent: {
            title: lt('Common Questions', 'أسئلة شائعة'),
            items: [
              {
                id: 'faq-teams',
                question: lt(
                  'Can we enroll an entire team?',
                  'هل يمكننا تسجيل فريق كامل؟',
                ),
                answer: lt(
                  'Yes — contact us and we’ll help set up training for your team or organization.',
                  'نعم، تواصل معنا وسنساعدك في إعداد التدريب لفريقك أو مؤسستك.',
                ),
              },
            ],
          },
        },
        {
          type: 'cta',
          ctaTargets: { cta: 'contact' },
          starterContent: {
            title: lt('Ready to Train Your Team?', 'هل أنت مستعد لتدريب فريقك؟'),
            description: lt(
              'Get in touch to discuss your organization’s training needs.',
              'تواصل معنا لمناقشة احتياجات التدريب في مؤسستك.',
            ),
            cta: { label: lt('Contact Us', 'تواصل معنا') },
          },
        },
      ],
    },
    ...buildSharedSupportPages(),
  ],
};
