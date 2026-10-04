/**
 * Atelier (Theme 2) — starter content, template v1.
 *
 * The composition the Atelier renderers are designed on (frontend repo,
 * Reports/THEME_2_ATELIER_PLAN.md §3): Home reads as a studio publication
 * in numbered chapters — hero, I philosophy (`featureSplit`), II what you
 * find here (`features`), III subjects, IV recently published, V the
 * method (`steps`), then instructors, figures, testimonials, questions and
 * the closing call. Every inner page opens with its masthead
 * (`pageHeader`).
 *
 * The voice is editorial and calm, not promotional; the safety rules are
 * Theme 1's, unchanged (`modern-education.template.ts`):
 *
 *   - **Statistics are metric-only**: every item resolves a real number at
 *     render time; the template never carries a hand-typed one.
 *   - **Testimonials are samples**: three `sample: true` items with no
 *     photo, shown in previews with a "Sample" label and never served
 *     publicly until the Owner confirms or replaces them.
 *   - **Theme images** are asset references (`assets`), in both modes.
 *   - **CTA intents** (`ctaTargets`) point at the core pages and Sign Up.
 *
 * Copy interpolates only `{{academyName}}` (see `template-content.util.ts`)
 * and asserts nothing a given Academy may not offer — free courses,
 * certificates, response times, open enrolment, outcomes: the Owner adds
 * those claims if they are true.
 */
import type {
  WebsiteTemplateDefinition,
  WebsiteTemplatePage,
  WebsiteTemplateSection,
} from './website-template.types';
import { lt } from './template-content.util';

const asset = (key: string): string => `theme-asset:atelier/${key}`;

