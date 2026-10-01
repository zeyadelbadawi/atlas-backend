/**
 * Modern Education (Theme 1) — starter content, template v2.
 *
 * Theme 1 plan §C and §D: the composition the Theme 1 renderers were
 * designed and verified on (Phases 5–6) — Home per §C.1, the inner pages
 * per §C.2–§C.6, each opening with its page hero (§C.0). What changed from
 * v1 (which every Theme 1 Academy created before this version keeps, with
 * nothing rewritten — §D.5):
 *
 *   - Home is the 11-section §C.1 composition; About, Courses, FAQs and
 *     Contact are Theme 1's own pages (Themes 2–5 keep the shared support
 *     pages, `shared-support-pages.template.ts`).
 *   - **Statistics are metric-only** (§D.4): every item resolves a real
 *     number at render time; the template never carries a hand-typed one.
 *   - **Testimonials are samples** (§D.4): three `sample: true` items with
 *     initials avatars, shown in previews with a "Sample" label and never
 *     served publicly until the Owner confirms or replaces them.
 *   - **Theme images** are asset references (`assets`), in both modes.
 *   - **CTA intents** (`ctaTargets`) point at the core pages and Sign Up.
 *
 * Copy interpolates only `{{academyName}}` (see `template-content.util.ts`);
 * no counts, names or other Academy facts are baked in.
 */
import type {
  WebsiteTemplateDefinition,
  WebsiteTemplatePage,
  WebsiteTemplateSection,
} from './website-template.types';
import { lt } from './template-content.util';

const asset = (key: string): string => `theme-asset:modern-education/${key}`;

/** Live statistics: the metric only (§D.4) — labels are the one authored part. */
const LIVE_STATISTICS: WebsiteTemplateSection = {
  type: 'statistics',
  dynamicDefaults: {
    items: [
      {
        id: 'stat-courses',
        metric: 'courses',
        value: lt(''),
        label: lt('Courses', 'دورة'),
      },
      {
        id: 'stat-students',
        metric: 'students',
        value: lt(''),
        label: lt('Learners', 'متعلّم'),
      },
      {
        id: 'stat-instructors',
        metric: 'instructors',
        value: lt(''),
        label: lt('Instructors', 'مدرّب'),
      },
    ],
  },
  starterContent: {
    title: lt('{{academyName}} in numbers', '{{academyName}} بالأرقام'),
  },
};

/** The FAQs page's questions; Home and Contact show the first few as a teaser. */
const FAQ_ITEMS = [
  {
    id: 'faq-experience',
    question: lt('Do I need any experience to start?', 'هل أحتاج إلى خبرة سابقة للبدء؟'),
    answer: lt(
      'No. Each course lists what you need before you start, and most begin with the basics.',
      'لا. تذكر كل دورة ما تحتاجه قبل البدء، وتبدأ معظمها من الأساسيات.',
    ),
  },
  {
    id: 'faq-access',
    question: lt('How long do I have access to a course?', 'ما مدة وصولي إلى الدورة؟'),
    answer: lt(
      'Once you enrol you can learn at your own pace and come back to the lessons whenever you need them.',
      'بعد التسجيل يمكنك التعلّم بالسرعة التي تناسبك والعودة إلى الدروس متى احتجت إليها.',
    ),
  },
  {
    id: 'faq-phone',
    question: lt('Can I learn on my phone?', 'هل يمكنني التعلّم من هاتفي؟'),
    answer: lt(
      'Yes. Lessons work on phones, tablets and computers, and your progress is saved everywhere.',
      'نعم. تعمل الدروس على الهواتف والأجهزة اللوحية والحواسيب، ويُحفظ تقدّمك في كل مكان.',
    ),
  },
  {
    id: 'faq-help',
    question: lt(
      'How do I get help if I am stuck?',
      'كيف أحصل على المساعدة إذا واجهتني صعوبة؟',
    ),
    answer: lt(
      'Send your question through the course or contact us, and an instructor will get back to you.',
      'أرسل سؤالك عبر الدورة أو تواصل معنا، وسيعود إليك أحد المدرّبين.',
    ),
  },
  {
    id: 'faq-free',
    question: lt('Do you offer free courses?', 'هل تقدّمون دورات مجانية؟'),
    answer: lt(
      'Some courses are free. Look for the "Free" label in the catalog.',
      'بعض الدورات مجانية. ابحث عن علامة «مجاني» في قائمة الدورات.',
    ),
  },
  {
    id: 'faq-preview',
    question: lt(
      'Can I preview a course before enrolling?',
      'هل يمكنني معاينة الدورة قبل التسجيل؟',
    ),
    answer: lt(
      'Many courses include free preview lessons. Open a course and look for "Preview" in its content.',
      'تتضمّن دورات كثيرة دروس معاينة مجانية. افتح الدورة وابحث عن «معاينة» في محتواها.',
    ),
  },
  {
    id: 'faq-pay',
    question: lt('How do I pay for a course?', 'كيف أدفع ثمن الدورة؟'),
    answer: lt(
      'Create your account, open the course and choose Buy. You can pay securely online.',
      'أنشئ حسابك، ثم افتح الدورة واختر «شراء». يمكنك الدفع بأمان عبر الإنترنت.',
    ),
  },
  {
    id: 'faq-team',
    question: lt('Can my company enrol a team?', 'هل يمكن لشركتي تسجيل فريق؟'),
    answer: lt(
      'Yes. Contact us with the size of your team and the courses you are interested in.',
      'نعم. تواصل معنا واذكر عدد أفراد فريقك والدورات التي تهمّكم.',
    ),
  },
] as const;

