/**
 * Riwaq (Theme 4) — starter content, template v1.
 *
 * The composition the Riwaq renderers are designed on (frontend repo,
 * Reports/THEME_4_RIWAQ_PLAN.md §4): Home follows how an adult decides on a
 * programme — the promise (`hero`), what every programme gives you
 * (`features`), the departments (`courseCategories`), the programmes
 * themselves (`featuredCourses`, drawn as a master–detail explorer), one
 * programme in focus with its real syllabus (`courseSpotlight`), how study
 * works (`steps`), the learning experience (`featureSplit`), the faculty
 * (`instructors`), facts and figures (`statistics`), graduates' words
 * (`testimonials`), questions before enrolling (`faq`) and the closing
 * invitation (`cta`). Every inner page opens with its plate (`pageHeader`).
 *
 * The voice is calm, precise and adult ("you"): an institute speaking to
 * people who will compare programmes on what they cover, how long they take
 * and what finishing them requires. The safety rules are Theme 1's,
 * unchanged (`modern-education.template.ts`):
 *
 *   - **Statistics are metric-only**: every item resolves a real number at
 *     render time; the template never carries a hand-typed one.
 *   - **Testimonials are samples**: three `sample: true` items with no
 *     photo, shown in previews with a "Sample" label and never served
 *     publicly until the Owner confirms or replaces them.
 *   - **Theme images** are asset references (`assets`), in both modes, each
 *     with its alt text (the alt describes the theme's photograph, so it
 *     travels with the image, not with the starter copy).
 *   - **CTA intents** (`ctaTargets`) point at the core pages and Sign Up.
 *
 * Copy interpolates only `{{academyName}}` (see `template-content.util.ts`)
 * and asserts nothing a given Academy may not offer — accreditation, jobs,
 * results, certificates, live sessions, response times, payment methods:
 * where a feature depends on the programme, the copy says "where a
 * programme includes…" and points at the programme page, which is the
 * source of truth (the spotlight and the programme sheets show a
 * certificate only for a course that really issues one).
 */
import type {
  WebsiteTemplateDefinition,
  WebsiteTemplatePage,
  WebsiteTemplateSection,
} from './website-template.types';
import { lt } from './template-content.util';

const asset = (key: string): string => `theme-asset:riwaq/${key}`;

/** Facts and figures: live metrics only — labels are the one authored part. */
const LIVE_STATISTICS: WebsiteTemplateSection = {
  type: 'statistics',
  dynamicDefaults: {
    items: [
      {
        id: 'stat-courses',
        metric: 'courses',
        value: lt(''),
        label: lt('Programmes', 'البرامج'),
      },
      {
        id: 'stat-students',
        metric: 'students',
        value: lt(''),
        label: lt('Learners', 'المتعلّمون'),
      },
      {
        id: 'stat-instructors',
        metric: 'instructors',
        value: lt(''),
        label: lt('Instructors', 'المدرّبون'),
      },
    ],
  },
  starterContent: {
    title: lt('Facts and figures', 'حقائق وأرقام'),
  },
};