/** Live statistics: the metric only — labels are the one authored part. */
const LIVE_STATISTICS: WebsiteTemplateSection = {
  type: 'statistics',
  dynamicDefaults: {
    items: [
      {
        id: 'stat-courses',
        metric: 'courses',
        value: lt(''),
        label: lt('Courses', 'الدورات'),
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
    title: lt('{{academyName}}, in figures', '{{academyName}} في أرقام'),
  },
};

/** The FAQs page's questions; Home and Contact show the first few as a teaser. */
const FAQ_ITEMS = [
  {
    id: 'faq-fit',
    question: lt(
      'How do I know if a course is right for me?',
      'كيف أعرف أن الدورة تناسبني؟',
    ),
    answer: lt(
      'Read its page first. It describes the level, what the course covers and what you need before you begin.',
      'اقرأ صفحتها أولًا؛ فهي تصف المستوى وما تغطّيه الدورة وما تحتاجه قبل أن تبدأ.',
    ),
  },
  {
    id: 'faq-access',
    question: lt('How long can I keep a course?', 'إلى متى يمكنني الاحتفاظ بالدورة؟'),
    answer: lt(
      'Access varies from course to course. The course details say more, and you can write to us if anything is unclear.',
      'تختلف مدة الوصول من دورة إلى أخرى. تجد المزيد في تفاصيل الدورة، ويمكنك مراسلتنا إن كان أي أمر غير واضح.',
    ),
  },
  {
    id: 'faq-devices',
    question: lt(
      'Which devices can I learn on?',
      'ما الأجهزة التي يمكنني التعلّم عليها؟',
    ),
    answer: lt(
      'Lessons open on phones, tablets and computers, and your progress follows you from one to the next.',
      'تُفتح الدروس على الهواتف والأجهزة اللوحية والحواسيب، ويرافقك تقدّمك من جهاز إلى آخر.',
    ),
  },
  {
    id: 'faq-help',
    question: lt('What if I get stuck?', 'ماذا لو تعثّرت؟'),
    answer: lt(
      'Write to us through the Contact page and tell us which course and lesson you are on.',
      'راسلنا عبر صفحة «تواصل معنا»، وأخبرنا بالدورة والدرس اللذين وصلت إليهما.',
    ),
  },
  {
    id: 'faq-price',
    question: lt("Where do I find a course's price?", 'أين أجد سعر الدورة؟'),
    answer: lt(
      "In the catalogue and on each course's own page.",
      'في فهرس الدورات وفي صفحة كل دورة.',
    ),
  },
  {
    id: 'faq-contents',
    question: lt(
      'Can I see what a course contains before enrolling?',
      'هل يمكنني الاطّلاع على محتوى الدورة قبل التسجيل؟',
    ),
    answer: lt(
      'Yes. Each course page shows its description and curriculum. Where a course offers preview lessons, they are marked as such.',
      'نعم. تعرض صفحة كل دورة وصفها ومنهجها، وإذا كانت الدورة تتيح دروسًا للمعاينة فستجدها مميّزة فيها.',
    ),
  },
  {
    id: 'faq-enrol',
    question: lt('How do I enrol?', 'كيف أسجّل في دورة؟'),
    answer: lt(
      'Open the course and follow the enrolment steps on its page. For questions about payment, write to us.',
      'افتح الدورة واتّبع خطوات التسجيل في صفحتها. ولأي سؤال عن الدفع، راسلنا.',
    ),
  },
  {
    id: 'faq-groups',
    question: lt('Can we enrol as a group?', 'هل يمكننا التسجيل كمجموعة؟'),
    answer: lt(
      'Write to us with the size of your group and the courses you have in mind, and we can discuss the options.',
      'راسلنا واذكر عدد أفراد مجموعتكم والدورات التي تفكّرون فيها، لنناقش الخيارات المتاحة.',
    ),
  },
] as const;

const home: WebsiteTemplatePage = {
  coreType: 'home',
  sections: [
    // The opening spread: a type-led promise and the first action.
    {
      type: 'hero',
      ctaTargets: { cta: 'courses', secondaryCta: 'contact' },
      dynamicDefaults: { showSearch: false },
      assets: { image: asset('home-hero') },
      starterContent: {
        eyebrow: lt(
          '{{academyName}} — a learning studio',
          '{{academyName}} — استوديو للتعلّم',
        ),
        title: lt(
          'Learn deliberately, one chapter at a time',
          'تعلّم بتأنٍّ، فصلًا بعد فصل',
        ),
        highlight: lt('one chapter at a time', 'فصلًا بعد فصل'),
        description: lt(
          'Every course at {{academyName}} is set out like a well-made book: a clear outline, an order to follow and room to think.',
          'تُقدَّم كل دورة في {{academyName}} كما يُصنع كتاب متقن: مخطّط واضح، وترتيب تتّبعه، ومساحة للتفكير.',
        ),
        cta: { label: lt('Browse the courses', 'استعرض الدورات') },
        secondaryCta: { label: lt('Write to us', 'راسلنا') },
        highlights: [
          {
            id: 'hl-outline',
            label: lt('A clear outline for every course', 'لكل دورة مخطّط واضح'),
          },
          {
            id: 'hl-order',
            label: lt('Lessons in a considered order', 'دروس بترتيب مدروس'),
          },
          {
            id: 'hl-questions',
            label: lt('Your questions are welcome', 'أسئلتك موضع ترحيب'),
          },
        ],
      },
    },
    // Chapter I — the philosophy, as a folio spread.
    {
      type: 'featureSplit',
      ctaTargets: { cta: 'about' },
      dynamicDefaults: { imagePosition: 'start' },
      assets: { image: asset('home-philosophy') },
      starterContent: {
        eyebrow: lt('Our approach', 'منهجنا'),
        title: lt('Good learning takes its time', 'التعلّم الجيّد يأخذ وقته'),
        description: lt(
          'We care more about understanding than about speed. Each course is arranged so that one idea prepares the next.',
          'يهمّنا الفهم أكثر من السرعة؛ لذلك تُرتَّب كل دورة بحيث تمهّد كل فكرة لما بعدها.',
        ),
        items: [
          {
            id: 'approach-outline',
            title: lt('Begin with the outline', 'ابدأ بالمخطّط'),
            description: lt(
              'Every course page sets out what it covers before you decide.',
              'تعرض صفحة كل دورة ما تغطّيه قبل أن تقرّر.',
            ),
          },
          {
            id: 'approach-order',
            title: lt('Follow the order', 'اتّبع الترتيب'),
            description: lt(
              'Sections and lessons build on one another, so nothing arrives out of place.',
              'تُبنى الأقسام والدروس بعضها على بعض، فلا يأتي شيء في غير موضعه.',
            ),
          },
          {
            id: 'approach-place',
            title: lt('Keep your place', 'احتفظ بموضعك'),
            description: lt(
              'Your progress is saved, so you can return to the lesson where you stopped.',
              'يُحفظ تقدّمك، فتعود إلى الدرس الذي توقّفت عنده.',
            ),
          },
        ],
        cta: { label: lt('Read our story', 'اقرأ قصّتنا') },
      },
    },
    // Chapter II — what every course carries, as an index.
    {
      type: 'features',
      starterContent: {
        title: lt('What you will find here', 'ما ستجده هنا'),
        description: lt(
          'The same care runs through every course.',
          'العناية نفسها حاضرة في كل دورة.',
        ),
        items: [
          {
            id: 'feature-outline',
            icon: 'BookOpen',
            title: lt('A written outline', 'مخطّط مكتوب'),
            description: lt(
              'Sections, lessons and level, listed before you enrol.',
              'الأقسام والدروس والمستوى، معروضة قبل التسجيل.',
            ),
          },
          {
            id: 'feature-instructors',
            icon: 'GraduationCap',
            title: lt('Named instructors', 'مدرّبون بأسمائهم'),
            description: lt(
              'Every course names the person who teaches it.',
              'تذكر كل دورة اسم من يقدّمها.',
            ),
          },
          {
            id: 'feature-devices',
            icon: 'Globe',
            title: lt('Learn from anywhere', 'تعلّم من أي مكان'),
            description: lt(
              'Lessons open on a phone, a tablet or a computer.',
              'تُفتح الدروس على الهاتف أو الجهاز اللوحي أو الحاسوب.',
            ),
          },
          {
            id: 'feature-correspondence',
            icon: 'Users',
            title: lt('Someone to write to', 'جهة تراسلها'),
            description: lt(
              'Send us a message whenever something is unclear.',
              'أرسل إلينا رسالة كلما احتجت إلى توضيح.',
            ),
          },
        ],
      },
    },
    // Chapter III — live categories (hidden publicly with fewer than two).
    {
      type: 'courseCategories',
      dynamicDefaults: { maxItems: 8, showCounts: true },
      starterContent: {
        title: lt('Browse by subject', 'تصفّح حسب الموضوع'),
        description: lt(
          'Each subject gathers the courses that belong together.',
          'يجمع كل موضوع الدورات التي تنتمي إليه.',
        ),
      },
    },
    // Chapter IV — live courses, as a contents page.
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
        title: lt('Recently published', 'صدر حديثًا'),
        description: lt(
          'The newest courses in our catalogue.',
          'أحدث الدورات في فهرسنا.',
        ),
      },
    },
    // Chapter V — the method, as a syllabus, beside its plate.
    {
      type: 'steps',
      assets: { image: asset('home-method') },
      starterContent: {
        title: lt('The method', 'المنهج'),
        description: lt(
          'Three movements, from the first page to the last.',
          'ثلاث مراحل، من الصفحة الأولى إلى الأخيرة.',
        ),
        items: [
          {
            id: 'step-read',
            title: lt('Read the outline', 'اقرأ المخطّط'),
            description: lt(
              'Open a course and see what it covers, its level and who teaches it.',
              'افتح الدورة واطّلع على ما تغطّيه ومستواها ومن يقدّمها.',
            ),
          },
          {
            id: 'step-work',
            title: lt('Work through the lessons', 'تابع الدروس'),
            description: lt(
              'Move section by section, in the order the course was written.',
              'انتقل من قسم إلى قسم، بالترتيب الذي كُتبت به الدورة.',
            ),
          },
          {
            id: 'step-finish',
            title: lt('Finish and apply', 'أنهِ وطبّق'),
            description: lt(
              'Complete the final lesson and put the ideas to use.',
              'أكمل الدرس الأخير وضع الأفكار موضع التطبيق.',
            ),
          },
        ],
      },
    },
    // Live instructors, as a masthead (hidden publicly when there are none).
    {
      type: 'instructors',
      dynamicDefaults: { count: 4 },
      starterContent: {
        title: lt('Who teaches here', 'من يعلّم هنا'),
        description: lt(
          'The people whose names appear on our courses.',
          'الأشخاص الذين تحمل دوراتنا أسماءهم.',
        ),
      },
    },
    // Live numbers (zeros hidden; hidden with fewer than two).
    LIVE_STATISTICS,
    // Sample testimonials: preview only until the Owner confirms them.
    {
      type: 'testimonials',
      starterContent: {
        title: lt('In their words', 'بكلماتهم'),
        items: [
          {
            id: 'sample-testimonial-1',
            sample: true,
            authorName: 'Layla K.',
            authorRole: lt('Illustrator', 'رسّامة'),
            quote: lt(
              'Nothing felt rushed. Each lesson left me with one thing to practise, and that was enough.',
              'لم يكن شيء على عجل. كان كل درس يترك لي أمرًا واحدًا أتدرّب عليه، وكان ذلك كافيًا.',
            ),
          },
          {
            id: 'sample-testimonial-2',
            sample: true,
            authorName: 'Omar S.',
            authorRole: lt('Architect', 'مهندس معماري'),
            quote: lt(
              'The outline told me exactly what the course would cover, and the course kept to it.',
              'أخبرني المخطّط بما ستغطّيه الدورة بالضبط، والتزمت الدورة به.',
            ),
          },
          {
            id: 'sample-testimonial-3',
            sample: true,
            authorName: 'Hana R.',
            authorRole: lt('Translator', 'مترجمة'),
            quote: lt(
              'It read like a well-edited book: clear, patient and easy to return to.',
              'كانت أشبه بكتاب محرَّر بعناية: واضحة وهادئة ويسهل الرجوع إليها.',
            ),
          },
        ],
      },
    },
    // Questions, as a teaser of the FAQs page.
    {
      type: 'faq',
      ctaTargets: { cta: 'faqs' },
      dynamicDefaults: { maxItems: 4 },
      starterContent: {
        title: lt('Questions & answers', 'أسئلة وأجوبة'),
        items: FAQ_ITEMS.slice(0, 4),
        cta: { label: lt('All questions', 'كل الأسئلة') },
      },
    },
    // The closing chapter.
    {
      type: 'cta',
      ctaTargets: { cta: 'signUp', secondaryCta: 'courses' },
      assets: { image: asset('home-cta') },
      starterContent: {
        title: lt('Begin your first chapter', 'ابدأ فصلك الأول'),
        description: lt(
          'Create an account, choose a course and turn to the first lesson.',
          'أنشئ حسابًا، واختر دورة، وافتح الدرس الأول.',
        ),
        cta: { label: lt('Create an account', 'أنشئ حسابًا') },
        secondaryCta: { label: lt('See the catalogue', 'اطّلع على الفهرس') },
      },
    },
  ],
};