const home: WebsiteTemplatePage = {
  coreType: 'home',
  sections: [
    // §C.1 #1 — the promise and the first action.
    {
      type: 'hero',
      ctaTargets: { cta: 'courses', secondaryCta: 'contact' },
      dynamicDefaults: { showSearch: true },
      assets: { image: asset('home-hero') },
      starterContent: {
        eyebrow: lt('Enrolment is open', 'التسجيل مفتوح الآن'),
        title: lt(
          'Learn the skills that move your career forward',
          'تعلّم المهارات التي تدفع مسيرتك المهنية إلى الأمام',
        ),
        highlight: lt('move your career forward', 'تدفع مسيرتك المهنية'),
        description: lt(
          'Practical, expert-led courses you can take at your own pace, with real projects and support whenever you need it.',
          'دورات عملية يقدّمها خبراء، تتعلّم فيها بالسرعة التي تناسبك، مع مشاريع حقيقية ودعم متى احتجت إليه.',
        ),
        cta: { label: lt('Explore courses', 'استكشف الدورات') },
        secondaryCta: { label: lt('Talk to us', 'تحدّث إلينا') },
        highlights: [
          {
            id: 'hl-projects',
            label: lt('Project-based learning', 'تعلّم قائم على المشاريع'),
          },
          {
            id: 'hl-pace',
            label: lt('Learn at your own pace', 'تعلّم بالسرعة التي تناسبك'),
          },
          {
            id: 'hl-support',
            label: lt('Support from real instructors', 'دعم من مدرّبين حقيقيين'),
          },
        ],
      },
    },
    // §C.1 #2 — highlights band.
    {
      type: 'features',
      dynamicDefaults: { layout: 'strip' },
      starterContent: {
        title: lt('Why learners choose us', 'لماذا يختارنا المتعلّمون'),
        items: [
          {
            id: 'feature-experts',
            icon: 'GraduationCap',
            title: lt('Expert instructors', 'مدرّبون خبراء'),
            description: lt(
              'Taught by people who do the work every day.',
              'يقدّمها أشخاص يمارسون العمل كل يوم.',
            ),
          },
          {
            id: 'feature-flexible',
            icon: 'Clock',
            title: lt('Flexible schedule', 'جدول مرن'),
            description: lt(
              'Start any time and learn around your week.',
              'ابدأ في أي وقت وتعلّم بما يناسب أسبوعك.',
            ),
          },
          {
            id: 'feature-projects',
            icon: 'BookOpen',
            title: lt('Hands-on projects', 'مشاريع تطبيقية'),
            description: lt(
              'Every course ends with work you can show.',
              'تنتهي كل دورة بعمل يمكنك عرضه.',
            ),
          },
          {
            id: 'feature-support',
            icon: 'Headphones',
            title: lt('Real support', 'دعم حقيقي'),
            description: lt(
              'Questions answered by the instructor.',
              'يجيب المدرّب عن أسئلتك بنفسه.',
            ),
          },
        ],
      },
    },
    // §C.1 #3 — live categories (hidden publicly with fewer than two).
    {
      type: 'courseCategories',
      dynamicDefaults: { maxItems: 8, showCounts: true },
      starterContent: {
        title: lt('Explore by category', 'استكشف حسب التصنيف'),
        description: lt(
          'Find the right place to start, whatever you want to learn.',
          'اعثر على نقطة البداية المناسبة، أيًّا كان ما تريد تعلّمه.',
        ),
      },
    },
    // §C.1 #4 — live courses ("Courses launching soon" when there are none).
    {
      type: 'featuredCourses',
      dynamicDefaults: {
        mode: 'latest',
        layout: 'grid',
        count: 6,
        showPrice: true,
        showInstructor: true,
      },
      starterContent: {
        title: lt('Featured courses', 'دورات مميّزة'),
        description: lt(
          'Popular courses our learners recommend.',
          'دورات يوصي بها متعلّمونا.',
        ),
      },
    },
    // §C.1 #5 — differentiation.
    {
      type: 'featureSplit',
      ctaTargets: { cta: 'about' },
      dynamicDefaults: { imagePosition: 'start' },
      assets: { image: asset('home-benefit') },
      starterContent: {
        eyebrow: lt('Why {{academyName}}', 'لماذا {{academyName}}'),
        title: lt(
          'Learning designed around real progress',
          'تعلّم مصمَّم حول تقدّم حقيقي',
        ),
        description: lt(
          'Every course is built to take you from the basics to confident, practical work, one clear step at a time.',
          'صُمّمت كل دورة لتنقلك من الأساسيات إلى عمل عملي بثقة، خطوة واضحة تلو الأخرى.',
        ),
        items: [
          {
            id: 'benefit-paths',
            title: lt('Clear learning paths', 'مسارات تعلّم واضحة'),
            description: lt(
              'Know exactly what to learn next and why it matters.',
              'اعرف تمامًا ما ستتعلّمه لاحقًا ولماذا يهمّ.',
            ),
          },
          {
            id: 'benefit-feedback',
            title: lt('Feedback on your work', 'ملاحظات على عملك'),
            description: lt(
              'Instructors review your projects and help you improve.',
              'يراجع المدرّبون مشاريعك ويساعدونك على التحسّن.',
            ),
          },
          {
            id: 'benefit-skills',
            title: lt('Skills you can use', 'مهارات تستخدمها فعلًا'),
            description: lt(
              'Courses focus on what you will do at work, not just theory.',
              'تركّز الدورات على ما ستفعله في العمل، لا على النظرية فقط.',
            ),
          },
        ],
        cta: { label: lt('About us', 'تعرّف علينا') },
      },
    },
    // §C.1 #6 — how it works.
    {
      type: 'steps',
      starterContent: {
        title: lt('How it works', 'كيف يعمل'),
        description: lt(
          'Getting started takes a few minutes.',
          'البدء لا يستغرق سوى دقائق.',
        ),
        items: [
          {
            id: 'step-choose',
            title: lt('Choose a course', 'اختر دورة'),
            description: lt(
              'Browse the catalog and pick the course that fits your goal.',
              'تصفّح الدورات واختر ما يناسب هدفك.',
            ),
          },
          {
            id: 'step-learn',
            title: lt('Learn at your pace', 'تعلّم بالسرعة التي تناسبك'),
            description: lt(
              'Watch short lessons and practise with guided exercises.',
              'شاهد دروسًا قصيرة وتدرّب عبر تمارين موجّهة.',
            ),
          },
          {
            id: 'step-apply',
            title: lt('Apply what you learn', 'طبّق ما تعلّمته'),
            description: lt(
              'Finish with a project that shows your new skills.',
              'اختتم بمشروع يُظهر مهاراتك الجديدة.',
            ),
          },
        ],
      },
    },
    // §C.1 #7 — live instructors (hidden publicly when there are none).
    {
      type: 'instructors',
      dynamicDefaults: { count: 4 },
      starterContent: {
        title: lt('Meet your instructors', 'تعرّف على مدرّبيك'),
        description: lt(
          'Practitioners who love teaching what they do.',
          'ممارسون يحبّون تعليم ما يتقنونه.',
        ),
      },
    },
    // §C.1 #8 — live numbers (zeros hidden; hidden with fewer than two).
    LIVE_STATISTICS,
    // §C.1 #9 — sample testimonials (§D.4): preview only until confirmed.
    {
      type: 'testimonials',
      starterContent: {
        title: lt('What our learners say', 'ماذا يقول متعلّمونا'),
        items: [
          {
            id: 'sample-testimonial-1',
            sample: true,
            authorName: 'Sara M.',
            authorRole: lt('Product designer', 'مصمّمة منتجات'),
            quote: lt(
              'The projects were close to real work, and the feedback on each one helped me put together a portfolio I was proud to share.',
              'كانت المشاريع قريبة من العمل الحقيقي، وساعدتني الملاحظات على كل مشروع في بناء ملف أعمال أفخر بمشاركته.',
            ),
            rating: 5,
          },
          {
            id: 'sample-testimonial-2',
            sample: true,
            authorName: 'James W.',
            authorRole: lt('Operations lead', 'قائد عمليات'),
            quote: lt(
              'I could fit the lessons around a full-time job. Short videos, clear exercises and instructors who actually answered.',
              'استطعت أن أوفّق بين الدروس ووظيفتي بدوام كامل. فيديوهات قصيرة وتمارين واضحة ومدرّبون يجيبون فعلًا.',
            ),
            rating: 5,
          },
          {
            id: 'sample-testimonial-3',
            sample: true,
            authorName: 'Nour H.',
            authorRole: lt('Data analyst', 'محلّلة بيانات'),
            quote: lt(
              'The step-by-step structure made a difficult subject approachable. I use what I learned every week.',
              'جعل التدرّج خطوة بخطوة الموضوعَ الصعب في المتناول. أستخدم ما تعلّمته كل أسبوع.',
            ),
            rating: 4,
          },
        ],
      },
    },
    // §C.1 #10 — FAQ teaser.
    {
      type: 'faq',
      ctaTargets: { cta: 'faqs' },
      dynamicDefaults: { maxItems: 4 },
      starterContent: {
        title: lt('Questions, answered', 'إجابات عن أسئلتك'),
        items: FAQ_ITEMS.slice(0, 4),
        cta: { label: lt('See all questions', 'عرض كل الأسئلة') },
      },
    },
    // §C.1 #11 — the final action.
    {
      type: 'cta',
      ctaTargets: { cta: 'signUp', secondaryCta: 'courses' },
      assets: { image: asset('home-cta') },
      starterContent: {
        title: lt('Start learning today', 'ابدأ التعلّم اليوم'),
        description: lt(
          'Create your free account and take the first step toward your next skill.',
          'أنشئ حسابك المجاني وخُذ الخطوة الأولى نحو مهارتك التالية.',
        ),
        cta: { label: lt('Create your free account', 'أنشئ حسابك المجاني') },
        secondaryCta: { label: lt('Browse courses', 'تصفّح الدورات') },
      },
    },
  ],
};