/** The FAQs page's questions; Home and Contact show the first few. */
const FAQ_ITEMS = [
  {
    id: 'faq-length',
    question: lt('How long does a programme take?', 'كم تستغرق مدّة البرنامج؟'),
    answer: lt(
      'Each programme page shows the total length of its lessons and how many sections and lessons it has. You study at your own pace, so the calendar time is yours to plan.',
      'تعرض صفحة كل برنامج المدّة الإجمالية لدروسه وعدد أقسامه ودروسه. وتدرس بالإيقاع الذي يناسبك، فتخطيط الوقت بيدك.',
    ),
  },
  {
    id: 'faq-certificate',
    question: lt('Do I receive a certificate?', 'هل أحصل على شهادة؟'),
    answer: lt(
      'Some programmes issue a certificate when you complete them. The programme page says whether it does and what completing it requires.',
      'تمنح بعض البرامج شهادة عند إتمامها. وتوضّح صفحة البرنامج ما إذا كان يمنح شهادة وما الذي يتطلّبه إتمامه.',
    ),
  },
  {
    id: 'faq-level',
    question: lt('Is a programme right for my level?', 'هل يناسب البرنامج مستواي؟'),
    answer: lt(
      'Every programme states its level and lists any requirements on its page. Read the syllabus first; if you are unsure, write to us before you enrol.',
      'يذكر كل برنامج مستواه ويعرض متطلّباته في صفحته. اقرأ المنهج أولًا، وإن لم تكن متأكّدًا فراسلنا قبل التسجيل.',
    ),
  },
  {
    id: 'faq-pay',
    question: lt('How do I pay?', 'كيف أدفع؟'),
    answer: lt(
      'Open the programme and choose Enrol. The payment methods available for it are shown at that step. If you pay by transfer, upload the receipt; your enrolment is confirmed once it has been checked.',
      'افتح البرنامج واختر «سجّل». تظهر طرق الدفع المتاحة له في تلك الخطوة. وإذا دفعت بالتحويل فارفع الإيصال، ويُؤكَّد تسجيلك بعد مراجعته.',
    ),
  },
  {
    id: 'faq-practice',
    question: lt('Is there practice and assessment?', 'هل توجد تمارين وتقييم؟'),
    answer: lt(
      'Where a programme includes quizzes or assignments, they are listed in its syllabus and sit next to the lessons they cover. Your attempts are saved, so you can see how you are doing.',
      'حيث يتضمّن البرنامج اختبارات أو مهامّ، تجدها في منهجه بجوار الدروس التي تغطّيها. وتُحفظ محاولاتك لترى مستواك.',
    ),
  },
  {
    id: 'faq-devices',
    question: lt('Can I study around my work?', 'هل يمكنني الدراسة إلى جانب عملي؟'),
    answer: lt(
      'Yes. Lessons open on phones, tablets and computers whenever suits you, and your progress follows you from one device to the next.',
      'نعم. تُفتح الدروس على الهواتف والأجهزة اللوحية والحواسيب متى شئت، ويرافقك تقدّمك من جهاز إلى آخر.',
    ),
  },
  {
    id: 'faq-help',
    question: lt('Who do I ask if I am stuck?', 'بمن أستعين إن تعثّرت؟'),
    answer: lt(
      'Write to us through the Contact page and name the programme and the lesson you are on.',
      'راسلنا عبر صفحة «تواصل معنا» واذكر البرنامج والدرس الذي وصلت إليه.',
    ),
  },
] as const;