/** About: the masthead, an editorial lede, then the story behind the courses. */
const about: WebsiteTemplatePage = {
  coreType: 'about',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'none' },
      assets: { image: asset('about-header') },
      starterContent: {
        eyebrow: lt('About {{academyName}}', 'عن {{academyName}}'),
        title: lt('A studio for learning', 'استوديو للتعلّم'),
        description: lt(
          '{{academyName}} publishes online courses for people who like to learn with attention.',
          'تنشر {{academyName}} دورات عبر الإنترنت لمن يحبّ أن يتعلّم بانتباه.',
        ),
      },
    },
    {
      type: 'about',
      starterContent: {
        title: lt('Why we teach the way we do', 'لماذا نعلّم بهذه الطريقة'),
        body: lt(
          "We think a course should read like a good book: it knows where it begins, it moves in a sensible order and it respects the reader's time. That is the standard we hold our courses to.",
          'نرى أن الدورة ينبغي أن تُقرأ ككتاب جيّد: تعرف من أين تبدأ، وتمضي بترتيب منطقي، وتحترم وقت قارئها. وهذا هو المعيار الذي نلتزم به في دوراتنا.',
        ),
      },
    },
    {
      type: 'featureSplit',
      dynamicDefaults: { imagePosition: 'end' },
      assets: { image: asset('about-story') },
      starterContent: {
        eyebrow: lt('Our story', 'قصّتنا'),
        title: lt('How a course comes together', 'كيف تُصنع الدورة'),
        description: lt(
          'Before a course is published, we decide what it should cover and in what order. The outline comes first; the lessons follow it.',
          'قبل نشر أي دورة، نحدّد ما ينبغي أن تغطّيه وبأي ترتيب. يأتي المخطّط أولًا، ثم تتبعه الدروس.',
        ),
        items: [
          {
            id: 'story-outline',
            title: lt('An outline first', 'المخطّط أولًا'),
            description: lt(
              'Each course starts as a list of sections and lessons.',
              'تبدأ كل دورة قائمةً من الأقسام والدروس.',
            ),
          },
          {
            id: 'story-clarity',
            title: lt('Clarity over volume', 'الوضوح قبل الكثرة'),
            description: lt(
              'We try to keep every lesson focused on one idea.',
              'نحرص على أن يركّز كل درس على فكرة واحدة.',
            ),
          },
          {
            id: 'story-suggestions',
            title: lt('Open to suggestions', 'منفتحون على الاقتراحات'),
            description: lt(
              'Tell us which subjects you would like to see next.',
              'أخبرنا بالموضوعات التي تودّ أن تراها لاحقًا.',
            ),
          },
        ],
      },
    },
    {
      type: 'features',
      starterContent: {
        title: lt('What we hold to', 'ما نلتزم به'),
        description: lt(
          'Three principles behind every course.',
          'ثلاثة مبادئ وراء كل دورة.',
        ),
        items: [
          {
            id: 'value-care',
            icon: 'Award',
            title: lt('Care', 'العناية'),
            description: lt(
              'We look closely at every course before it is published.',
              'ننظر في كل دورة بعناية قبل نشرها.',
            ),
          },
          {
            id: 'value-clarity',
            icon: 'Sparkles',
            title: lt('Clarity', 'الوضوح'),
            description: lt(
              'Each course says plainly what it covers.',
              'تقول كل دورة بوضوح ما تغطّيه.',
            ),
          },
          {
            id: 'value-conversation',
            icon: 'Users',
            title: lt('Conversation', 'الحوار'),
            description: lt(
              'Questions and suggestions are welcome.',
              'الأسئلة والاقتراحات موضع ترحيب.',
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
        title: lt('The people behind the courses', 'الأشخاص وراء الدورات'),
        description: lt(
          'The instructors who teach at {{academyName}}.',
          'المدرّبون الذين يعلّمون في {{academyName}}.',
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
        title: lt('From the studio', 'من الاستوديو'),
      },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'courses', secondaryCta: 'contact' },
      starterContent: {
        title: lt('Continue to the catalogue', 'تابع إلى فهرس الدورات'),
        description: lt(
          'Every course, set out with its outline and level.',
          'كل الدورات، معروضة بمخطّطها ومستواها.',
        ),
        cta: { label: lt('Browse the courses', 'استعرض الدورات') },
        secondaryCta: { label: lt('Write to us', 'راسلنا') },
      },
    },
  ],
};

/** Courses: the masthead's search drives the catalogue below it. */
const courses: WebsiteTemplatePage = {
  coreType: 'courses',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'courses' },
      starterContent: {
        eyebrow: lt('The catalogue', 'الفهرس'),
        title: lt('Every course, in one index', 'كل الدورات في فهرس واحد'),
        description: lt(
          'Search by title, narrow by subject or level, and open any course to read its outline.',
          'ابحث بالعنوان، وضيّق النتائج حسب الموضوع أو المستوى، وافتح أي دورة لتقرأ مخطّطها.',
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
      starterContent: { title: lt('Index of courses', 'فهرس الدورات') },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt('Unsure where to begin?', 'حائر في نقطة البداية؟'),
        description: lt(
          'Write to us about what you would like to learn.',
          'راسلنا بما تودّ تعلّمه.',
        ),
        cta: { label: lt('Write to us', 'راسلنا') },
      },
    },
  ],
};

