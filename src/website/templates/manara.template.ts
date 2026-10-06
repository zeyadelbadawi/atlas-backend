/**
 * Manara (Theme 3) — starter content, template v1.
 *
 * The composition the Manara renderers are designed on (frontend repo,
 * Reports/THEME_3_MANARA_PLAN.md §3.10–§3.11): Home is proof-first — the
 * stage (`hero`), the scoreboard (`statistics`), the tracks
 * (`courseCategories`), what is enrolling now (`featuredCourses`), how we
 * teach (`featureSplit`), three steps (`steps`), what's included
 * (`features`), students' words (`testimonials`), the teachers
 * (`instructors`), questions before you join (`faq`) and the closing block
 * (`cta`). Every inner page opens with its banner block (`pageHeader`).
 *
 * The voice is energetic, direct and student-facing ("you"): a teacher on
 * stage speaking to students on their phones in exam season. Exam-season
 * register is flavour only — no grade year, subject or exam is hardcoded,
 * so a tutoring centre, a language school or a bootcamp reads just as
 * well. The safety rules are Theme 1's, unchanged
 * (`modern-education.template.ts`):
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
 * and asserts nothing a given Academy may not offer — results, scores,
 * certificates, response times, free courses, which payment methods are
 * on: where a feature depends on the Academy (live sessions, practice
 * exams, payment methods) the copy says "where a course includes…" or
 * "may include…" and points at the course page, which is the source of
 * truth. The one open claim, "Enrolment is open", is the plan's own closing
 * block (§3.10 #11) — an Owner whose enrolment is closed edits the title.
 */
import type {
  WebsiteTemplateDefinition,
  WebsiteTemplatePage,
  WebsiteTemplateSection,
} from './website-template.types';
import { lt } from './template-content.util';

const asset = (key: string): string => `theme-asset:manara/${key}`;

/** Live statistics (the scoreboard): the metric only — labels are the one authored part. */
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
        label: lt('Students', 'الطلاب'),
      },
      {
        id: 'stat-instructors',
        metric: 'instructors',
        value: lt(''),
        label: lt('Teachers', 'المعلّمون'),
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
    id: 'faq-recorded',
    question: lt('Are the lessons recorded?', 'هل الدروس مسجّلة؟'),
    answer: lt(
      'Recorded lessons are videos you open whenever suits you: pause, rewind and come back to the hard parts as often as you need. Each course page lists exactly what it includes.',
      'الدروس المسجّلة مقاطع مصوّرة تفتحها في الوقت الذي يناسبك: أوقفها وأعدها وارجع إلى الأجزاء الصعبة كلما احتجت. وتعرض صفحة كل دورة ما تتضمّنه بالضبط.',
    ),
  },
  {
    id: 'faq-live',
    question: lt('Are there live sessions?', 'هل توجد حصص مباشرة؟'),
    answer: lt(
      'Some courses add live sessions at a set date and time. If a course has them, you will see them on its page, and you join from inside the course when the session starts.',
      'تضيف بعض الدورات حصصًا مباشرة في موعد محدّد. إن كانت الدورة تتضمّنها فستجدها في صفحتها، وتنضمّ إليها من داخل الدورة عند بدئها.',
    ),
  },
  {
    id: 'faq-practice',
    question: lt('How do I practise before the exam?', 'كيف أتدرّب قبل الامتحان؟'),
    answer: lt(
      'Courses that include practice questions or mock exams list them in their curriculum. You take them on your phone or computer, and your attempts are saved so you can see how you are doing.',
      'الدورات التي تتضمّن أسئلة تدريب أو امتحانات تجريبية تعرضها في منهجها. تؤدّيها على هاتفك أو حاسوبك، وتُحفظ محاولاتك لترى مستواك.',
    ),
  },
  {
    id: 'faq-pay',
    question: lt('How do I pay?', 'كيف أدفع؟'),
    answer: lt(
      'Open the course and press Enrol. The payment methods available are shown at that step and may include a mobile wallet, InstaPay or a bank transfer. If you pay by transfer, upload a photo of the receipt; your enrolment is confirmed once it has been checked.',
      'افتح الدورة واضغط «سجّل». تظهر طرق الدفع المتاحة في تلك الخطوة، وقد تشمل المحفظة الإلكترونية أو إنستاباي أو التحويل البنكي. وإذا دفعت بالتحويل فارفع صورة الإيصال، ويُؤكَّد تسجيلك بعد مراجعته.',
    ),
  },
  {
    id: 'faq-parent',
    question: lt(
      'I am a parent. Can I enrol my child?',
      'أنا وليّ أمر، هل يمكنني تسجيل ابني؟',
    ),
    answer: lt(
      "Yes. Create the account in the student's name so the lessons and progress stay theirs, then enrol in the course and complete the payment. If anything is unclear, write to us through the Contact page.",
      'نعم. أنشئ الحساب باسم الطالب حتى تبقى الدروس والتقدّم باسمه، ثم سجّل في الدورة وأكمل الدفع. وإن كان أي أمر غير واضح فراسلنا عبر صفحة «تواصل معنا».',
    ),
  },
  {
    id: 'faq-levels',
    question: lt(
      'Which years and levels do you teach?',
      'ما الصفوف والمستويات التي تدرّسونها؟',
    ),
    answer: lt(
      'Every course page says which year or level it is for. Open the Courses page and filter by level to find yours.',
      'تذكر صفحة كل دورة الصفّ أو المستوى الموجّهة إليه. افتح صفحة الدورات وصفِّ النتائج حسب المستوى لتجد ما يناسبك.',
    ),
  },
  {
    id: 'faq-devices',
    question: lt('Can I study on my phone?', 'هل يمكنني المذاكرة من هاتفي؟'),
    answer: lt(
      'Yes. Lessons open on phones, tablets and computers, and your progress follows you from one device to the next.',
      'نعم. تُفتح الدروس على الهواتف والأجهزة اللوحية والحواسيب، ويرافقك تقدّمك من جهاز إلى آخر.',
    ),
  },
  {
    id: 'faq-help',
    question: lt('What if I get stuck on a lesson?', 'ماذا لو تعثّرت في درس؟'),
    answer: lt(
      'Watch it again first — that is what recorded lessons are for. If it still does not click, write to us through the Contact page and name the course and the lesson.',
      'شاهده مرة أخرى أولًا؛ فهذا ما وُجدت الدروس المسجّلة لأجله. وإن بقي غامضًا فراسلنا عبر صفحة «تواصل معنا» واذكر الدورة والدرس.',
    ),
  },
] as const;

