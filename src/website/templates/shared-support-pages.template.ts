/**
 * The four core pages that are "structurally identical across all five
 * themes by design, varying only in the theme's own visual tokens" (the
 * Bilingual Academy Websites specification, §5) — About, Courses, FAQs,
 * Contact. Every theme template reuses this exact same page/section/
 * starter-content set; only Home (see each theme's own `*.template.ts`)
 * expresses a theme's personality. `courseDetails` has no template — it
 * renders `CourseDetailsTemplate`, never CMS sections (see
 * `WebsitePagesPage.tsx`'s own "locked" treatment of it).
 */
import type { WebsiteTemplatePage } from './website-template.types';
import { lt } from './template-content.util';

export function buildSharedSupportPages(): readonly WebsiteTemplatePage[] {
  return [
    {
      coreType: 'about',
      sections: [
        {
          type: 'about',
          starterContent: {
            title: lt('About {{academyName}}', 'نبذة عن {{academyName}}'),
            body: lt(
              "Welcome to {{academyName}}. We're dedicated to helping our students learn new skills, grow their expertise, and achieve their goals through high-quality courses and expert instruction.",
              'مرحبًا بكم في {{academyName}}. نحن ملتزمون بمساعدة طلابنا على اكتساب مهارات جديدة وتطوير خبراتهم وتحقيق أهدافهم من خلال دورات عالية الجودة وتعليم احترافي.'
            ),
          },
        },
      ],
    },
    {
      coreType: 'courses',
      sections: [
        {
          type: 'featuredCourses',
          dynamicDefaults: { mode: 'latest', layout: 'grid', count: 9, showPrice: true, showInstructor: true },
          starterContent: {
            title: lt('Our Courses', 'دوراتنا'),
            description: lt(
              'Explore our full range of courses and find the right one for you.',
              'استكشف مجموعتنا الكاملة من الدورات واختر الأنسب لك.'
            ),
          },
        },
      ],
    },
    {
      coreType: 'faqs',
      sections: [
        {
          type: 'faq',
          starterContent: {
            title: lt('Frequently Asked Questions', 'الأسئلة الشائعة'),
            items: [
              {
                id: 'faq-enroll',
                question: lt('How do I enroll in a course?', 'كيف يمكنني التسجيل في دورة؟'),
                answer: lt(
                  "Create an account, browse our course catalog, and click enroll on the course you'd like to join.",
                  'أنشئ حسابًا، تصفّح كتالوج الدورات، ثم انقر على زر التسجيل في الدورة التي ترغب بالانضمام إليها.'
                ),
              },
              {
                id: 'faq-experience',
                question: lt('Do I need any prior experience?', 'هل أحتاج إلى خبرة سابقة؟'),
                answer: lt(
                  "Most of our courses are designed for learners of all levels — check each course's own description for specific requirements.",
                  'معظم دوراتنا مصممة لمتعلمين من جميع المستويات، يرجى مراجعة وصف كل دورة للاطلاع على متطلباتها الخاصة.'
                ),
              },
            ],
          },
        },
      ],
    },
    {
      coreType: 'contact',
      sections: [
        {
          type: 'contact',
          dynamicDefaults: { showForm: true },
          starterContent: {
            title: lt('Get in Touch', 'تواصل معنا'),
            description: lt(
              "Have a question? We'd love to hear from you.",
              'هل لديك سؤال؟ يسعدنا التواصل معك.'
            ),
          },
        },
      ],
    },
  ];
}