/** FAQs: the masthead's filter narrows the questions below. */
const faqs: WebsiteTemplatePage = {
  coreType: 'faqs',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'faq' },
      starterContent: {
        eyebrow: lt('Questions', 'أسئلة'),
        title: lt('Questions & answers', 'أسئلة وأجوبة'),
        description: lt(
          'Short answers about courses, access and enrolling.',
          'إجابات موجزة عن الدورات والوصول إليها والتسجيل فيها.',
        ),
      },
    },
    { type: 'faq', starterContent: { items: FAQ_ITEMS } },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt('Another question?', 'سؤال آخر؟'),
        description: lt('Write to us and ask.', 'راسلنا واطرح سؤالك.'),
        cta: { label: lt('Write to us', 'راسلنا') },
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
      starterContent: {
        eyebrow: lt('Correspondence', 'مراسلات'),
        title: lt('Write to us', 'راسلنا'),
        description: lt(
          'A question about a course, a group enrolment or anything else — send us a note.',
          'سؤال عن دورة، أو تسجيل مجموعة، أو أي أمر آخر — أرسل إلينا رسالة.',
        ),
      },
    },
    {
      type: 'contact',
      dynamicDefaults: { showForm: true },
      starterContent: {
        title: lt('Our details', 'بياناتنا'),
        description: lt(
          'Use our contact details, or leave a message with the form.',
          'استخدم بيانات التواصل، أو اترك رسالة عبر النموذج.',
        ),
      },
    },
    {
      type: 'faq',
      ctaTargets: { cta: 'faqs' },
      dynamicDefaults: { maxItems: 3 },
      starterContent: {
        title: lt('Before you write', 'قبل أن تراسلنا'),
        items: FAQ_ITEMS.slice(0, 5),
        cta: { label: lt('All questions', 'كل الأسئلة') },
      },
    },
  ],
};

export const atelierTemplate: WebsiteTemplateDefinition = {
  themeKey: 'atelier',
  version: 1,
  pages: [home, about, courses, faqs, contact],
};