const home: WebsiteTemplatePage = {
  coreType: 'home',
  sections: [
    // 1 — The stage: the headline, the first action, the proof pills.
    {
      type: 'hero',
      ctaTargets: { cta: 'signUp', secondaryCta: 'courses' },
      dynamicDefaults: { showSearch: true },
      assets: {
        image: asset('home-hero'),
        imageAlt: lt(
          'A desk lamp lighting notebooks and a blank exam sheet',
          'مصباح مكتب يضيء دفاتر وورقة امتحان فارغة',
        ),
      },
      starterContent: {
        eyebrow: lt(
          '{{academyName}} — learn with your teacher',
          '{{academyName}} — تعلّم مع معلّمك',
        ),
        title: lt(
          'Understand the lesson. Practise it. Walk into the exam ready.',
          'افهم الدرس، وتدرّب عليه، وادخل الامتحان واثقًا',
        ),
        highlight: lt('Walk into the exam ready.', 'وادخل الامتحان واثقًا'),
        subtitle: lt(
          "Your teacher's lessons, practice questions and progress, all in one place on your phone.",
          'دروس معلّمك وأسئلة التدريب وتقدّمك، كلّها في مكان واحد على هاتفك.',
        ),
        description: lt(
          'Watch the explanation, work through the questions and see exactly where you stand before the exam. {{academyName}} brings the class to wherever you are.',
          'شاهد الشرح، وحلّ الأسئلة، واعرف موقعك بالضبط قبل الامتحان. {{academyName}} تنقل الفصل إلى حيث تكون.',
        ),
        cta: { label: lt('Join now', 'انضمّ الآن') },
        secondaryCta: { label: lt('Browse courses', 'تصفّح الدورات') },
        highlights: [
          {
            id: 'hl-phone',
            label: lt('Lessons on your phone', 'الدروس على هاتفك'),
          },
          {
            id: 'hl-practice',
            label: lt('Practice before the exam', 'تدرّب قبل الامتحان'),
          },
          {
            id: 'hl-progress',
            label: lt('Progress you can see', 'تقدّم تراه بعينك'),
          },
        ],
      },
    },
    // 2 — The scoreboard: live numbers (zeros hidden; hidden with fewer than two).
    LIVE_STATISTICS,
    // 3 — Pick your track: live categories (hidden publicly with fewer than two).
    {
      type: 'courseCategories',
      dynamicDefaults: { maxItems: 8, showCounts: true },
      starterContent: {
        title: lt('Pick your track', 'اختر مسارك'),
        description: lt(
          'Find the subject or level you need and open its courses.',
          'اختر المادة أو المستوى الذي تحتاجه وافتح دوراته.',
        ),
      },
    },
    // 4 — Now enrolling: live courses as poster cards.
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
        title: lt('Now enrolling', 'متاح للتسجيل الآن'),
        description: lt(
          'The latest courses from {{academyName}}.',
          'أحدث دورات {{academyName}}.',
        ),
      },
    },
    // 5 — How we teach: the slanted plate and three numbered points.
    {
      type: 'featureSplit',
      dynamicDefaults: { imagePosition: 'start' },
      assets: {
        image: asset('home-benefit'),
        imageAlt: lt(
          'A lecture hall seen from the back rows under a single projector light',
          'قاعة محاضرات من الصفوف الخلفية تحت ضوء جهاز عرض واحد',
        ),
      },
      starterContent: {
        eyebrow: lt('Our method', 'طريقتنا'),
        title: lt('How we teach', 'كيف نعلّم'),
        description: lt(
          'Explain, practise, check — every lesson is built to be understood, not just watched.',
          'شرح، ثم تدريب، ثم مراجعة — كل درس مبنيّ ليُفهم لا ليُشاهد فقط.',
        ),
        items: [
          {
            id: 'method-explain',
            title: lt('Clear explanation first', 'الشرح الواضح أولًا'),
            description: lt(
              'Every lesson explains the idea step by step, at a pace you can rewind.',
              'يشرح كل درس الفكرة خطوة بخطوة، بإيقاع يمكنك إعادته متى شئت.',
            ),
          },
          {
            id: 'method-practise',
            title: lt('Then you practise', 'ثم تتدرّب'),
            description: lt(
              'Questions after the lesson show you what stuck and what needs another look.',
              'تكشف لك الأسئلة بعد الدرس ما رسخ وما يحتاج إلى نظرة أخرى.',
            ),
          },
          {
            id: 'method-track',
            title: lt('Nothing left behind', 'لا شيء يُترك خلفك'),
            description: lt(
              'Your progress shows which lessons are done and which are still waiting.',
              'يعرض تقدّمك الدروس التي أنهيتها وتلك التي لا تزال تنتظرك.',
            ),
          },
        ],
      },
    },
    // 6 — Start in three steps: join → learn → practise.
    {
      type: 'steps',
      starterContent: {
        title: lt('Start in three steps', 'ابدأ في ثلاث خطوات'),
        description: lt(
          'From creating your account to your first lesson.',
          'من إنشاء حسابك إلى درسك الأول.',
        ),
        items: [
          {
            id: 'step-join',
            title: lt('Join', 'انضمّ'),
            description: lt('Create your account in your own name.', 'أنشئ حسابك باسمك.'),
          },
          {
            id: 'step-learn',
            title: lt('Learn', 'تعلّم'),
            description: lt(
              'Pick a course, enrol and start the first lesson on any device.',
              'اختر دورة، وسجّل فيها، وابدأ الدرس الأول على أي جهاز.',
            ),
          },
          {
            id: 'step-practise',
            title: lt('Practise', 'تدرّب'),
            description: lt(
              'Answer the questions after each lesson and watch your progress fill up before the exam.',
              'حلّ الأسئلة بعد كل درس وراقب تقدّمك يكتمل قبل الامتحان.',
            ),
          },
        ],
      },
    },
    // 7 — What's included: four icon tiles, platform-true copy.
    {
      type: 'features',
      starterContent: {
        title: lt("What's included", 'ما الذي تحصل عليه'),
        description: lt(
          'Everything a class needs, on your phone.',
          'كل ما يحتاجه الفصل، على هاتفك.',
        ),
        items: [
          {
            id: 'feature-video',
            icon: 'Video',
            title: lt('Video lessons on your phone', 'دروس مصوّرة على هاتفك'),
            description: lt(
              'Watch, pause and rewind the explanation as many times as you need.',
              'شاهد الشرح وأوقفه وأعده كما تشاء.',
            ),
          },
          {
            id: 'feature-practice',
            icon: 'ShieldCheck',
            title: lt('Practice and exams', 'تدريب وامتحانات'),
            description: lt(
              'Practice questions and exams you take from wherever you are.',
              'أسئلة تدريب وامتحانات تؤدّيها من مكانك.',
            ),
          },
          {
            id: 'feature-progress',
            icon: 'Sparkles',
            title: lt('Progress you can see', 'تقدّم تراه بعينك'),
            description: lt(
              'Every finished lesson and every attempt is recorded, so you know where you stand.',
              'يُسجَّل كل درس تنهيه وكل محاولة، فتعرف أين تقف.',
            ),
          },
          {
            id: 'feature-help',
            icon: 'Headphones',
            title: lt("Help when you're stuck", 'مساعدة عندما تتعثّر'),
            description: lt(
              'Write to us through the Contact page and tell us which lesson.',
              'راسلنا عبر صفحة التواصل وأخبرنا بالدرس الذي تعثّرت فيه.',
            ),
          },
        ],
      },
    },
    // 8 — Students say: sample testimonials, preview only until the Owner confirms them.
    {
      type: 'testimonials',
      starterContent: {
        title: lt('Students say', 'يقول الطلاب'),
        items: [
          {
            id: 'sample-testimonial-1',
            sample: true,
            authorName: 'Mariam A.',
            authorRole: lt('Secondary-school student', 'طالبة في المرحلة الثانوية'),
            quote: lt(
              'I watched the lessons on the bus and solved the questions at night. For the first time the whole subject was in one place.',
              'كنت أشاهد الدروس في الطريق وأحلّ الأسئلة ليلًا. لأول مرة كانت المادة كلّها في مكان واحد.',
            ),
          },
          {
            id: 'sample-testimonial-2',
            sample: true,
            authorName: 'Ahmed S.',
            authorRole: lt('Parent', 'وليّ أمر'),
            quote: lt(
              'Enrolling my son took a few minutes, and he started the first lesson the same evening.',
              'استغرق تسجيل ابني دقائق، وبدأ الدرس الأول في المساء نفسه.',
            ),
          },
          {
            id: 'sample-testimonial-3',
            sample: true,
            authorName: 'Youssef M.',
            authorRole: lt('University applicant', 'متقدّم للجامعة'),
            quote: lt(
              'The practice questions showed me exactly which chapters I had been avoiding.',
              'أظهرت لي أسئلة التدريب بالضبط أيّ الفصول كنت أتجنّبها.',
            ),
          },
        ],
      },
    },
    // 9 — Your teachers: live instructors (hidden publicly when there are none).
    {
      type: 'instructors',
      dynamicDefaults: { count: 4 },
      starterContent: {
        title: lt('Your teachers', 'معلّموك'),
        description: lt(
          'The people behind the lessons at {{academyName}}.',
          'من يقف وراء دروس {{academyName}}.',
        ),
      },
    },
    // 10 — Before you join: a teaser of the FAQs page.
    {
      type: 'faq',
      ctaTargets: { cta: 'contact' },
      dynamicDefaults: { maxItems: 4 },
      starterContent: {
        title: lt('Before you join', 'قبل أن تنضمّ'),
        items: FAQ_ITEMS.slice(0, 4),
        cta: { label: lt('Ask us', 'اسألنا') },
      },
    },
    // 11 — The closing block.
    {
      type: 'cta',
      ctaTargets: { cta: 'signUp', secondaryCta: 'contact' },
      assets: {
        image: asset('home-cta'),
        imageAlt: lt(
          'Stacked plain textbooks under a warm desk lamp',
          'كتب مدرسية مكدّسة تحت ضوء مصباح مكتب دافئ',
        ),
      },
      starterContent: {
        title: lt('Enrolment is open', 'باب التسجيل مفتوح'),
        description: lt(
          'Create your account, pick your course and start the first lesson today.',
          'أنشئ حسابك، واختر دورتك، وابدأ الدرس الأول اليوم.',
        ),
        cta: { label: lt('Join now', 'انضمّ الآن') },
        secondaryCta: { label: lt('Contact us', 'تواصل معنا') },
      },
    },
  ],
};

