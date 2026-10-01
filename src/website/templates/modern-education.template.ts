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
 * no counts, names or other Academy facts are baked in. Nor does it assert
 * anything a given Academy may not offer — free courses, preview lessons,
 * response times, open enrolment, projects/feedback, career outcomes: the
 * Owner adds those claims if they are true (the spec bans the old phrases).
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
      'It depends on the course. Each course page describes its level and what you need before you start.',
      'يعتمد ذلك على الدورة. تصف صفحة كل دورة مستواها وما تحتاجه قبل البدء.',
    ),
  },
  {
    id: 'faq-access',
    question: lt('How long do I have access to a course?', 'ما مدة وصولي إلى الدورة؟'),
    answer: lt(
      'It depends on the course. Check the course details, or contact us if you are not sure.',
      'يختلف ذلك من دورة إلى أخرى. راجع تفاصيل الدورة، أو تواصل معنا إذا لم تكن متأكدًا.',
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
      'Contact us using the details on our Contact page, and mention the course and lesson you are working on.',
      'تواصل معنا عبر بيانات التواصل في صفحة «تواصل معنا»، واذكر الدورة والدرس اللذين تعمل عليهما.',
    ),
  },
  {
    id: 'faq-free',
    question: lt('How much do courses cost?', 'كم تبلغ تكلفة الدورات؟'),
    answer: lt(
      'Each course shows its price in the catalog and on its own page.',
      'يظهر سعر كل دورة في قائمة الدورات وفي صفحتها الخاصة.',
    ),
  },
  {
    id: 'faq-preview',
    question: lt(
      'Can I preview a course before enrolling?',
      'هل يمكنني معاينة الدورة قبل التسجيل؟',
    ),
    answer: lt(
      'Open a course to see its description and curriculum. If a course offers preview lessons, they are marked in its content.',
      'افتح الدورة لترى وصفها ومنهجها. وإذا كانت الدورة تتيح دروسًا للمعاينة، فستجدها مميّزة في محتواها.',
    ),
  },
  {
    id: 'faq-pay',
    question: lt('How do I pay for a course?', 'كيف أدفع ثمن الدورة؟'),
    answer: lt(
      'Open the course you are interested in to see how to enrol. If you have a question about payment, contact us.',
      'افتح الدورة التي تهمّك لتعرف طريقة التسجيل فيها. وإذا كان لديك سؤال عن الدفع، فتواصل معنا.',
    ),
  },
  {
    id: 'faq-team',
    question: lt('Can my company enrol a team?', 'هل يمكن لشركتي تسجيل فريق؟'),
    answer: lt(
      'Contact us with the size of your team and the courses you are interested in to discuss the options.',
      'تواصل معنا واذكر عدد أفراد فريقك والدورات التي تهمّكم لمناقشة الخيارات المتاحة.',
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
        eyebrow: lt('Welcome to {{academyName}}', 'مرحبًا بك في {{academyName}}'),
        title: lt(
          'Learn new skills, one course at a time',
          'تعلّم مهارات جديدة، دورة تلو الأخرى',
        ),
        highlight: lt('one course at a time', 'دورة تلو الأخرى'),
        description: lt(
          'Browse our courses, read what each one covers and choose the one that fits your goals.',
          'تصفّح دوراتنا، واطّلع على ما تغطّيه كل دورة، واختر ما يناسب أهدافك.',
        ),
        cta: { label: lt('Explore courses', 'استكشف الدورات') },
        secondaryCta: { label: lt('Talk to us', 'تحدّث إلينا') },
        highlights: [
          {
            id: 'hl-projects',
            label: lt('Clear course details', 'تفاصيل واضحة لكل دورة'),
          },
          {
            id: 'hl-pace',
            label: lt('Learn online', 'تعلّم عبر الإنترنت'),
          },
          {
            id: 'hl-support',
            label: lt('Questions welcome', 'أسئلتك مرحّب بها'),
          },
        ],
      },
    },
    // §C.1 #2 — highlights band.
    {
      type: 'features',
      dynamicDefaults: { layout: 'strip' },
      starterContent: {
        title: lt('Why learn with us', 'لماذا تتعلّم معنا'),
        items: [
          {
            id: 'feature-experts',
            icon: 'GraduationCap',
            title: lt('Know your instructors', 'تعرّف على مدرّبيك'),
            description: lt(
              'Each course shows who teaches it.',
              'تعرض كل دورة اسم من يقدّمها.',
            ),
          },
          {
            id: 'feature-flexible',
            icon: 'Clock',
            title: lt('Learn online', 'تعلّم عبر الإنترنت'),
            description: lt(
              'Open your lessons on a phone, tablet or computer.',
              'افتح دروسك من الهاتف أو الجهاز اللوحي أو الحاسوب.',
            ),
          },
          {
            id: 'feature-projects',
            icon: 'BookOpen',
            title: lt('Clear course outlines', 'مخطّط واضح لكل دورة'),
            description: lt(
              'See what each course covers before you enrol.',
              'اطّلع على ما تغطّيه كل دورة قبل التسجيل.',
            ),
          },
          {
            id: 'feature-support',
            icon: 'Headphones',
            title: lt('Get in touch', 'تواصل معنا'),
            description: lt(
              'Have a question? Send us a message.',
              'لديك سؤال؟ أرسل لنا رسالة.',
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
          'A selection of courses from our catalog.',
          'مجموعة مختارة من دوراتنا.',
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
        title: lt('Learning, step by step', 'التعلّم خطوة بخطوة'),
        description: lt(
          'Courses are organised into sections and lessons, so you can follow along and see your progress as you go.',
          'تنقسم الدورات إلى أقسام ودروس، فتتابع التعلّم وترى تقدّمك أولًا بأول.',
        ),
        items: [
          {
            id: 'benefit-paths',
            title: lt('Organised lessons', 'دروس منظّمة'),
            description: lt(
              'Follow each course section by section.',
              'تابع كل دورة قسمًا تلو الآخر.',
            ),
          },
          {
            id: 'benefit-feedback',
            title: lt('Track your progress', 'تابع تقدّمك'),
            description: lt(
              'See which lessons you have completed and pick up where you left off.',
              'اعرف الدروس التي أكملتها وتابع من حيث توقّفت.',
            ),
          },
          {
            id: 'benefit-skills',
            title: lt('Ask questions', 'اطرح أسئلتك'),
            description: lt(
              'Contact us whenever something is unclear.',
              'تواصل معنا كلما احتجت إلى توضيح.',
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
        description: lt('Here is how to get started.', 'إليك طريقة البدء.'),
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
            title: lt('Start learning', 'ابدأ التعلّم'),
            description: lt(
              'Work through the lessons in order and track your progress.',
              'تابع الدروس بالترتيب وراقب تقدّمك.',
            ),
          },
          {
            id: 'step-apply',
            title: lt('Complete the course', 'أكمل الدورة'),
            description: lt(
              'Finish the lessons and put what you learned into practice.',
              'أنهِ الدروس وطبّق ما تعلّمته.',
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
          'The people who teach our courses.',
          'الأشخاص الذين يقدّمون دوراتنا.',
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
          'Create your account and take the first step toward your next skill.',
          'أنشئ حسابك وخُذ الخطوة الأولى نحو مهارتك التالية.',
        ),
        cta: { label: lt('Create your account', 'أنشئ حسابك') },
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
        title: lt('Who we are and what we teach', 'من نحن وماذا نعلّم'),
        description: lt(
          '{{academyName}} offers online courses for people who want to learn new skills.',
          'تقدّم {{academyName}} دورات عبر الإنترنت لكل من يرغب في تعلّم مهارات جديدة.',
        ),
      },
    },
    {
      type: 'featureSplit',
      dynamicDefaults: { imagePosition: 'start' },
      assets: { image: asset('about-story') },
      starterContent: {
        eyebrow: lt('Our story', 'قصّتنا'),
        title: lt('Why we teach', 'لماذا نعلّم'),
        description: lt(
          'We believe learning a new skill should be clear and within reach. That is why we organise our courses so you can follow them step by step.',
          'نؤمن بأن تعلّم مهارة جديدة ينبغي أن يكون واضحًا وفي متناول الجميع، ولذلك ننظّم دوراتنا بحيث تتابعها خطوة بخطوة.',
        ),
        items: [
          {
            id: 'story-practice',
            title: lt('A clear structure', 'بنية واضحة'),
            description: lt(
              'Courses are organised into sections and lessons.',
              'تنقسم الدورات إلى أقسام ودروس.',
            ),
          },
          {
            id: 'story-learners',
            title: lt('Designed around learners', 'مصمَّمة حول المتعلّمين'),
            description: lt(
              'We aim to keep every lesson clear and focused.',
              'نحرص على أن يكون كل درس واضحًا ومركّزًا.',
            ),
          },
          {
            id: 'story-community',
            title: lt('Open to your ideas', 'منفتحون على أفكارك'),
            description: lt(
              'Tell us which topics you would like to learn next.',
              'أخبرنا بالموضوعات التي تودّ تعلّمها لاحقًا.',
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
              'We care about the quality of every course we publish.',
              'نهتمّ بجودة كل دورة ننشرها.',
            ),
          },
          {
            id: 'value-together',
            icon: 'Users',
            title: lt('Open communication', 'تواصل مفتوح'),
            description: lt(
              'Questions are welcome — just send us a message.',
              'أسئلتك مرحّب بها، فقط أرسل لنا رسالة.',
            ),
          },
          {
            id: 'value-outcomes',
            icon: 'Sparkles',
            title: lt('Clear goals', 'أهداف واضحة'),
            description: lt(
              'We aim to make clear what each course covers.',
              'نحرص على توضيح ما تغطّيه كل دورة.',
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
          'Search our courses, filter by category and level, and find the one that suits you.',
          'ابحث في دوراتنا، وصفِّ النتائج حسب التصنيف والمستوى، واعثر على الدورة التي تناسبك.',
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
          'Send us a message and tell us what you want to learn.',
          'أرسل لنا رسالة وأخبرنا بما تريد تعلّمه.',
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
          'Answers to common questions about our courses.',
          'إجابات عن أسئلة شائعة حول دوراتنا.',
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
          'Send us a message with your question.',
          'أرسل لنا رسالة بسؤالك.',
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
          'Questions about a course, enrolling a team or anything else? Send us a message.',
          'أسئلة عن دورة أو تسجيل فريق أو أي أمر آخر؟ أرسل لنا رسالة.',
        ),
      },
    },
    {
      type: 'contact',
      dynamicDefaults: { showForm: true },
      starterContent: {
        title: lt('Get in touch', 'تواصل معنا'),
        description: lt(
          'Reach us directly using our contact details, or send a message using the form.',
          'تواصل معنا مباشرة عبر بيانات التواصل، أو أرسل رسالة باستخدام النموذج.',
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