const home: WebsiteTemplatePage = {
  coreType: 'home',
  sections: [
    // 1 — The portico: the promise, two actions, the spec row.
    {
      type: 'hero',
      ctaTargets: { cta: 'courses', secondaryCta: 'signUp' },
      dynamicDefaults: { showSearch: false },
      assets: {
        image: asset('home-hero'),
        imageAlt: lt(
          'A long stone colonnade in morning light, one person walking in the distance',
          'رواق حجري طويل في ضوء الصباح، وشخص يسير في آخره',
        ),
      },
      starterContent: {
        eyebrow: lt(
          '{{academyName}} — professional programmes',
          '{{academyName}} — برامج مهنية',
        ),
        title: lt('Serious skills, clearly taught.', 'مهارات جادّة، تُدرَّس بوضوح.'),
        highlight: lt('clearly taught.', 'تُدرَّس بوضوح.'),
        subtitle: lt(
          'Programmes with a published syllabus, a stated level and a known length — so you know what you are enrolling in.',
          'برامج بمنهج منشور ومستوى محدّد ومدّة معلنة، لتعرف ما الذي تسجّل فيه قبل أن تبدأ.',
        ),
        description: lt(
          'Study at your own pace on any device, practise as you go and keep a record of your progress. Every programme page lists what it covers before you enrol.',
          'ادرس بإيقاعك على أي جهاز، وتدرّب أثناء التعلّم، واحتفظ بسجلّ لتقدّمك. وتعرض صفحة كل برنامج ما يغطّيه قبل أن تسجّل.',
        ),
        cta: { label: lt('View programmes', 'استعرض البرامج') },
        secondaryCta: { label: lt('Create an account', 'أنشئ حسابًا') },
        highlights: [
          { id: 'hl-syllabus', label: lt('Published syllabus', 'منهج منشور') },
          { id: 'hl-devices', label: lt('Any device', 'على أي جهاز') },
          { id: 'hl-progress', label: lt('Tracked progress', 'تقدّم مُسجَّل') },
        ],
      },
    },
    // 2 — What every programme gives you: platform-true, never course-specific.
    {
      type: 'features',
      starterContent: {
        title: lt('What every programme gives you', 'ما يمنحك إيّاه كل برنامج'),
        description: lt(
          'The same structure, whichever programme you choose.',
          'البنية نفسها، أيًّا كان البرنامج الذي تختاره.',
        ),
        items: [
          {
            id: 'outcome-syllabus',
            icon: 'BookOpen',
            title: lt('A syllabus you read first', 'منهج تقرؤه أولًا'),
            description: lt(
              'Sections, lessons and their length are listed on the programme page before you enrol.',
              'تُعرض الأقسام والدروس ومدّتها في صفحة البرنامج قبل أن تسجّل.',
            ),
          },
          {
            id: 'outcome-practice',
            icon: 'ShieldCheck',
            title: lt('Practice where it belongs', 'تمارين في مكانها'),
            description: lt(
              'Where a programme includes quizzes or assignments, they sit next to the lessons they test.',
              'حيث يتضمّن البرنامج اختبارات أو مهامّ، تجدها بجوار الدروس التي تختبرها.',
            ),
          },
          {
            id: 'outcome-record',
            icon: 'Award',
            title: lt('A record of your progress', 'سجلّ لتقدّمك'),
            description: lt(
              'Finished lessons and attempts are saved, so you always know where you stand.',
              'تُحفظ الدروس المنجزة والمحاولات، فتعرف دائمًا أين تقف.',
            ),
          },
          {
            id: 'outcome-time',
            icon: 'Clock',
            title: lt('Study around your work', 'ادرس إلى جانب عملك'),
            description: lt(
              'Lessons open on your phone, tablet or computer, whenever suits you.',
              'تُفتح الدروس على هاتفك أو جهازك اللوحي أو حاسوبك، متى ناسبك.',
            ),
          },
        ],
      },
    },
    // 3 — Departments: live categories (hidden publicly with fewer than two).
    {
      type: 'courseCategories',
      dynamicDefaults: { maxItems: 8, showCounts: true },
      starterContent: {
        title: lt('Departments', 'الأقسام'),
        description: lt('Programmes grouped by field.', 'البرامج مصنّفة حسب المجال.'),
      },
    },
    // 4 — Programmes: live courses, compared side by side.
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
        title: lt('Programmes', 'البرامج'),
        description: lt(
          'Compare the level, the length and what each programme covers.',
          'قارن المستوى والمدّة وما يغطّيه كل برنامج.',
        ),
      },
    },
    // 5 — One programme in focus: its real outcomes and syllabus.
    {
      type: 'courseSpotlight',
      dynamicDefaults: { showOutcomes: true, showSyllabus: true, maxModules: 6 },
      starterContent: {
        eyebrow: lt('Programme in focus', 'برنامج تحت الضوء'),
        description: lt(
          'The syllabus as it stands, before you enrol.',
          'المنهج كما هو، قبل أن تسجّل.',
        ),
      },
    },
    // 6 — How study works: four steps from choosing to finishing.
    {
      type: 'steps',
      assets: {
        image: asset('home-method'),
        imageAlt: lt(
          'Hands writing in a notebook beside a ruler on a pale stone table',
          'يدان تكتبان في دفتر بجوار مسطرة على طاولة حجرية فاتحة',
        ),
      },
      starterContent: {
        title: lt('How study works', 'كيف تسير الدراسة'),
        description: lt(
          'From choosing a programme to finishing it.',
          'من اختيار البرنامج إلى إتمامه.',
        ),
        items: [
          {
            id: 'step-choose',
            title: lt('Choose', 'اختر'),
            description: lt(
              'Read a programme’s syllabus, level and length on its page.',
              'اقرأ منهج البرنامج ومستواه ومدّته في صفحته.',
            ),
          },
          {
            id: 'step-enrol',
            title: lt('Enrol', 'سجّل'),
            description: lt(
              'Create your account and enrol; the payment methods are shown at that step.',
              'أنشئ حسابك وسجّل؛ تظهر طرق الدفع في تلك الخطوة.',
            ),
          },
          {
            id: 'step-study',
            title: lt('Study and practise', 'ادرس وتدرّب'),
            description: lt(
              'Work through the lessons and any practice in order, at your own pace.',
              'تابع الدروس والتمارين بالترتيب، بالإيقاع الذي يناسبك.',
            ),
          },
          {
            id: 'step-finish',
            title: lt('Finish', 'أتمِم'),
            description: lt(
              'Complete what the programme requires; its page says whether a certificate follows.',
              'أتمِم ما يتطلّبه البرنامج؛ وتوضّح صفحته ما إذا كانت تتبعه شهادة.',
            ),
          },
        ],
      },
    },
    // 7 — The learning experience: the photograph window and three points.
    {
      type: 'featureSplit',
      dynamicDefaults: { imagePosition: 'start' },
      assets: {
        image: asset('home-benefit'),
        imageAlt: lt(
          'A quiet study hall with long tables in morning light',
          'قاعة دراسة هادئة بطاولات طويلة في ضوء الصباح',
        ),
      },
      starterContent: {
        eyebrow: lt('The learning experience', 'تجربة التعلّم'),
        title: lt('Made for people who work', 'مصمَّمة لمن يعمل'),
        description: lt(
          'Programmes are built to fit into a working week: short lessons, a clear order and a saved place.',
          'صُمّمت البرامج لتناسب أسبوع العمل: دروس قصيرة، وترتيب واضح، وموضع محفوظ.',
        ),
        items: [
          {
            id: 'experience-parts',
            title: lt('Lessons in short parts', 'دروس في أجزاء قصيرة'),
            description: lt(
              'Each section is split into lessons you can finish in one sitting.',
              'يُقسَّم كل قسم إلى دروس يمكنك إنهاؤها في جلسة واحدة.',
            ),
          },
          {
            id: 'experience-resume',
            title: lt('Resume where you stopped', 'تابع من حيث توقّفت'),
            description: lt(
              'Your place is saved on every device, so a spare half hour is enough.',
              'يُحفظ موضعك على كل جهاز، فتكفيك نصف ساعة فراغ.',
            ),
          },
          {
            id: 'experience-order',
            title: lt('A clear order', 'ترتيب واضح'),
            description: lt(
              'Every lesson builds on the one before it, so nothing arrives out of place.',
              'يبني كل درس على ما قبله، فلا يأتي شيء في غير موضعه.',
            ),
          },
        ],
      },
    },
    // 8 — Faculty: live instructors (hidden publicly when there are none).
    {
      type: 'instructors',
      dynamicDefaults: { count: 6 },
      starterContent: {
        title: lt('Faculty', 'هيئة التدريب'),
        description: lt(
          'The people who teach the programmes at {{academyName}}.',
          'من يقدّمون برامج {{academyName}}.',
        ),
      },
    },
    // 9 — Facts and figures: live numbers (hidden with fewer than two).
    LIVE_STATISTICS,
    // 10 — Graduates: sample testimonials, preview only until the Owner confirms them.
    {
      type: 'testimonials',
      starterContent: {
        title: lt('On the record', 'على لسانهم'),
        items: [
          {
            id: 'sample-testimonial-1',
            sample: true,
            authorName: 'Nadia K.',
            authorRole: lt('Operations analyst', 'محلّلة عمليات'),
            quote: lt(
              'I read the whole syllabus before I paid anything. It covered exactly what it said it would, in the order it said.',
              'قرأت المنهج كاملًا قبل أن أدفع شيئًا، وغطّى البرنامج ما وعد به تمامًا وبالترتيب نفسه.',
            ),
          },
          {
            id: 'sample-testimonial-2',
            sample: true,
            authorName: 'Omar R.',
            authorRole: lt('Changing careers', 'يغيّر مساره المهني'),
            quote: lt(
              'I studied in the evenings after work. Short lessons and a saved place made it possible.',
              'كنت أدرس مساءً بعد العمل، والدروس القصيرة مع حفظ موضعي جعلت ذلك ممكنًا.',
            ),
          },
          {
            id: 'sample-testimonial-3',
            sample: true,
            authorName: 'Layla H.',
            authorRole: lt('Team lead', 'قائدة فريق'),
            quote: lt(
              'The practice after each section showed me what I actually knew, not what I thought I knew.',
              'أظهرت لي التمارين بعد كل قسم ما أعرفه فعلًا، لا ما ظننت أنني أعرفه.',
            ),
          },
        ],
      },
    },
    // 11 — Before you enrol: a teaser of the FAQs page.
    {
      type: 'faq',
      ctaTargets: { cta: 'faqs' },
      dynamicDefaults: { maxItems: 4 },
      starterContent: {
        title: lt('Before you enrol', 'قبل التسجيل'),
        items: FAQ_ITEMS.slice(0, 4),
        cta: { label: lt('All questions', 'كل الأسئلة') },
      },
    },
    // 12 — The closing invitation.
    {
      type: 'cta',
      ctaTargets: { cta: 'courses', secondaryCta: 'contact' },
      assets: {
        image: asset('home-cta'),
        imageAlt: lt(
          'Sunlight falling between columns onto a stone floor',
          'ضوء الشمس يتسلّل بين الأعمدة على أرضية حجرية',
        ),
      },
      starterContent: {
        title: lt('Start with the syllabus', 'ابدأ بقراءة المنهج'),
        description: lt(
          'Open any programme to see exactly what it covers, then enrol when you are ready.',
          'افتح أي برنامج لترى ما يغطّيه بالضبط، ثم سجّل عندما تكون مستعدًا.',
        ),
        cta: { label: lt('View programmes', 'استعرض البرامج') },
        secondaryCta: { label: lt('Talk to us', 'تحدّث إلينا') },
      },
    },
  ],
};