/** §C.4 — About: the premium hero leading into the story. */
const about: WebsiteTemplatePage = {
  coreType: 'about',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'none' },
      assets: { image: asset('about-header') },
      starterContent: {
        eyebrow: lt('About {{academyName}}', 'عن {{academyName}}'),
        title: lt(
          'We help people learn the skills that open new doors',
          'نساعد الناس على تعلّم المهارات التي تفتح أبوابًا جديدة',
        ),
        description: lt(
          '{{academyName}} brings practical, expert-led learning to anyone ready to grow — at their own pace, with real support along the way.',
          'تقدّم {{academyName}} تعلّمًا عمليًا يقوده خبراء لكل من يستعدّ للنمو، بالسرعة التي تناسبه ومع دعم حقيقي على طول الطريق.',
        ),
      },
    },
    {
      type: 'featureSplit',
      dynamicDefaults: { imagePosition: 'start' },
      assets: { image: asset('about-story') },
      starterContent: {
        eyebrow: lt('Our story', 'قصّتنا'),
        title: lt(
          'Started by practitioners who love to teach',
          'بدأها ممارسون يحبّون التعليم',
        ),
        description: lt(
          'We began with a simple idea: the best way to learn a skill is from people who use it every day. Today our instructors bring that same practical focus to every course.',
          'بدأنا بفكرة بسيطة: أفضل طريقة لتعلّم مهارة هي من أشخاص يستخدمونها كل يوم. واليوم يحمل مدرّبونا هذا التركيز العملي نفسه إلى كل دورة.',
        ),
        items: [
          {
            id: 'story-practice',
            title: lt('Built on real practice', 'قائمة على الممارسة الفعلية'),
            description: lt(
              'Every lesson comes from work our instructors do.',
              'كل درس مأخوذ من عمل يؤديه مدرّبونا.',
            ),
          },
          {
            id: 'story-learners',
            title: lt('Designed around learners', 'مصمَّمة حول المتعلّمين'),
            description: lt(
              'Short lessons, clear projects and honest feedback.',
              'دروس قصيرة ومشاريع واضحة وملاحظات صادقة.',
            ),
          },
          {
            id: 'story-community',
            title: lt('Growing with our community', 'ننمو مع مجتمعنا'),
            description: lt(
              'New courses follow what our learners ask for.',
              'تتبع الدورات الجديدة ما يطلبه متعلّمونا.',
            ),
          },
        ],
      },
    },
    {
      type: 'features',
      starterContent: {
        title: lt('What we value', 'ما نؤمن به'),
        description: lt(
          'The principles behind every course we make.',
          'المبادئ التي تقوم عليها كل دورة نقدّمها.',
        ),
        items: [
          {
            id: 'value-quality',
            icon: 'Award',
            title: lt('Quality first', 'الجودة أولًا'),
            description: lt(
              'We would rather publish fewer courses that truly teach.',
              'نفضّل نشر دورات أقل تُعلّم حقًا.',
            ),
          },
          {
            id: 'value-together',
            icon: 'Users',
            title: lt('Learning together', 'نتعلّم معًا'),
            description: lt(
              'Questions are welcome, and nobody learns alone.',
              'الأسئلة مرحّب بها، ولا أحد يتعلّم وحده.',
            ),
          },
          {
            id: 'value-outcomes',
            icon: 'Sparkles',
            title: lt('Practical outcomes', 'نتائج عملية'),
            description: lt(
              'You finish every course able to do something new.',
              'تُنهي كل دورة وأنت قادر على فعل شيء جديد.',
            ),
          },
        ],
      },
    },
    LIVE_STATISTICS,
    {
      type: 'instructors',
      dynamicDefaults: { count: 8 },
      starterContent: {
        title: lt('Meet the team', 'تعرّف على الفريق'),
        description: lt(
          'The instructors behind our courses.',
          'المدرّبون الذين يقفون خلف دوراتنا.',
        ),
      },
    },
    {
      type: 'gallery',
      assets: {
        images: [1, 2, 3, 4, 5].map((n) => ({
          id: `gallery-${n}`,
          image: asset(`gallery-${n}`),
        })),
      },
      starterContent: {
        title: lt('Life at {{academyName}}', 'الحياة في {{academyName}}'),
      },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'courses', secondaryCta: 'contact' },
      starterContent: {
        title: lt('Learn with us', 'تعلّم معنا'),
        description: lt(
          'Find a course that fits your goals and start today.',
          'اعثر على دورة تناسب أهدافك وابدأ اليوم.',
        ),
        cta: { label: lt('Browse courses', 'تصفّح الدورات') },
        secondaryCta: { label: lt('Contact us', 'تواصل معنا') },
      },
    },
  ],
};