/** About: the banner block, the story, the values, the numbers, the teachers, the gallery, the close. */
const about: WebsiteTemplatePage = {
  coreType: 'about',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'none' },
      assets: {
        image: asset('about-header'),
        imageAlt: lt(
          'A blank whiteboard with markers under a spotlight',
          'سبّورة بيضاء فارغة وأقلام تحت ضوء مسلّط',
        ),
      },
      starterContent: {
        eyebrow: lt('About {{academyName}}', 'عن {{academyName}}'),
        title: lt('A classroom that fits in your pocket', 'فصل دراسي في جيبك'),
        description: lt(
          "{{academyName}} takes the teacher's lessons online, so students can study, practise and keep up from wherever they are.",
          'تنقل {{academyName}} دروس المعلّم إلى الإنترنت، ليذاكر الطلاب ويتدرّبوا ويواكبوا الدروس من أي مكان.',
        ),
      },
    },
    {
      type: 'featureSplit',
      dynamicDefaults: { imagePosition: 'end' },
      assets: {
        image: asset('about-story'),
        imageAlt: lt(
          "A teacher's silhouette from behind, facing a blank board",
          'ظلّ معلّم من الخلف أمام سبّورة فارغة',
        ),
      },
      starterContent: {
        eyebrow: lt('Our story', 'قصّتنا'),
        title: lt('From the classroom to your phone', 'من الفصل إلى هاتفك'),
        description: lt(
          'The lessons started in a real classroom. Moving them online meant every student could get the same explanation, the same questions and the same follow-up on their progress.',
          'بدأت الدروس في فصل حقيقي، ونقلها إلى الإنترنت يعني أن يحصل كل طالب على الشرح نفسه والأسئلة نفسها والمتابعة نفسها لتقدّمه.',
        ),
        items: [
          {
            id: 'story-one-place',
            title: lt('One place for everything', 'مكان واحد لكل شيء'),
            description: lt(
              'Lessons, questions and progress, instead of scattered chats.',
              'الدروس والأسئلة والتقدّم، بدلًا من محادثات متفرّقة.',
            ),
          },
          {
            id: 'story-same-lesson',
            title: lt('The same lesson for everyone', 'الدرس نفسه للجميع'),
            description: lt(
              'Whether you join first or last, you get the full explanation.',
              'سواء انضممت أولًا أو أخيرًا، تحصل على الشرح كاملًا.',
            ),
          },
          {
            id: 'story-exam-season',
            title: lt('Built for exam season', 'مبنيّ لموسم الامتحانات'),
            description: lt(
              'Practice and revision are part of the course, not an afterthought.',
              'التدريب والمراجعة جزء من الدورة، لا إضافة لاحقة.',
            ),
          },
        ],
      },
    },
    {
      type: 'features',
      starterContent: {
        title: lt('Four things we stand for', 'أربعة أشياء نؤمن بها'),
        description: lt(
          'Four things every lesson here is built on.',
          'أربعة أمور يقوم عليها كل درس هنا.',
        ),
        items: [
          {
            id: 'value-clarity',
            icon: 'BookOpen',
            title: lt('Understanding', 'الفهم'),
            description: lt(
              'A lesson is finished when it is understood, not when it ends.',
              'ينتهي الدرس عندما يُفهم، لا عندما يتوقّف.',
            ),
          },
          {
            id: 'value-practice',
            icon: 'ShieldCheck',
            title: lt('Practice', 'التدريب'),
            description: lt(
              'Questions are how you find out what you actually know.',
              'الأسئلة هي الطريقة التي تعرف بها ما تعرفه فعلًا.',
            ),
          },
          {
            id: 'value-consistency',
            icon: 'Clock',
            title: lt('Consistency', 'الانتظام'),
            description: lt(
              'A little every day beats a lot the night before.',
              'قليل كل يوم خير من كثير في الليلة الأخيرة.',
            ),
          },
          {
            id: 'value-respect',
            icon: 'Users',
            title: lt('Respect', 'الاحترام'),
            description: lt(
              'Every student and every parent deserves a straight answer.',
              'كل طالب وكل وليّ أمر يستحقّ إجابة واضحة.',
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
        title: lt('Who teaches at {{academyName}}', 'من يُدرّس في {{academyName}}'),
        description: lt(
          'The people who teach the courses at {{academyName}}.',
          'من يعلّمون الدورات في {{academyName}}.',
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
              'Hands writing in a notebook under a desk lamp',
              'يدان تكتبان في دفتر تحت ضوء مصباح مكتب',
            ),
          },
          {
            id: 'gallery-2',
            image: asset('gallery-2'),
            imageAlt: lt(
              'A lecture hall seen from the back rows',
              'قاعة محاضرات من الصفوف الخلفية',
            ),
          },
          {
            id: 'gallery-3',
            image: asset('gallery-3'),
            imageAlt: lt(
              'Markers lined up beneath a blank whiteboard',
              'أقلام مصفوفة أسفل سبّورة بيضاء فارغة',
            ),
          },
          {
            id: 'gallery-4',
            image: asset('gallery-4'),
            imageAlt: lt(
              'A phone face down beside open notes',
              'هاتف مقلوب بجوار أوراق مفتوحة',
            ),
          },
          {
            id: 'gallery-5',
            image: asset('gallery-5'),
            imageAlt: lt('A tutoring-centre corridor at night', 'ممرّ مركز تعليمي ليلًا'),
          },
        ],
      },
      starterContent: {
        title: lt('After hours', 'بعد انتهاء اليوم'),
      },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'courses', secondaryCta: 'contact' },
      starterContent: {
        title: lt('Find your course', 'اعثر على دورتك'),
        description: lt(
          'Browse by subject and level, then join from the course page.',
          'تصفّح حسب المادة والمستوى، ثم انضمّ من صفحة الدورة.',
        ),
        cta: { label: lt('Browse courses', 'تصفّح الدورات') },
        secondaryCta: { label: lt('Contact us', 'تواصل معنا') },
      },
    },
  ],
};