/** About: the plate, how we work, what we stand for, figures, faculty, the gallery, the close. */
const about: WebsiteTemplatePage = {
  coreType: 'about',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'none' },
      assets: {
        image: asset('about-header'),
        imageAlt: lt(
          'An arcade of pale columns casting long shadows across a courtyard',
          'رواق من أعمدة فاتحة يلقي ظلالًا طويلة على فناء',
        ),
      },
      starterContent: {
        eyebrow: lt('About {{academyName}}', 'عن {{academyName}}'),
        title: lt('An institute built on clear programmes', 'معهد يقوم على برامج واضحة'),
        description: lt(
          '{{academyName}} publishes every programme in full — syllabus, level and length — so you can choose with the facts in front of you.',
          'تنشر {{academyName}} كل برنامج كاملًا — منهجه ومستواه ومدّته — لتختار والحقائق أمامك.',
        ),
      },
    },
    {
      type: 'featureSplit',
      dynamicDefaults: { imagePosition: 'end' },
      assets: {
        image: asset('about-story'),
        imageAlt: lt(
          'A wide stone staircase in a bright atrium seen from above',
          'درج حجري عريض في بهو مضيء من الأعلى',
        ),
      },
      starterContent: {
        eyebrow: lt('How we work', 'كيف نعمل'),
        title: lt('Programmes, not piles of videos', 'برامج، لا أكوام من المقاطع'),
        description: lt(
          'A programme is a sequence with a purpose: what comes first, what it builds towards and how you will know you have it.',
          'البرنامج تسلسل له غاية: ما الذي يأتي أولًا، وإلى أين يقود، وكيف تعرف أنك أتقنته.',
        ),
        items: [
          {
            id: 'story-sequence',
            title: lt('A deliberate sequence', 'تسلسل مقصود'),
            description: lt(
              'Sections are ordered so each one prepares you for the next.',
              'تُرتَّب الأقسام بحيث يهيّئك كل قسم لما بعده.',
            ),
          },
          {
            id: 'story-published',
            title: lt('Everything published', 'كل شيء منشور'),
            description: lt(
              'What a programme covers is on its page before you enrol.',
              'ما يغطّيه البرنامج معروض في صفحته قبل أن تسجّل.',
            ),
          },
          {
            id: 'story-checked',
            title: lt('Learning you can check', 'تعلّم يمكنك التحقّق منه'),
            description: lt(
              'Where a programme includes practice, it shows you what has stuck.',
              'حيث يتضمّن البرنامج تمارين، فهي تريك ما رسخ.',
            ),
          },
        ],
      },
    },
    {
      type: 'features',
      starterContent: {
        title: lt('Our standards', 'معاييرنا'),
        description: lt(
          'Four principles behind every programme.',
          'أربعة مبادئ وراء كل برنامج.',
        ),
        items: [
          {
            id: 'value-clarity',
            icon: 'BookOpen',
            title: lt('Clarity', 'الوضوح'),
            description: lt(
              'Say what a programme covers, and cover it.',
              'أن نقول ما يغطّيه البرنامج، ثم نغطّيه.',
            ),
          },
          {
            id: 'value-rigour',
            icon: 'ShieldCheck',
            title: lt('Rigour', 'الإتقان'),
            description: lt(
              'Practice that tests the skill, not the memory of the lesson.',
              'تمارين تختبر المهارة، لا تذكّر الدرس.',
            ),
          },
          {
            id: 'value-time',
            icon: 'Clock',
            title: lt('Respect for your time', 'احترام وقتك'),
            description: lt(
              'Short lessons, a clear order and nothing padded.',
              'دروس قصيرة وترتيب واضح ولا حشو.',
            ),
          },
          {
            id: 'value-people',
            icon: 'Users',
            title: lt('Straight answers', 'إجابات مباشرة'),
            description: lt(
              'A question about a programme deserves a direct reply.',
              'السؤال عن برنامج يستحق ردًّا مباشرًا.',
            ),
          },
        ],
      },
    },
    LIVE_STATISTICS,
    {
      type: 'instructors',
      dynamicDefaults: { count: 9 },
      starterContent: {
        title: lt('Faculty', 'هيئة التدريب'),
        description: lt(
          'The people who teach the programmes at {{academyName}}.',
          'من يقدّمون برامج {{academyName}}.',
        ),
      },
    },
    {
      type: 'gallery',
      assets: {
        images: [
          {
            id: 'gallery-1',
            image: asset('gallery-1'),
            imageAlt: lt(
              'Light falling through tall windows onto rows of study tables',
              'ضوء يسقط من نوافذ عالية على صفوف طاولات الدراسة',
            ),
          },
          {
            id: 'gallery-2',
            image: asset('gallery-2'),
            imageAlt: lt(
              'A notebook, a pen and a steel ruler on a stone table',
              'دفتر وقلم ومسطرة معدنية على طاولة حجرية',
            ),
          },
          {
            id: 'gallery-3',
            image: asset('gallery-3'),
            imageAlt: lt(
              'A seminar room with chairs in a semicircle and morning light',
              'قاعة نقاش بكراسٍ على شكل نصف دائرة في ضوء الصباح',
            ),
          },
          {
            id: 'gallery-4',
            image: asset('gallery-4'),
            imageAlt: lt(
              'Shelves of plain books along a quiet library aisle',
              'رفوف كتب في ممرّ مكتبة هادئ',
            ),
          },
          {
            id: 'gallery-5',
            image: asset('gallery-5'),
            imageAlt: lt(
              'A person seen from behind at a tall window overlooking a courtyard',
              'شخص يُرى من الخلف أمام نافذة عالية تطلّ على فناء',
            ),
          },
        ],
      },
      starterContent: {
        title: lt('Where learning happens', 'حيث يحدث التعلّم'),
      },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'courses', secondaryCta: 'contact' },
      starterContent: {
        title: lt('Find your programme', 'اعثر على برنامجك'),
        description: lt(
          'Compare programmes by level and length, then read the syllabus of the one you want.',
          'قارن البرامج حسب المستوى والمدّة، ثم اقرأ منهج البرنامج الذي تريده.',
        ),
        cta: { label: lt('View programmes', 'استعرض البرامج') },
        secondaryCta: { label: lt('Talk to us', 'تحدّث إلينا') },
      },
    },
  ],
};