/** §C.2 — Courses: the catalog hero's search drives the catalog below it. */
const courses: WebsiteTemplatePage = {
  coreType: 'courses',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'courses' },
      starterContent: {
        eyebrow: lt('Courses', 'الدورات'),
        title: lt('Find your next course', 'اعثر على دورتك التالية'),
        description: lt(
          'Practical courses taught by experienced instructors. Search, filter by category and level, and start learning today.',
          'دورات عملية يقدّمها مدرّبون ذوو خبرة. ابحث وصفِّ حسب التصنيف والمستوى، وابدأ التعلّم اليوم.',
        ),
      },
    },
    {
      type: 'courseCatalog',
      dynamicDefaults: {
        pageSize: 9,
        defaultSort: 'newest',
        showSearch: false,
        showLevelFilter: true,
        showPricingFilter: true,
        showSort: true,
      },
      starterContent: { title: lt('All courses', 'كل الدورات') },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt('Not sure where to start?', 'لا تعرف من أين تبدأ؟'),
        description: lt(
          'Tell us what you want to learn and we will point you to the right course.',
          'أخبرنا بما تريد تعلّمه وسنرشدك إلى الدورة المناسبة.',
        ),
        cta: { label: lt('Talk to us', 'تحدّث إلينا') },
      },
    },
  ],
};