/** Courses: the banner's search drives the catalogue below it. */
const courses: WebsiteTemplatePage = {
  coreType: 'courses',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'courses' },
      starterContent: {
        eyebrow: lt('Courses', 'الدورات'),
        title: lt('Every course, one list', 'كل الدورات في قائمة واحدة'),
        description: lt(
          'Search by name, filter by level or price, and open any course to see its lessons before you join.',
          'ابحث بالاسم، وصفِّ النتائج حسب المستوى أو السعر، وافتح أي دورة لترى دروسها قبل أن تنضمّ.',
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
      starterContent: { title: lt('All courses', 'كل الدورات') },
    },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt("Can't find your subject?", 'لم تجد مادّتك؟'),
        description: lt(
          'Tell us what you are studying and which year you are in.',
          'أخبرنا بما تدرسه وفي أي صفّ أنت.',
        ),
        cta: { label: lt('Contact us', 'تواصل معنا') },
      },
    },
  ],
};

/** FAQs: the banner's filter narrows the questions below. */
const faqs: WebsiteTemplatePage = {
  coreType: 'faqs',
  sections: [
    {
      type: 'pageHeader',
      dynamicDefaults: { search: 'faq' },
      starterContent: {
        eyebrow: lt('FAQ', 'الأسئلة الشائعة'),
        title: lt('Your questions, answered', 'أسئلتك وإجاباتها'),
        description: lt(
          'Lessons, exams, payment and how to get help.',
          'الدروس والامتحانات والدفع وكيف تطلب المساعدة.',
        ),
      },
    },
    { type: 'faq', starterContent: { items: FAQ_ITEMS } },
    {
      type: 'cta',
      ctaTargets: { cta: 'contact' },
      starterContent: {
        title: lt("Didn't find your answer?", 'لم تجد إجابتك؟'),
        description: lt(
          'Write to us and tell us which course you mean.',
          'راسلنا واذكر الدورة التي تقصدها.',
        ),
        cta: { label: lt('Contact us', 'تواصل معنا') },
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
        eyebrow: lt('Contact', 'تواصل'),
        title: lt('Send us your question', 'أرسل إلينا سؤالك'),
        description: lt(
          'A question about a course, a payment or enrolling a student — send it here.',
          'سؤال عن دورة أو دفعة أو تسجيل طالب — أرسله من هنا.',
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

export const manaraTemplate: WebsiteTemplateDefinition = {
  themeKey: 'manara',
  version: 1,
  pages: [home, about, courses, faqs, contact],
};