/** Courses: the plate's search drives the catalogue below it. */
const courses: WebsiteTemplatePage = {
  coreType: 'courses',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'courses' },
      assets: {
        image: asset('courses-header'),
        imageAlt: lt(
          'Rows of long study tables under tall windows',
          'صفوف من طاولات الدراسة الطويلة تحت نوافذ عالية',
        ),
      },
      starterContent: {
        eyebrow: lt('Programmes', 'البرامج'),
        title: lt('Every programme, specified', 'كل البرامج، بتفاصيلها'),
        description: lt(
          'Search by name, filter by level or price, and open any programme to read its syllabus before you enrol.',
          'ابحث بالاسم، وصفِّ النتائج حسب المستوى أو السعر، وافتح أي برنامج لتقرأ منهجه قبل أن تسجّل.',
        ),
      },
    },
    {
      type: 'courseCatalog',
      dynamicDefaults: {
        pageSize: 12,
        defaultSort: 'newest',
        showSearch: false,
        showLevelFilter: true,
        showPricingFilter: true,
        showSort: true,
      },
      starterContent: { title: lt('All programmes', 'كل البرامج') },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt('Not sure which programme fits?', 'لست متأكّدًا أيّ برنامج يناسبك؟'),
        description: lt(
          'Tell us what you do now and what you want to be able to do.',
          'أخبرنا بما تعمله الآن وبما تريد أن تتقنه.',
        ),
        cta: { label: lt('Talk to us', 'تحدّث إلينا') },
      },
    },
  ],
};