/** §C.5 — FAQs: the hero's filter narrows the questions below. */
const faqs: WebsiteTemplatePage = {
  coreType: 'faqs',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'faq' },
      starterContent: {
        eyebrow: lt('Help centre', 'مركز المساعدة'),
        title: lt('Frequently asked questions', 'الأسئلة الشائعة'),
        description: lt(
          'Answers to the questions learners ask us most.',
          'إجابات عن الأسئلة التي يطرحها المتعلّمون علينا أكثر من غيرها.',
        ),
      },
    },
    { type: 'faq', starterContent: { items: FAQ_ITEMS } },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt('Still have a question?', 'هل لديك سؤال آخر؟'),
        description: lt(
          'Our team is happy to help — send us a message.',
          'يسعد فريقنا بمساعدتك، أرسل لنا رسالة.',
        ),
        cta: { label: lt('Contact us', 'تواصل معنا') },
      },
    },
  ],
};

/** §C.6 — Contact: methods from the Academy's own data, the form, quick answers. */
const contact: WebsiteTemplatePage = {
  coreType: 'contact',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'none' },
      starterContent: {
        eyebrow: lt('Contact', 'تواصل معنا'),
        title: lt("We'd love to hear from you", 'يسعدنا أن نسمع منك'),
        description: lt(
          'Questions about a course, enrolling a team or anything else — send us a message and we will get back to you.',
          'أسئلة عن دورة أو تسجيل فريق أو أي أمر آخر؟ أرسل لنا رسالة وسنعود إليك.',
        ),
      },
    },
    {
      type: 'contact',
      dynamicDefaults: { showForm: true },
      starterContent: {
        title: lt('Get in touch', 'تواصل معنا'),
        description: lt(
          'Reach us directly, or use the form and we will reply by email.',
          'تواصل معنا مباشرة، أو استخدم النموذج وسنردّ عليك عبر البريد الإلكتروني.',
        ),
      },
    },
    {
      type: 'faq',
      ctaTargets: { cta: 'faqs' },
      dynamicDefaults: { maxItems: 3 },
      starterContent: {
        title: lt('Quick answers', 'إجابات سريعة'),
        items: FAQ_ITEMS.slice(0, 5),
        cta: { label: lt('See all questions', 'عرض كل الأسئلة') },
      },
    },
  ],
};

export const modernEducationTemplate: WebsiteTemplateDefinition = {
  themeKey: 'modern-education',
  version: 2,
  pages: [home, about, courses, faqs, contact],
};
