/**
 * Modern Education — general-purpose default template.
 *
 * Matches `modern-education.theme.ts`'s own documented personality
 * ("friendly, approachable, energetic... the default choice for a
 * general-purpose Academy") with the fullest, most conventional Home
 * composition — see the Bilingual Academy Websites specification, §5.
 */
import type { WebsiteTemplateDefinition } from './website-template.types';
import { lt } from './template-content.util';
import { buildSharedSupportPages } from './shared-support-pages.template';

export const modernEducationTemplate: WebsiteTemplateDefinition = {
  themeKey: 'modern-education',
  pages: [
    {
      coreType: 'home',
      sections: [
        {
          type: 'hero',
          ctaTargets: { cta: 'courses' },
          starterContent: {
            eyebrow: lt('Welcome', 'مرحبًا بكم'),
            title: lt(
              'Learn Something New at {{academyName}}',
              'تعلّم شيئًا جديدًا في {{academyName}}',
            ),
            description: lt(
              'Join thousands of learners building real skills through practical, expert-led courses.',
              'انضم إلى آلاف المتعلمين الذين يكتسبون مهارات حقيقية من خلال دورات عملية يقدّمها خبراء.',
            ),
            cta: { label: lt('Browse Courses', 'تصفّح الدورات') },
          },
        },
        {
          type: 'about',
          starterContent: {
            title: lt('Why {{academyName}}', 'لماذا {{academyName}}'),
            body: lt(
              'We believe learning should be practical, engaging, and built around real outcomes. Our courses are designed by experienced instructors who care about your progress every step of the way.',
              'نؤمن بأن التعلّم يجب أن يكون عمليًا وممتعًا ومبنيًا على نتائج حقيقية. تم تصميم دوراتنا من قبل مدرّبين ذوي خبرة يهتمون بتقدّمك في كل خطوة.',
            ),
          },
        },
        {
          type: 'featuredCourses',
          dynamicDefaults: {
            mode: 'latest',
            layout: 'grid',
            count: 3,
            showPrice: true,
            showInstructor: true,
          },
          starterContent: {
            title: lt('Featured Courses', 'دورات مميزة'),
            description: lt(
              'A few of our most popular courses to get you started.',
              'بعض من أكثر دوراتنا شهرة لتبدأ رحلتك.',
            ),
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
                label: lt('Courses', 'دورة'),
              },
              {
                id: 'stat-students',
                metric: 'students',
                value: lt('0'),
                label: lt('Students', 'طالب'),
              },
              {
                id: 'stat-instructors',
                metric: 'instructors',
                value: lt('0'),
                label: lt('Instructors', 'مدرّب'),
              },
            ],
          },
        },
        {
          type: 'features',
          starterContent: {
            title: lt('What You Get', 'ما الذي ستحصل عليه'),
            items: [
              {
                id: 'feature-expert',
                title: lt('Expert Instructors', 'مدرّبون خبراء'),
                description: lt(
                  'Learn from instructors with real, hands-on experience in their field.',
                  'تعلّم من مدرّبين لديهم خبرة عملية حقيقية في مجالهم.',
                ),
                icon: 'GraduationCap',
              },
              {
                id: 'feature-flexible',
                title: lt('Learn at Your Pace', 'تعلّم بالسرعة التي تناسبك'),
                description: lt(
                  'Access your courses anytime and move through the material on your own schedule.',
                  'يمكنك الوصول إلى دوراتك في أي وقت والتقدّم في المحتوى وفق جدولك الخاص.',
                ),
                icon: 'Clock',
              },
              {
                id: 'feature-community',
                title: lt('Supportive Community', 'مجتمع داعم'),
                description: lt(
                  'Join a community of learners working toward the same goals as you.',
                  'انضم إلى مجتمع من المتعلمين يسعون لتحقيق نفس أهدافك.',
                ),
                icon: 'Users',
              },
            ],
          },
        },
        {
          type: 'instructors',
          dynamicDefaults: { count: 4 },
          starterContent: {
            title: lt('Meet Our Instructors', 'تعرّف على مدرّبينا'),
            description: lt('The people behind the courses.', 'الأشخاص وراء دوراتنا.'),
          },
        },
        {
          type: 'testimonials',
          starterContent: {
            title: lt('What Our Students Say', 'ماذا يقول طلابنا'),
          },
        },
        {
          type: 'cta',
          ctaTargets: { cta: 'signUp' },
          starterContent: {
            title: lt('Ready to Start Learning?', 'هل أنت مستعد لبدء التعلّم؟'),
            description: lt(
              'Create your account and enroll in your first course today.',
              'أنشئ حسابك وسجّل في أول دورة لك اليوم.',
            ),
            cta: { label: lt('Get Started', 'ابدأ الآن') },
          },
        },
      ],
    },
    ...buildSharedSupportPages(),
  ],
};