/** FAQs: the plate's filter narrows the questions below. */
const faqs: WebsiteTemplatePage = {
  coreType: 'faqs',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'faq' },
      assets: {
        image: asset('faqs-header'),
        imageAlt: lt(
          'A bright corridor of columns with light falling across the floor',
          'ممرّ مضيء من الأعمدة والضوء يتساقط على الأرض',
        ),
      },
      starterContent: {
        eyebrow: lt('Questions', 'الأسئلة'),
        title: lt('Before you enrol', 'قبل أن تسجّل'),
        description: lt(
          'Length, level, completion, payment and getting help.',
          'المدّة والمستوى والإتمام والدفع وطلب المساعدة.',
        ),
      },
    },
    { type: 'faq', starterContent: { items: FAQ_ITEMS } },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt('Anything else to ask?', 'هل من سؤال آخر؟'),
        description: lt(
          'Write to us and name the programme you mean.',
          'راسلنا واذكر البرنامج الذي تقصده.',
        ),
        cta: { label: lt('Talk to us', 'تحدّث إلينا') },
      },
    },
  ],
};

/** Contact: the Academy's own details and the form, then quick answers. */
const contact: WebsiteTemplatePage = {
  coreType: 'contact',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'none' },
      assets: {
        image: asset('contact-header'),
        imageAlt: lt(
          'A reception desk in a light stone hall',
          'مكتب استقبال في قاعة حجرية مضيئة',
        ),
      },
      starterContent: {
        eyebrow: lt('Contact', 'تواصل'),
        title: lt('Talk to {{academyName}}', 'تحدّث إلى {{academyName}}'),
        description: lt(
          'A question about a programme, an enrolment or a payment — send it here.',
          'سؤال عن برنامج أو تسجيل أو دفعة — أرسله من هنا.',
        ),
      },
    },
    {
      type: 'contact',
      dynamicDefaults: { showForm: true },
      starterContent: {
        title: lt('How to reach us', 'كيف تصل إلينا'),
        description: lt(
          'Use the details below, or send a message with the form.',
          'استخدم البيانات أدناه، أو أرسل رسالة عبر النموذج.',
        ),
      },
    },
    {
      type: 'faq',
      ctaTargets: { cta: 'faqs' },
      dynamicDefaults: { maxItems: 3 },
      starterContent: {
        title: lt('Answers in brief', 'إجابات موجزة'),
        items: FAQ_ITEMS.slice(0, 5),
        cta: { label: lt('All questions', 'كل الأسئلة') },
      },
    },
  ],
};

export const riwaqTemplate: WebsiteTemplateDefinition = {
  themeKey: 'riwaq',
  version: 1,
  pages: [home, about, courses, faqs, contact],
};
