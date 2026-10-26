-- B3 (DL-66) — the blog's first 11 posts (EN + AR), published, as the
-- owner decided on 26 Oct 2026. Data only; additive; idempotent.
--
-- * Written as the first active Platform Owner (created_by/updated_by are
--   NOT NULL). With no Platform Owner (a fresh database) nothing is
--   inserted, so the migration never fails.
-- * `ON CONFLICT ("slug") DO NOTHING`: a post the owner already created or
--   edited with the same slug is never overwritten.
-- * Ids are deterministic (UUIDv5 of the slug) so `related_post_ids` can
--   reference posts inserted in the same statement.
-- * Reading minutes use the API's rule (words / 200, rounded up, ≥ 1).
-- * Cover images ship with the frontend under /marketing-assets/blog/.
-- * Content source: scratchpad b3/content/posts.json, validated by the
--   API's own rules (`npm run db:seed-blog-posts` dry run).

WITH owner AS (
  SELECT "id" FROM "users"
   WHERE "is_platform_owner" = true AND "status" = 'active'
   ORDER BY "created_at" ASC
   LIMIT 1
), data ("id","slug","kind","topic","status","publish_at","published_at","featured","cover_image_url","cover_image_width","cover_image_height","author_name","related_post_ids","title_en","excerpt_en","body_en","cover_alt_en","seo_title_en","seo_description_en","reading_minutes_en","title_ar","excerpt_ar","body_ar","cover_alt_ar","seo_title_ar","seo_description_ar","reading_minutes_ar") AS (
  VALUES
  ($atlasblog$9f9b6dcd-ebd3-5061-8e0f-e2e8d2d628db$atlasblog$,
   $atlasblog$how-to-protect-paid-courses-from-leaks$atlasblog$,
   $atlasblog$pillar$atlasblog$::"platform_blog_post_kind",
   $atlasblog$protection$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-05T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-05T08:00:00Z$atlasblog$::timestamp,
   true,
   $atlasblog$/marketing-assets/blog/how-to-protect-paid-courses-from-leaks.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$5ae035f1-0fe2-50cb-ac85-689682b880a2$atlasblog$,$atlasblog$5b2b0f14-bf04-5f81-869c-30f3d565432f$atlasblog$,$atlasblog$d4375d4e-64a1-5988-955a-819100fa6442$atlasblog$]::TEXT[],
   $atlasblog$How to protect paid courses from leaks: what works and what doesn't$atlasblog$,
   $atlasblog$Lessons leak through shared logins, copied links, screen recording and phone cameras. See which measures prevent, deter or trace each route, and what none of them can stop.$atlasblog$,
   $atlasblog$You recorded a full term of lessons, students paid for them, and a few weeks later someone tells you the videos are on a Telegram channel. Most teachers who sell online have either lived this or worry about it. The honest answer is that no measure stops every leak. Some measures prevent one kind of sharing, some only discourage it, and some help you find where a copy came from. Knowing which is which saves you money and saves your students a lot of friction.

## How lessons actually leak

Before choosing any protection, it helps to name the routes. Paid lessons usually escape in one of five ways:

- **A shared login.** One student pays and gives the password to friends, a cousin or a whole group.
- **A copied link.** If the video sits on a public platform, the link itself can be passed around.
- **Screen recording.** Software on the laptop or phone records the lesson while it plays.
- **A phone filming the screen.** A second device pointed at the screen needs no software at all.
- **Re-upload.** Whatever was copied ends up on Telegram, YouTube or a Facebook group.

Each route needs a different answer. A rule that stops shared logins does nothing about a phone camera, and a tool that blocks one recording program does nothing about a shared password.

## Prevent, deter, trace: three different jobs

It is useful to sort every measure into one of three jobs.

1. **Prevent.** The measure makes a route impossible or close to it. Checking that only enrolled students can open a lesson is prevention.
2. **Deter.** The measure makes sharing inconvenient or risky, so fewer people try. Device limits and a visible code on the video are deterrents.
3. **Trace.** When a copy appears anyway, the measure helps you work out which account it came from.

Very little on the web falls in the first group. Most real protection lives in the second and third. A plan that admits this is easier to explain to students and holds up better when a leak happens.

## Measure by measure: the honest table

| Measure | What it stops | What it misses | What it costs you |
|---|---|---|---|
| Unlisted video links | People finding the video by search | Anyone who has the link can watch it | Almost nothing |
| One account per student | Casual password sharing, if enforced | Two people taking turns on the same device | Some support questions |
| Device limits and one screen at a time | One account watched on many devices at once | Screen recording and filming | Students who change browsers use up slots |
| Anti-recording plugins and DRM | Some recording software in some browsers | A phone camera, and many other tools | Cost, setup, and playback problems for some students |
| A visible viewer code on the video | Makes a recording traceable and sharing risky | Does not stop the recording itself | Students see the code while they watch |
| Takedown requests | A specific copy on a specific site | Copies elsewhere, and new uploads | Your time, after the fact |

### Unlisted links

An unlisted YouTube video does not appear in search or on your channel, but anyone with the link can watch it. That makes it fine for keeping lessons out of public view and weak as a lock. Treat unlisted as "not advertised", never as "private".

### One account per student and device limits

Giving each student their own account, then limiting how many devices that account can use and letting lessons play on only one screen at a time, makes a shared password annoying for everyone using it. It will not stop two siblings taking turns on one laptop, and a student who clears their browser or switches browsers may hit the limit innocently. Set the limit so a normal student with a phone and a laptop never notices it. We cover fair device rules in more detail in a separate guide.

### Anti-recording plugins and DRM

No web page can fully stop screen recording or a phone camera pointed at the screen. Recording tools run on the student's own device, outside the page's control, and a second phone needs no software at all. Some tools block certain recording programs in certain browsers, which is why their marketing can sound convincing. If you buy one, buy it for what it does, and do not tell students their lessons "cannot be recorded". Our post [Can you stop screen recording of online lessons?](/blog/can-you-stop-screen-recording) goes through this in detail.

### Visible viewer codes

A visible code drawn over the video, tied to the student who is watching, does two things. Students know that any recording they make carries their own code, which discourages sharing. And if a recording leaks with the code still readable, the code points back to an account. It points to an account and a session, not to a person: if a student lent their login, the code still belongs to them. Read [what a forensic watermark is and how it traces a copy](/blog/forensic-watermark-explained) for the limits.

### Takedown requests

Platforms such as Telegram and YouTube have their own routes for reporting copyright material. A report can remove one copy. It does not remove copies elsewhere, and it does not stop the next upload, so it works best as one step in a plan, not the whole plan.

## Rules students accept

Protection works better when students understand it before they pay. A short, fair policy on your course page or in your first lesson does more than any hidden technical trick.

- Say plainly that each account is for one student.
- Say how many devices they can use and what to do if they get a new phone.
- Tell them each video shows their personal code, and why.
- Explain what happens if a copy is traced to their account, and keep that response proportionate.

Students and parents are far more likely to accept a rule they were told about than one they discover when a lesson refuses to open.

## When a copy appears anyway

Even with good measures, some copies will get out. Have a plan ready so you act calmly: save the evidence, read the viewer code in the copy if there is one, ask for a trace, decide what happens to the account, report the copy to the platform, and tell your other students what you need to. Our step-by-step [response plan for a course leaked on Telegram](/blog/course-leaked-on-telegram-response-plan) covers each of these, including what not to do.

## How this works in Atlas

Atlas deters sharing and helps trace leaks. It does not make copying impossible, and it says so to you and to your students.

- **Access checks.** Every time a lesson opens, Atlas checks that the student is signed in, belongs to your academy, is not blocked, and is enrolled with access that has not ended.
- **Device limits and one screen at a time.** You set how many devices each student can use. Lessons play on one device at a time; opening a lesson on a second device asks to move playback there.
- **A visible forensic watermark.** Every lesson video watched in your academy shows a label with the student's personal code that moves around the picture, plus a faint pattern of the same code across the whole video. It is always on and stays in full screen.
- **Player protections.** The player has no download button, turns off picture-in-picture and casting in browsers that respect the setting, and pauses playback if the watermark is hidden, with Atlas notified.
- **Sharing signals.** A report counts lessons refused because of the device limit or another active session, so you can spot accounts that may be shared. It never blocks anyone on its own.
- **Tracing on request.** If a recording leaks, you send the code you can read in it to Atlas support. Atlas looks it up and tells you which account and sign-in it was issued to. Your academy has no lookup screen of its own.

Two limits matter. Atlas has no DRM and cannot stop screen recording or filming. And lessons on Atlas are YouTube videos played inside your academy: a determined student can find a lesson's YouTube link and watch it on YouTube, where there is no watermark and no device limit. The full details are in the help center article [Content protection: what Atlas does and does not do](https://docs.atlass.dpdns.org/protection/overview).

## Common questions

**Can I stop students recording my screen?**
No. No website can fully stop screen recording or filming. What you can do is make a recording traceable and sharing inconvenient.

**Does a viewer code identify the person who leaked?**
It identifies the account and session the code was issued to, and only if the code is readable in the copy. If a student shared their login, the code still points to their account.

**Is an unlisted YouTube video safe for paid lessons?**
It keeps the video out of search, but anyone with the link can watch it. Combine it with the other measures and do not rely on it alone.

## Key takeaways

- Name the leak routes first: shared logins, copied links, recording, filming and re-uploads.
- Sort each measure into prevent, deter or trace, and expect most of your protection to deter and trace.
- Tell students the rules before they pay.
- Keep a response plan ready for the day a copy appears.

If you want to see the moving viewer code on your own lesson, [start an academy trial](/pricing), add one YouTube lesson and preview it.
$atlasblog$,
   $atlasblog$Illustration of a teacher's desk with a laptop playing a lesson video, a gold tag over the picture, a shield, a padlock and a stack of notebooks.$atlasblog$,
   $atlasblog$Protect paid courses from leaks: what works, what doesn't$atlasblog$,
   $atlasblog$Leaks come from shared logins, copied links and screen recordings. See which measures prevent, deter or trace each one, and what none can stop.$atlasblog$,
   8,
   $atlasblog$حماية الكورسات المدفوعة من التسريب: ما الذي ينفع وما الذي لا ينفع$atlasblog$,
   $atlasblog$الدروس تتسرّب من حساب متشارك أو لينك منسوخ أو تسجيل للشاشة أو كاميرا موبايل. اعرف أي إجراء يمنع أو يردع أو يكشف كل طريق، وما الذي لا يوقفه أي إجراء.$atlasblog$,
   $atlasblog$سجّلت دروس ترم كامل، ودفع الطلاب ثمنها، وبعد أسابيع قليلة يخبرك أحدهم أن الفيديوهات منشورة على قناة تليجرام. أغلب المدرسين الذين يبيعون دروسهم أونلاين مرّوا بهذا الموقف أو يخشونه. والإجابة الصريحة أنه لا يوجد إجراء يمنع كل تسريب. بعض الإجراءات يمنع نوعًا واحدًا من المشاركة، وبعضها يصعّبها فقط، وبعضها يساعدك على معرفة مصدر النسخة. وحين تعرف الفرق بينها توفّر فلوسك، وتوفّر على طلابك كثيرًا من المتاعب.

## كيف تتسرّب الدروس فعلًا؟

قبل أن تختار أي حماية، حدّد الطرق التي يخرج منها الدرس. الدروس المدفوعة تتسرّب غالبًا بواحدة من خمس طرق:

- **حساب متشارك.** طالب واحد يدفع، ثم يعطي كلمة السر لأصحابه أو لقريبه أو لجروب كامل.
- **لينك منسوخ.** إذا كان الفيديو على منصة عامة، فاللينك نفسه يمكن أن ينتقل من شخص لآخر.
- **تسجيل الشاشة.** برنامج على اللابتوب أو الموبايل يسجّل الدرس أثناء تشغيله.
- **موبايل يصوّر الشاشة.** جهاز ثانٍ موجّه إلى الشاشة لا يحتاج أي برنامج.
- **إعادة الرفع.** ما تم نسخه ينتهي على تليجرام أو يوتيوب أو جروب فيسبوك.

كل طريق يحتاج ردًّا مختلفًا. القاعدة التي تمنع مشاركة الحساب لا تفعل شيئًا أمام كاميرا موبايل، والأداة التي تمنع برنامج تسجيل واحدًا لا تفعل شيئًا أمام كلمة سر متشاركة.

## المنع والردع والكشف: ثلاث مهام مختلفة

من المفيد أن تضع كل إجراء تحت واحدة من ثلاث مهام:

1. **المنع.** الإجراء يجعل طريقًا معينًا مستحيلًا أو قريبًا من المستحيل. مثل التأكد من أن الطالب المسجّل في الكورس فقط هو من يفتح الدرس.
2. **الردع.** الإجراء يجعل المشاركة متعبة أو مكلفة، فيقل عدد من يحاول. حدود الأجهزة والكود الظاهر على الفيديو من أدوات الردع.
3. **الكشف.** حين تظهر نسخة رغم كل شيء، يساعدك الإجراء على معرفة الحساب الذي خرجت منه.

القليل جدًا على الويب يقع تحت المهمة الأولى. أغلب الحماية الحقيقية تقع تحت الردع والكشف. والخطة التي تعترف بذلك أسهل في شرحها للطلاب، وأقوى حين يحدث تسريب فعلًا.

## الإجراءات واحدًا واحدًا: جدول بصراحة

| الإجراء | ماذا يمنع | ماذا يفوته | ماذا يكلّفك |
|---|---|---|---|
| لينكات الفيديو غير المدرجة | وصول الناس للفيديو من البحث | أي شخص معه اللينك يشاهده | لا شيء تقريبًا |
| حساب لكل طالب | مشاركة كلمة السر العابرة، لو التزمت بها | شخصان يتبادلان نفس الجهاز | بعض أسئلة الدعم |
| حدود الأجهزة وشاشة واحدة في المرة | مشاهدة حساب واحد على أجهزة كثيرة في نفس الوقت | تسجيل الشاشة والتصوير | طالب يغيّر المتصفح يستهلك أماكن |
| إضافات منع التسجيل وDRM | بعض برامج التسجيل في بعض المتصفحات | كاميرا الموبايل وأدوات أخرى كثيرة | تكلفة وإعداد ومشاكل تشغيل عند بعض الطلاب |
| كود مشاهد ظاهر على الفيديو | يجعل التسجيل قابلًا للتتبّع والمشاركة مخاطرة | لا يمنع التسجيل نفسه | الطلاب يرون الكود أثناء المشاهدة |
| طلبات الحذف | نسخة محددة على موقع محدد | النسخ في أماكن أخرى والرفع الجديد | وقتك، بعد وقوع التسريب |

### اللينكات غير المدرجة

فيديو يوتيوب غير المدرج لا يظهر في البحث ولا على قناتك، لكن أي شخص معه اللينك يستطيع مشاهدته. لذلك هو مناسب لإبعاد الدروس عن العرض العام، وضعيف كقفل. اعتبره «غير معلن»، ولا تعتبره «خاصًا».

### حساب لكل طالب وحدود الأجهزة

حين يكون لكل طالب حسابه، ثم تحدد عدد الأجهزة التي يعمل عليها الحساب، ويشتغل الدرس على شاشة واحدة في المرة، تصبح مشاركة كلمة السر مزعجة لكل من يستخدمها. هذا لن يمنع أخوين من التناوب على لابتوب واحد، وقد يصل طالب إلى الحد دون ذنب إذا مسح بيانات المتصفح أو غيّره. ضع الحد بحيث لا يلاحظه الطالب العادي الذي يستخدم موبايل ولابتوب.

### إضافات منع التسجيل وDRM

لا توجد صفحة ويب تستطيع أن توقف تسجيل الشاشة أو تصويرها بالموبايل توقفًا كاملًا. برامج التسجيل تعمل على جهاز الطالب نفسه، خارج سيطرة الصفحة، والموبايل الثاني لا يحتاج أي برنامج. بعض الأدوات تمنع برامج تسجيل معينة في متصفحات معينة، ولهذا قد يبدو كلامها مقنعًا. إذا اشتريت واحدة فاشترها لما تفعله فعلًا، ولا تقل لطلابك إن دروسك «لا يمكن تسجيلها». مقالنا [هل يمكن منع تصوير الشاشة في الدروس الأونلاين؟](/ar/blog/can-you-stop-screen-recording) يشرح ذلك بالتفصيل.

### كود المشاهد الظاهر

الكود الظاهر فوق الفيديو، والمرتبط بالطالب الذي يشاهد، يفعل شيئين. الطالب يعرف أن أي تسجيل يصنعه يحمل كوده الشخصي، وهذا يقلل الرغبة في المشاركة. وإذا تسرّب تسجيل والكود ما زال مقروءًا، فالكود يوصلك إلى حساب. لاحظ أنه يوصلك إلى حساب وجلسة دخول، وليس إلى شخص بعينه: إذا أعار الطالب حسابه لغيره، يبقى الكود كوده. اقرأ [ما هي العلامة المائية للتتبّع وكيف تكشف مصدر النسخة](/ar/blog/forensic-watermark-explained) لتعرف حدودها.

### طلبات الحذف

منصات مثل تليجرام ويوتيوب لديها طرق خاصة للإبلاغ عن المحتوى المحمي بحقوق النشر. البلاغ قد يحذف نسخة واحدة، لكنه لا يحذف النسخ في أماكن أخرى ولا يمنع الرفع التالي. لذلك هو خطوة ضمن خطة، وليس الخطة كلها.

## قواعد يقبلها الطلاب

الحماية تنجح أكثر حين يفهمها الطالب قبل أن يدفع. سياسة قصيرة وعادلة في صفحة الكورس أو في أول درس تفيد أكثر من أي حيلة تقنية مخفية:

- قل بوضوح إن كل حساب لطالب واحد.
- قل كم جهازًا يستطيع أن يستخدم، وماذا يفعل إذا اشترى موبايل جديدًا.
- أخبره أن كل فيديو يظهر عليه كوده الشخصي، ولماذا.
- اشرح ما يحدث إذا وصل تتبّع نسخة إلى حسابه، واجعل ردّك متناسبًا.

الطالب وولي الأمر يقبلان القاعدة التي عرفاها مسبقًا أكثر بكثير من قاعدة يكتشفانها حين يرفض الدرس أن يفتح.

## حين تظهر نسخة رغم كل شيء

حتى مع إجراءات جيدة، ستخرج بعض النسخ. جهّز خطتك مسبقًا حتى تتصرف بهدوء: احفظ الدليل، واقرأ كود المشاهد في النسخة إن وجد، واطلب التتبّع، وقرر ماذا يحدث للحساب، وبلّغ المنصة عن النسخة، وأخبر باقي طلابك بما يلزم. خطتنا خطوة بخطوة [لو كورسك اتسرّب على تليجرام](/ar/blog/course-leaked-on-telegram-response-plan) تشرح كل خطوة، ومعها ما يجب أن تتجنبه.

## كيف يعمل هذا في أطلس

أطلس يردع المشاركة ويساعدك على كشف مصدر التسريب، لكنه لا يجعل النسخ مستحيلًا، ويقول ذلك بوضوح لك ولطلابك.

- **فحص الوصول.** في كل مرة يُفتح فيها درس، يتأكد أطلس أن الطالب مسجّل الدخول، وأنه من أكاديميتك وغير محظور، وأنه مشترك في الكورس واشتراكه لم ينتهِ.
- **حدود الأجهزة وشاشة واحدة في المرة.** أنت تحدد عدد الأجهزة لكل طالب. والدروس تعمل على جهاز واحد في المرة، فإذا فتح الطالب درسًا على جهاز ثانٍ يُسأل إن كان يريد نقل المشاهدة إليه.
- **علامة مائية تتبّعية ظاهرة.** كل فيديو درس يُشاهَد في أكاديميتك تظهر عليه علامة فيها كود الطالب الشخصي وتتحرك على الصورة، ومعها نقشة خفيفة بنفس الكود على الفيديو كله. العلامة تعمل دائمًا، وتبقى في وضع ملء الشاشة.
- **حمايات المشغّل.** المشغّل ليس فيه زر تحميل، ويوقف خاصية الصورة داخل الصورة والبث إلى شاشة أخرى في المتصفحات التي تلتزم بالإعداد، ويوقف التشغيل إذا أُخفيت العلامة، ويصل التنبيه إلى أطلس.
- **مؤشرات المشاركة.** تقرير يعدّ مرات رفض فتح الدروس بسبب حد الأجهزة أو وجود جلسة أخرى، لتلاحظ الحسابات التي قد تكون متشاركة. والتقرير لا يحظر أحدًا من تلقاء نفسه.
- **التتبّع عند الطلب.** إذا تسرّب تسجيل، ترسل الكود الذي تقرؤه فيه إلى دعم أطلس، فيبحث عنه أطلس ويخبرك بالحساب وجلسة الدخول اللذين صدر لهما. أكاديميتك نفسها ليس فيها شاشة للبحث عن الأكواد.

وهناك حدّان مهمان. أطلس ليس فيه DRM، ولا يستطيع منع تسجيل الشاشة أو تصويرها. والدروس على أطلس فيديوهات يوتيوب تُعرض داخل أكاديميتك: الطالب المصمّم يستطيع الوصول إلى لينك يوتيوب الخاص بالدرس ومشاهدته على يوتيوب، حيث لا توجد علامة مائية ولا حد للأجهزة. التفاصيل الكاملة في مقال مركز المساعدة [حماية المحتوى: ماذا يفعل أطلس وماذا لا يفعل](https://docs.atlass.dpdns.org/ar/protection/overview).

## أسئلة شائعة

**هل أستطيع منع الطلاب من تسجيل الشاشة؟**
لا. لا يوجد موقع يستطيع أن يوقف تسجيل الشاشة أو التصوير توقفًا كاملًا. ما تستطيعه هو أن تجعل التسجيل قابلًا للتتبّع والمشاركة متعبة.

**هل كود المشاهد يكشف الشخص الذي سرّب؟**
يكشف الحساب وجلسة الدخول اللذين صدر لهما الكود، وبشرط أن يكون الكود مقروءًا في النسخة. وإذا شارك الطالب حسابه، يبقى الكود مرتبطًا بحسابه هو.

**هل فيديو يوتيوب غير المدرج آمن للدروس المدفوعة؟**
هو يبعد الفيديو عن البحث، لكن أي شخص معه اللينك يستطيع مشاهدته. استخدمه مع باقي الإجراءات ولا تعتمد عليه وحده.

## الخلاصة

- حدّد طرق التسريب أولًا: الحساب المتشارك، واللينك المنسوخ، والتسجيل، والتصوير، وإعادة الرفع.
- ضع كل إجراء تحت المنع أو الردع أو الكشف، وتوقّع أن أغلب حمايتك ستكون ردعًا وكشفًا.
- أخبر طلابك بالقواعد قبل أن يدفعوا.
- جهّز خطة للتصرف في اليوم الذي تظهر فيه نسخة.

لو تحب أن ترى كود المشاهد يتحرك على درسك أنت، [ابدأ تجربة أكاديميتك](/ar/pricing)، وأضف درس يوتيوب واحدًا، ثم اعرضه بنفسك.
$atlasblog$,
   $atlasblog$رسم لمكتب مدرس عليه لابتوب يعرض فيديو درس فوقه علامة ذهبية، ودرع وقفل وكتب.$atlasblog$,
   $atlasblog$حماية الكورسات المدفوعة من التسريب: ما الذي ينفع فعلًا؟$atlasblog$,
   $atlasblog$التسريب يأتي من حساب متشارك أو لينك منسوخ أو تصوير الشاشة. اعرف أي حماية تمنع، وأيها تردع أو تكشف المصدر، وما الذي لا يوقفه شيء.$atlasblog$,
   7),
  ($atlasblog$49f7ec27-733e-58c9-8881-ca5fd039d9d0$atlasblog$,
   $atlasblog$collecting-course-payments-in-egypt$atlasblog$,
   $atlasblog$pillar$atlasblog$::"platform_blog_post_kind",
   $atlasblog$payments$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-07T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-07T08:00:00Z$atlasblog$::timestamp,
   true,
   $atlasblog$/marketing-assets/blog/collecting-course-payments-in-egypt.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$5071618b-4156-5c3d-ad06-11a8275e2ca2$atlasblog$,$atlasblog$3e427114-ca5b-590b-8fe3-b23f85784955$atlasblog$,$atlasblog$5cdb7352-565e-57a5-b406-7f6fa77e1944$atlasblog$]::TEXT[],
   $atlasblog$Collecting course payments in Egypt: wallets, InstaPay and bank transfer, organised$atlasblog$,
   $atlasblog$How teachers in Egypt collect by Vodafone Cash, InstaPay and bank transfer, where the WhatsApp screenshot routine breaks, and a simple system you can start today.$atlasblog$,
   $atlasblog$If you teach online in Egypt, you probably already collect money by Vodafone Cash, InstaPay or bank transfer, and you confirm each payment from a screenshot someone sends you on WhatsApp. That works for twenty students. At two hundred, payments get lost in chats, names do not match, and renewals slip. This guide looks at the three payment rails teachers use, where the screenshot routine breaks, and a simple system you can start today with or without any software.

## How most teachers collect today

The common pattern looks like this. A teacher posts a wallet number or an InstaPay address on their page or in a group. The student, or often a parent, sends the money and takes a screenshot of the transfer. The screenshot goes to the teacher on WhatsApp, the teacher checks it, and then adds the student to a group or sends them a link by hand.

Nothing about this is wrong. It uses tools everyone already has, and it costs nothing to start. The trouble is that every step lives in a different place: the money is in the wallet app, the proof is in a chat, the student list is in a notebook or a spreadsheet, and access is in a group. Keeping those four in step is where the work goes.

## The three rails side by side

### Mobile wallets

Wallets such as Vodafone Cash, Orange Cash, Etisalat Cash and WE Pay are what many students and parents already use. Sending money to a phone number is familiar to most families. The catch for you is that the transfer usually shows a phone number and maybe a name, which may belong to a parent, a sibling or a shop that sent the money on the student's behalf.

### InstaPay

InstaPay sends money from a bank account using an address like name@instapay. It suits students and parents who already bank. As with wallets, the sender's name you see may not be the student's.

### Bank transfer

A classic bank transfer to your account suits parents who prefer their bank. The reference field is often left empty, so ask for it.

Whichever rails you accept, check the current fees and limits on each provider's own pages, since they change, and tell students what to expect.

## Where the screenshot routine breaks

Teachers who collect at scale run into the same problems:

- **Name mismatches.** The money came from "Ahmed's father" or a phone you do not recognise, so you cannot tell which student paid.
- **Duplicate images.** The same screenshot is sent twice, by accident or on purpose, for two students or two months.
- **Edited images.** A screenshot is only a picture. It proves nothing until you see the money in your own account.
- **Partial payments.** A student sends half and promises the rest, and now you have to remember the balance.
- **Renewals.** Monthly students pay on different days, and you only notice a missed month when someone complains.
- **Lost proofs.** The screenshot is buried in a chat with hundreds of messages.

## A simple system: one reference per student, one record

You can fix most of this without software, using three habits.

1. **Give each student a reference.** A short code, their phone number or their name in a set format. Ask them to write it in the transfer note or reference field every time.
2. **Keep one record.** One sheet or list with a row per payment: date, student, reference, amount, rail, and whether you confirmed it in your own app.
3. **Confirm in your own app, never on the image alone.** A screenshot tells you where to look. Your wallet, bank or InstaPay app tells you whether the money arrived.

Then add one rule: access opens only after the payment is confirmed and recorded. That single rule ends most arguments about who paid what. Our guide [from WhatsApp screenshots to an approval queue](/blog/from-whatsapp-screenshots-to-approval-queue) turns this into a five-point check for every proof.

## Monthly renewals and access end dates

If you charge by the month or by the term, decide two things before the season starts:

- when access ends for each payment, written as a date, not "one month";
- what happens on that date: access stops, and the student pays again to continue.

Tell students the rule when they first pay. A visible end date is easier to accept than access that stops without warning.

## Cards and other gateways

Some teachers want card payments or a payment gateway, especially for students abroad. Gateways can confirm payments automatically, but they come with their own fees and setup requirements, so compare them carefully. If most of your students already pay by wallet or InstaPay, a manual routine done well may serve you better for now.

A note on tax: whether and how you register for tax is a separate question, and it is worth asking a qualified tax adviser about your own situation.

## What to tell students before they pay

Most payment problems start with unclear instructions. Before you share your payment details, write one short message or page that answers:

- which payment methods you accept, with the exact number, address or account;
- the exact amount for each course or month;
- what to write in the transfer reference;
- where to send or upload the proof;
- how long confirmation takes, in your own words;
- what happens if a payment does not match, and how to fix it.

Pin that message in your group or put it on your course page, and send the same text every time someone asks. Consistent instructions mean consistent payments, and far fewer screenshots you cannot match.

## How this works in Atlas

Atlas organises the manual routine above. It does not move money and does not take card payments.

- **Your own payment details.** The academy owner adds the methods students can pay with: bank transfer, an e-wallet (Vodafone Cash, Orange Cash, Etisalat Cash, WE Pay or another wallet you name) and InstaPay. Each academy can have one method of each type, and you write the transfer and reference instructions students see, in English and optionally in Arabic.
- **Students pay you directly.** At checkout the student picks one of your methods, sends the money from their own app, and uploads a screenshot or receipt, with the transfer reference and a note if they like. The money goes straight to your account; Atlas never holds it and takes no commission on these payments.
- **One list to review.** You get an email and a notification for each proof. In **Student payments**, every proof waits under **Waiting for review**, next to the details the student was shown.
- **You approve, then the student is enrolled.** You check your own app, then approve. The student is enrolled in the course straight away and emailed. If something is wrong, you reject with a reason, the student is emailed, and they can send a new payment.
- **Only the owner reviews.** Managers and instructors cannot see or approve payments.

The limits: Atlas does not connect to your bank or wallet, so it cannot tell you whether a transfer arrived; you confirm that yourself before approving. There is no card or Fawry checkout and no downloadable PDF receipt; the emails are the student's record. If you refund someone, you send the money back yourself and then record the refund in Atlas. See [How selling courses works in Atlas](https://docs.atlass.dpdns.org/selling/overview).

## Common questions

**Can students pay a different amount, like half now?**
Keep it simple: one payment per course price. If you agree something else with a student, record it yourself and decide when access opens.

**Should I accept all three rails?**
Accept the ones your students actually use. Each extra rail is one more app to check.

**How fast should I confirm payments?**
Set your own promise, for example within a day, and tell students. Nothing in a manual routine is instant, and saying so avoids anxious messages.

## Key takeaways

- Wallets, InstaPay and bank transfer all work; the hard part is matching money to students.
- Give each student a reference and keep one record.
- Confirm in your own app before you open access.
- Write access end dates down and tell students in advance.

To try the whole routine on your own academy, [start an academy trial](/pricing), turn on one payment method and make a test purchase yourself.
$atlasblog$,
   $atlasblog$Illustration of a phone, gold coins and a small bank building with arrows flowing into one tidy tray beside a ledger notebook.$atlasblog$,
   $atlasblog$Collecting course payments in Egypt: wallets and InstaPay$atlasblog$,
   $atlasblog$How teachers in Egypt collect by Vodafone Cash, InstaPay and bank transfer, where the screenshot routine breaks, and a simple way to track it.$atlasblog$,
   7,
   $atlasblog$تحصيل فلوس الكورسات في مصر: المحافظ وإنستاباي والتحويل البنكي بشكل منظّم$atlasblog$,
   $atlasblog$كيف يحصّل المدرسون في مصر بفودافون كاش وإنستاباي والتحويل البنكي، وأين تنكسر طريقة سكرينات الواتساب، ونظام بسيط تستطيع أن تبدأه اليوم.$atlasblog$,
   $atlasblog$إذا كنت تدرّس أونلاين في مصر، فغالبًا تحصّل فلوسك بفودافون كاش أو إنستاباي أو التحويل البنكي، وتتأكد من كل دفعة من سكرين شوت يرسله لك أحدهم على واتساب. هذه الطريقة تنفع مع عشرين طالبًا. لكن مع مئتي طالب تضيع المدفوعات وسط الشات، ولا تتطابق الأسماء، وتفلت التجديدات. هذا الدليل يستعرض طرق الدفع الثلاث التي يستخدمها المدرسون، وأين تنكسر طريقة السكرينات، ونظامًا بسيطًا تستطيع أن تبدأه اليوم، بأي برنامج أو بدونه.

## كيف يحصّل أغلب المدرسين اليوم؟

الطريقة المعتادة كالتالي: المدرس ينشر رقم محفظة أو عنوان إنستاباي على صفحته أو في جروب. الطالب، أو ولي أمره في أحيان كثيرة، يحوّل المبلغ ويأخذ سكرين شوت للتحويل. السكرين يصل للمدرس على واتساب، فيراجعه، ثم يضيف الطالب إلى جروب أو يرسل له لينكًا بنفسه.

لا عيب في هذه الطريقة. هي تعتمد على أدوات يملكها الجميع، ولا تكلّف شيئًا لتبدأ. المشكلة أن كل خطوة فيها موجودة في مكان مختلف: الفلوس في تطبيق المحفظة، والإثبات في شات، وقائمة الطلاب في كشكول أو شيت، والوصول للدروس في جروب. والمجهود كله يذهب في إبقاء هذه الأربعة متطابقة.

## طرق الدفع الثلاث جنبًا إلى جنب

### المحافظ الإلكترونية

محافظ مثل فودافون كاش وأورنج كاش واتصالات كاش وWE Pay هي ما يستخدمه كثير من الطلاب وأولياء الأمور بالفعل. وإرسال الفلوس إلى رقم موبايل أمر مألوف لأغلب الأسر. المشكلة بالنسبة لك أن التحويل يُظهر غالبًا رقم موبايل وربما اسمًا، وقد يكون صاحبه ولي الأمر أو أخًا أو محلًّا حوّل المبلغ نيابة عن الطالب.

### إنستاباي

إنستاباي يرسل الفلوس من حساب بنكي باستخدام عنوان مثل name@instapay. يناسب الطلاب وأولياء الأمور الذين يتعاملون مع البنوك. وكما في المحافظ، قد لا يكون اسم المرسل الذي تراه هو اسم الطالب.

### التحويل البنكي

التحويل البنكي التقليدي إلى حسابك يناسب أولياء الأمور الذين يفضّلون بنكهم. وكثيرًا ما تُترك خانة المرجع فارغة، فاطلبها صراحة.

وأيًّا كانت الطرق التي تقبلها، راجع الرسوم والحدود الحالية في صفحات كل مقدّم خدمة، لأنها تتغير، وأخبر طلابك بما يتوقعونه.

## أين تنكسر طريقة السكرينات؟

المدرسون الذين يحصّلون من أعداد كبيرة يواجهون نفس المشاكل:

- **أسماء لا تتطابق.** الفلوس جاءت من «والد أحمد» أو من رقم لا تعرفه، فلا تعرف أي طالب دفع.
- **صور مكررة.** نفس السكرين يُرسل مرتين، عن غير قصد أو عن قصد، لطالبين أو لشهرين.
- **صور معدّلة.** السكرين مجرد صورة، ولا يثبت شيئًا حتى ترى الفلوس في حسابك أنت.
- **دفع جزئي.** طالب يرسل نصف المبلغ ويعد بالباقي، فتضطر لتذكّر الفرق.
- **التجديدات.** طلاب الاشتراك الشهري يدفعون في أيام مختلفة، ولا تلاحظ الشهر الفائت إلا حين يشتكي أحدهم.
- **إثباتات ضائعة.** السكرين مدفون في شات فيه مئات الرسائل.

## نظام بسيط: مرجع لكل طالب، وسجل واحد

تستطيع أن تحل أغلب هذه المشاكل بدون برامج، بثلاث عادات:

1. **أعطِ كل طالب مرجعًا.** كود قصير، أو رقم موبايله، أو اسمه بصيغة ثابتة. واطلب منه أن يكتبه في ملاحظة التحويل أو خانة المرجع في كل مرة.
2. **احتفظ بسجل واحد.** شيت أو قائمة واحدة فيها سطر لكل دفعة: التاريخ، والطالب، والمرجع، والمبلغ، وطريقة الدفع، وهل تأكدت منها في تطبيقك.
3. **تأكد من تطبيقك أنت، وليس من الصورة وحدها.** السكرين يقول لك أين تبحث، أما تطبيق المحفظة أو البنك أو إنستاباي فيقول لك هل وصلت الفلوس فعلًا.

ثم أضف قاعدة واحدة: الوصول للدروس يُفتح فقط بعد تأكيد الدفعة وتسجيلها. هذه القاعدة وحدها تنهي أغلب الخلافات حول من دفع وكم. ودليلنا [من سكرينات الواتساب إلى قائمة موافقات](/ar/blog/from-whatsapp-screenshots-to-approval-queue) يحوّل ذلك إلى خمس نقاط تراجعها في كل إثبات.

## التجديد الشهري ومواعيد انتهاء الوصول

إذا كنت تحاسب بالشهر أو بالترم، فقرر أمرين قبل بداية الموسم:

- متى ينتهي الوصول مقابل كل دفعة، مكتوبًا كتاريخ، وليس «شهرًا» فقط؛
- ماذا يحدث في هذا التاريخ: يتوقف الوصول، ويدفع الطالب من جديد ليكمل.

أخبر الطلاب بالقاعدة من أول دفعة. موعد انتهاء واضح أسهل في القبول من وصول يتوقف فجأة.

## الكروت وبوابات الدفع الأخرى

بعض المدرسين يريدون الدفع بالكارت أو ببوابة دفع، خاصة للطلاب خارج مصر. البوابات قد تؤكد الدفع تلقائيًا، لكن لها رسومها وشروط إعدادها، فقارن بينها بعناية. وإذا كان أغلب طلابك يدفعون بالمحفظة أو إنستاباي بالفعل، فقد يخدمك نظام يدوي منظّم أكثر في الوقت الحالي.

وملاحظة عن الضرائب: التسجيل الضريبي وطريقته مسألة منفصلة، ومن المفيد أن تسأل مستشارًا ضريبيًا مؤهلًا عن حالتك أنت.

## ماذا تقول للطلاب قبل أن يدفعوا؟

أغلب مشاكل التحصيل تبدأ بتعليمات غير واضحة. قبل أن تنشر بيانات الدفع، اكتب رسالة قصيرة أو صفحة واحدة تجيب عن هذه الأسئلة:

- ما طرق الدفع التي تقبلها، مع الرقم أو العنوان أو الحساب بالضبط؛
- المبلغ المطلوب بالضبط لكل كورس أو لكل شهر؛
- ماذا يكتب الطالب في مرجع التحويل؛
- أين يرسل الإثبات أو يرفعه؛
- كم يستغرق التأكيد، بكلماتك أنت؛
- ماذا يحدث إذا لم تتطابق الدفعة، وكيف يصلح الطالب ذلك.

ثبّت هذه الرسالة في الجروب أو ضعها في صفحة الكورس، وأرسل نفس النص في كل مرة يسألك فيها أحد. التعليمات الثابتة تعني مدفوعات منتظمة، وسكرينات أقل بكثير لا تعرف لمن هي. ومن المفيد أن تكتب الرسالة بلغة بسيطة يفهمها ولي الأمر أيضًا، لأنه كثيرًا ما يكون هو من يحوّل المبلغ فعلًا، وقد لا يتابع الجروب مثل الطالب.

## كيف يعمل هذا في أطلس

أطلس ينظّم الطريقة اليدوية السابقة. لا يحرّك الفلوس، ولا يقبل الدفع بالكارت.

- **بيانات الدفع الخاصة بك.** صاحب الحساب يضيف الطرق التي يدفع بها الطلاب: التحويل البنكي، والمحفظة الإلكترونية (فودافون كاش أو أورنج كاش أو اتصالات كاش أو WE Pay أو محفظة أخرى تسمّيها)، وإنستاباي. لكل أكاديمية طريقة واحدة من كل نوع، وأنت تكتب تعليمات التحويل والمرجع التي يراها الطلاب، بالإنجليزية واختياريًا بالعربية.
- **الطلاب يدفعون لك مباشرة.** عند الشراء يختار الطالب واحدة من طرقك، ويرسل المبلغ من تطبيقه، ثم يرفع سكرين شوت أو إيصالًا، ومعه مرجع التحويل وملاحظة إن أراد. الفلوس تذهب مباشرة إلى حسابك؛ أطلس لا يمسكها، ولا يأخذ عمولة على هذه المدفوعات.
- **قائمة واحدة للمراجعة.** يصلك بريد وإشعار مع كل إثبات. وفي **مدفوعات الطلاب** تنتظرك كل الإثباتات تحت **بانتظار المراجعة**، بجوار البيانات التي ظهرت للطالب.
- **أنت توافق، فيُسجَّل الطالب.** تراجع تطبيقك أولًا، ثم توافق. يُسجَّل الطالب في الكورس مباشرة ويصله بريد. وإذا وجدت مشكلة، ترفض مع ذكر السبب، فيصل الطالب بريد ويستطيع إرسال دفعة جديدة.
- **صاحب الحساب وحده يراجع.** المديرون والمدرّسون لا يرون المدفوعات ولا يوافقون عليها.

والحدود: أطلس لا يتصل ببنكك أو محفظتك، فلا يستطيع أن يخبرك هل وصل التحويل؛ أنت تتأكد من ذلك بنفسك قبل الموافقة. ولا يوجد دفع بالكارت أو عن طريق فوري، ولا إيصال PDF للتحميل؛ رسائل البريد هي سجل الطالب. وإذا رددت لطالب فلوسه، ترسلها بنفسك ثم تسجّل الاسترداد في أطلس. راجع [كيف يعمل بيع الكورسات في أطلس](https://docs.atlass.dpdns.org/ar/selling/overview).

## أسئلة شائعة

**هل يمكن أن يدفع الطالب مبلغًا مختلفًا، كنصف المبلغ الآن؟**
الأبسط: دفعة واحدة بسعر الكورس. وإذا اتفقت مع طالب على غير ذلك، فسجّله بنفسك وقرر متى يُفتح الوصول.

**هل أقبل الطرق الثلاث كلها؟**
اقبل الطرق التي يستخدمها طلابك فعلًا. كل طريقة إضافية تعني تطبيقًا إضافيًا تراجعه.

**ما السرعة المناسبة لتأكيد المدفوعات؟**
حدد وعدك أنت، مثلًا خلال يوم، وأخبر به طلابك. لا شيء في النظام اليدوي فوري، وقول ذلك بوضوح يوفّر عليك رسائل القلق.

## الخلاصة

- المحافظ وإنستاباي والتحويل البنكي كلها تعمل؛ الصعب هو مطابقة الفلوس بالطلاب.
- أعطِ كل طالب مرجعًا، واحتفظ بسجل واحد.
- تأكد من تطبيقك قبل أن تفتح الوصول.
- اكتب مواعيد انتهاء الوصول، وأخبر الطلاب بها مسبقًا.

لتجرّب الطريقة كلها على أكاديميتك، [ابدأ تجربة أكاديميتك](/ar/pricing)، وفعّل طريقة دفع واحدة، واعمل عملية شراء تجريبية بنفسك.
$atlasblog$,
   $atlasblog$رسم لموبايل وعملات ذهبية ومبنى بنك صغير، وأسهم تتجه إلى صندوق مرتب بجوار دفتر حسابات.$atlasblog$,
   $atlasblog$تحصيل فلوس الكورسات في مصر: المحافظ وإنستاباي والتحويل$atlasblog$,
   $atlasblog$كيف يحصّل المدرسون في مصر بفودافون كاش وإنستاباي والتحويل البنكي، وأين تُربك سكرينات الواتساب الحسابات، وطريقة بسيطة لتنظيم التحصيل.$atlasblog$,
   6),
  ($atlasblog$a574cf55-55ed-5d59-af53-4c9d76a3dff5$atlasblog$,
   $atlasblog$fair-online-exams-for-secondary-students$atlasblog$,
   $atlasblog$pillar$atlasblog$::"platform_blog_post_kind",
   $atlasblog$exams$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-09T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-09T08:00:00Z$atlasblog$::timestamp,
   true,
   $atlasblog$/marketing-assets/blog/fair-online-exams-for-secondary-students.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$1a56576a-9789-5f6a-890f-311a812471cf$atlasblog$,$atlasblog$3e427114-ca5b-590b-8fe3-b23f85784955$atlasblog$,$atlasblog$5ae035f1-0fe2-50cb-ac85-689682b880a2$atlasblog$]::TEXT[],
   $atlasblog$How to run fair online exams for secondary students$atlasblog$,
   $atlasblog$Fair online exams come from design choices: the question mix, time windows, attempts, when results appear, exceptions for one student and a clear way to handle suspicion.$atlasblog$,
   $atlasblog$An online exam is fair when every student gets the same chance, knows the rules in advance, and can understand how their result was decided. None of that depends on a webcam. It depends on a handful of design choices you make before the exam opens: the questions, the time window, the number of attempts, when results appear, how you handle exceptions, and what you do when something looks wrong. This guide takes them in order, for teachers of secondary students and the parents who watch closely.

## What "fair" means for an online exam

Three tests are worth applying to any exam you set:

- **Same chance.** Students with ordinary phones and ordinary connections can finish it. The exam does not quietly reward whoever has the best laptop.
- **Clear rules.** Students know the time limit, the number of attempts, when they will see their score and what is recorded, before they start.
- **Explainable decisions.** If you change a mark, refuse an attempt or question a result, you can say why, with evidence.

If an exam passes these three, most complaints never start.

## Start with the questions

Question design does more for fairness than any monitoring tool.

- **Mix question types.** Choice questions are quick to mark and good for coverage. Short answers test recall. An essay question or two shows reasoning that is hard to copy from a friend.
- **Write questions that test understanding.** "Which of these graphs shows…" holds up better than "What is the definition of…", which can be looked up in seconds.
- **Use a bank, not a single list.** If each student draws a set of questions from a larger pool, in a shuffled order, sharing answers during the exam gets much harder.
- **Add explanations.** For practice quizzes especially, a short explanation after each question turns a mark into learning.

## Time windows and attempts

Decide how long the exam is, when it opens and closes, and how many attempts each student gets.

- **A window, not a single minute.** Opening the exam for an hour or an evening helps students with patchy internet or shared devices. A timer per attempt keeps the exam itself fair.
- **Attempts with a purpose.** One attempt for a graded exam, several for practice. If you allow more than one graded attempt, decide in advance which counts: the highest, the latest, the first or the average.
- **Late work.** Say whether late attempts are refused or accepted and marked as late, and stick to it.

## Phones are the default device

Most secondary students will take your exam on a phone. Plan for that:

- Show one question per page on small screens.
- Keep images light and text readable without zooming.
- Remember that some phone browsers cannot use full screen at all, including every browser on iPhone. A rule that depends on full screen needs a fallback for them.
- Tell students to charge their phone, close other apps and find a quiet place before they press start.

## Practice first, graded later

Students are calmer in a graded online exam when they have already taken a practice one in the same format. Run a short practice quiz with no time pressure and answers shown right away. Then run the graded exam with the settings that matter: a time limit, one attempt, answers hidden until everyone is done. The practice round also shows you which questions confuse people before a mark depends on them.

## When you suspect cheating: signals and a conversation

Sometimes an attempt will look odd: a perfect score from a student who usually struggles, answers submitted very fast, or a record of the student leaving the exam page several times. Treat these as reasons to look closer, not as verdicts.

- Look at the attempt itself: the answers, the time taken, what happened when.
- Remember the innocent explanations: a phone call, a notification, a dropped connection.
- Talk to the student, and to a parent if the student is a minor, before you decide anything.
- If you act, act on evidence you can explain.

Our guide to [exam integrity without cameras](/blog/exam-integrity-without-cameras) goes through each kind of browser signal and what it can and cannot tell you.

## Exceptions for one student

Fair does not always mean identical. A student with a medical need may need extra time. A student whose connection failed mid-exam may deserve another attempt. Decide how you handle these before exam day, write the reason down, and apply the same rule to every student in the same situation. That way an exception for one student never looks like a favour.

## Tell students the rules in writing

Students and parents accept rules they read before the exam far more easily than rules they discover during it. A day or two before any graded exam, send a short note that covers:

- when the exam opens and closes, and how long each attempt lasts;
- how many attempts they get, and which one counts;
- when they will see their score and the correct answers;
- what is recorded during the exam, if anything;
- what to do if their connection drops or their phone dies;
- who to contact, and how quickly you will reply.

Keep the same note for every exam, changing only the details. Over a term, students learn the routine, and fewer of them panic on exam day.

## How this works in Atlas

Owners, managers and the course's assigned instructors can build and run quizzes in Atlas.

- **Five question types.** Single choice, multiple choice, true or false, short answer and essay. All but essays are graded automatically; essays wait for a reviewer to grade them by hand.
- **Practice and Exam presets.** Practice has no time limit and shows results and answers immediately. Exam sets a time limit, one question per page, shuffled questions, answers hidden, and integrity monitoring with full screen required. You can change any setting.
- **Time and windows.** Set a time limit per attempt, when the quiz opens and closes, a due date and a late policy. The server keeps the time, so the timer keeps running if the student closes the page, and saved answers are submitted when time runs out.
- **Question banks and attempts.** Draw a set number of questions per attempt, shuffle questions and options, set the maximum attempts and choose which attempt counts.
- **Results on your terms.** Choose when students see their score and the correct answers: immediately, after the due date, after the last attempt, or never. Correct answers are never sent before that moment.
- **Exceptions.** Give one student extra time, extra attempts or their own window, with a recorded reason. You can also void an attempt that should not count, which gives the attempt back.
- **Integrity signals for your review.** If you turn integrity on, Atlas records events such as switching tabs, leaving full screen, copying, pasting and printing, and shows them to reviewers with possible innocent explanations. They are signals, never proof, and you decide what they mean.
- **What is never collected.** Atlas never uses the camera or microphone, never records the screen or what students type, and sees nothing outside the quiz page.

See [Run online quizzes and exams](https://docs.atlass.dpdns.org/tasks/run-exams) for the full workflow.

## Common questions

**Do I need a webcam to run a fair exam?**
No. Good question design, a sensible time window and clear rules do more for fairness, and they respect students' privacy.

**Can I give one student more time without changing the exam for everyone?**
Yes, if your platform supports per-student exceptions. Record why, and apply the same rule to similar cases.

**What should I do if two students have identical answers?**
Look at both attempts in full, consider innocent explanations, then talk to each student separately before you decide.

## Your pre-exam checklist

1. Mix question types and draw from a bank.
2. Set a window, a timer and the number of attempts.
3. Decide when scores and answers appear.
4. Test the exam on a phone.
5. Run a practice round first.
6. Write down how you will handle exceptions and suspicions.

To build your first practice quiz and graded exam on your own academy, [start an academy trial](/pricing).
$atlasblog$,
   $atlasblog$Illustration of a gold balance scale beside a tablet showing a multiple-choice quiz, an hourglass and a stack of exam papers.$atlasblog$,
   $atlasblog$How to run fair online exams for secondary students$atlasblog$,
   $atlasblog$Fair online exams come from design choices: question mix, time windows, attempts, result rules and a clear way to handle suspicion.$atlasblog$,
   7,
   $atlasblog$كيف تعمل امتحانات أونلاين عادلة لطلاب الثانوي$atlasblog$,
   $atlasblog$الامتحان الأونلاين العادل يأتي من قرارات التصميم: نوع الأسئلة، ووقت الامتحان، وعدد المحاولات، وموعد ظهور النتيجة، والاستثناءات، وطريقة واضحة للتعامل مع الشك.$atlasblog$,
   $atlasblog$الامتحان الأونلاين يكون عادلًا حين يحصل كل طالب على نفس الفرصة، ويعرف القواعد مسبقًا، ويستطيع أن يفهم كيف تقررت نتيجته. ولا شيء من ذلك يعتمد على كاميرا الويب. هو يعتمد على مجموعة قرارات تأخذها قبل أن يُفتح الامتحان: الأسئلة، ووقت الامتحان، وعدد المحاولات، وموعد ظهور النتيجة، وطريقة التعامل مع الاستثناءات، وما تفعله حين يبدو شيء غير طبيعي. هذا الدليل يمرّ عليها بالترتيب، لمدرسي المرحلة الثانوية ولأولياء الأمور الذين يتابعون عن قرب.

## ماذا يعني «عادل» في الامتحان الأونلاين؟

ثلاثة اختبارات تستحق أن تطبّقها على أي امتحان تضعه:

- **نفس الفرصة.** الطالب الذي معه موبايل عادي وإنترنت عادي يستطيع أن ينهي الامتحان. الامتحان لا يكافئ ضمنيًا من يملك أفضل لابتوب.
- **قواعد واضحة.** الطالب يعرف الوقت المحدد، وعدد المحاولات، ومتى سيرى درجته، وما الذي يُسجَّل، قبل أن يبدأ.
- **قرارات يمكن شرحها.** إذا غيّرت درجة، أو رفضت محاولة، أو شككت في نتيجة، تستطيع أن تقول لماذا، ومعك ما يدعم كلامك.

إذا نجح الامتحان في هذه الثلاثة، فأغلب الشكاوى لن تبدأ أصلًا.

## ابدأ بالأسئلة

تصميم الأسئلة يخدم العدالة أكثر من أي أداة مراقبة.

- **نوّع أنواع الأسئلة.** أسئلة الاختيار سريعة التصحيح وتغطي المنهج جيدًا. والإجابات القصيرة تختبر التذكر. وسؤال مقالي أو اثنان يُظهران طريقة التفكير، وهذه يصعب نقلها من صديق.
- **اكتب أسئلة تختبر الفهم.** سؤال مثل «أي هذه الرسوم البيانية يوضح…» يصمد أكثر من «ما تعريف…»، الذي يمكن البحث عنه في ثوانٍ.
- **استخدم بنك أسئلة، لا قائمة واحدة.** إذا سحب كل طالب مجموعة أسئلة من بنك أكبر، بترتيب عشوائي، يصبح تبادل الإجابات أثناء الامتحان أصعب كثيرًا.
- **أضف شرحًا للإجابة.** في امتحانات التدريب خصوصًا، الشرح القصير بعد كل سؤال يحوّل الدرجة إلى تعلّم.

## وقت الامتحان وعدد المحاولات

قرر مدة الامتحان، ومتى يُفتح ومتى يُغلق، وكم محاولة لكل طالب.

- **نافذة زمنية، لا دقيقة واحدة.** فتح الامتحان لمدة ساعة أو طوال سهرة يساعد الطلاب الذين عندهم إنترنت متقطع أو جهاز مشترك في البيت. والمؤقت لكل محاولة يحافظ على عدالة الامتحان نفسه.
- **محاولات لها هدف.** محاولة واحدة للامتحان المحسوب في الدرجات، وعدة محاولات للتدريب. وإذا سمحت بأكثر من محاولة محسوبة، فقرر مسبقًا أيّها تُحتسب: الأعلى، أو الأخيرة، أو الأولى، أو المتوسط.
- **التأخير.** قل بوضوح هل المحاولة المتأخرة مرفوضة أم مقبولة مع علامة تأخير، والتزم بذلك.

## الموبايل هو الجهاز الأساسي

أغلب طلاب الثانوي سيحلّون امتحانك على الموبايل. خطّط لذلك:

- اعرض سؤالًا واحدًا في كل صفحة على الشاشات الصغيرة.
- اجعل الصور خفيفة والنص مقروءًا بدون تكبير.
- تذكّر أن بعض متصفحات الموبايل لا تدعم ملء الشاشة أصلًا، ومنها كل المتصفحات على الآيفون. أي قاعدة تعتمد على ملء الشاشة تحتاج بديلًا لهؤلاء.
- اطلب من الطلاب شحن الموبايل، وإغلاق التطبيقات الأخرى، والجلوس في مكان هادئ قبل أن يضغطوا بدء الامتحان.

## التدريب أولًا، ثم الامتحان المحسوب

الطالب يكون أهدأ في الامتحان الأونلاين المحسوب إذا جرّب قبله امتحان تدريب بنفس الشكل. اعمل اختبار تدريب قصيرًا بلا ضغط وقت، تظهر فيه الإجابات فورًا. ثم اعمل الامتحان المحسوب بالإعدادات المهمة: وقت محدد، ومحاولة واحدة، وإجابات مخفية حتى ينتهي الجميع. وجولة التدريب تكشف لك أيضًا الأسئلة التي تربك الطلاب قبل أن تتوقف عليها درجة.

## حين تشك في غش: ملاحظات ثم حوار

أحيانًا ستبدو محاولة غريبة: درجة كاملة من طالب يتعثر عادة، أو إجابات أُرسلت بسرعة كبيرة، أو سجل يوضح أن الطالب خرج من صفحة الامتحان عدة مرات. اعتبر هذه أسبابًا للنظر عن قرب، وليست أحكامًا.

- انظر إلى المحاولة نفسها: الإجابات، والوقت المستغرق، وما حدث ومتى.
- تذكّر التفسيرات البريئة: مكالمة تليفون، أو إشعار، أو انقطاع الإنترنت.
- تكلّم مع الطالب، ومع ولي أمره إذا كان قاصرًا، قبل أن تقرر أي شيء.
- وإذا اتخذت إجراءً، فليكن بناءً على دليل تستطيع شرحه.

دليلنا عن [نزاهة الامتحان بدون كاميرا](/ar/blog/exam-integrity-without-cameras) يمرّ على كل نوع من ملاحظات المتصفح، وما يمكن أن تخبرك به وما لا يمكن.

## استثناءات لطالب واحد

العدالة لا تعني دائمًا التطابق. طالب لديه ظرف صحي قد يحتاج وقتًا إضافيًا. وطالب انقطع عنه الإنترنت في منتصف الامتحان قد يستحق محاولة أخرى. قرر كيف ستتعامل مع هذه الحالات قبل يوم الامتحان، واكتب السبب، وطبّق نفس القاعدة على كل طالب في نفس الموقف. بهذا لا يبدو الاستثناء لطالب واحد مجاملة.

## اكتب القواعد للطلاب قبل الامتحان

الطلاب وأولياء الأمور يتقبلون القواعد التي قرأوها قبل الامتحان أكثر بكثير من قواعد يكتشفونها أثناءه. قبل أي امتحان محسوب بيوم أو يومين، أرسل رسالة قصيرة توضح:

- متى يُفتح الامتحان ومتى يُغلق، وكم مدة كل محاولة؛
- كم محاولة مسموحة، وأي محاولة تُحتسب؛
- متى سيرون درجاتهم والإجابات الصحيحة؛
- ما الذي يُسجَّل أثناء الامتحان، إن وُجد؛
- ماذا يفعلون إذا انقطع الإنترنت أو فرغت بطارية الموبايل؛
- بمن يتواصلون، وبأي سرعة سترد عليهم.

استخدم نفس الرسالة في كل امتحان، وغيّر التفاصيل فقط. وعلى مدار الترم يتعلم الطلاب النظام، ويقل عدد من يتوتر منهم يوم الامتحان. ومن المفيد أن ترسل نسخة من الرسالة لأولياء الأمور أيضًا، حتى يعرفوا موعد الامتحان ويساعدوا أبناءهم على تجهيز مكان هادئ وموبايل مشحون.

## كيف يعمل هذا في أطلس

صاحب الحساب والمديرون والمدرّسون المسند إليهم الكورس يستطيعون إنشاء الاختبارات وإدارتها في أطلس.

- **خمسة أنواع أسئلة.** اختيار من متعدد بإجابة واحدة، واختيار من متعدد بأكثر من إجابة، وصح أو خطأ، وإجابة قصيرة، ومقالي. كلها تُصحَّح تلقائيًا ما عدا المقالي، الذي ينتظر مراجعًا يصححه بنفسه.
- **إعدادان جاهزان: تدريب وامتحان.** التدريب بلا وقت محدد، ويُظهر النتيجة والإجابات فورًا. والامتحان يضبط وقتًا محددًا، وسؤالًا في كل صفحة، وأسئلة بترتيب عشوائي، وإجابات مخفية، ومراقبة النزاهة مع اشتراط ملء الشاشة. وتستطيع تغيير أي إعداد.
- **الوقت والمواعيد.** حدد وقتًا لكل محاولة، وموعد فتح الاختبار وإغلاقه، وموعد تسليم، وسياسة للتأخير. الخادم هو الذي يحسب الوقت، فالمؤقت يستمر حتى لو أغلق الطالب الصفحة، والإجابات المحفوظة تُسلَّم حين ينتهي الوقت.
- **بنك الأسئلة والمحاولات.** اسحب عددًا محددًا من الأسئلة في كل محاولة، ورتّب الأسئلة والاختيارات عشوائيًا، وحدد أقصى عدد للمحاولات وأي محاولة تُحتسب.
- **النتائج بشروطك.** اختر متى يرى الطالب درجته والإجابات الصحيحة: فورًا، أو بعد موعد التسليم، أو بعد آخر محاولة، أو أبدًا. والإجابات الصحيحة لا تُرسل قبل هذا الموعد.
- **الاستثناءات.** أعطِ طالبًا واحدًا وقتًا إضافيًا، أو محاولات إضافية، أو مواعيد خاصة به، مع تسجيل السبب. وتستطيع أيضًا إلغاء محاولة لا يجب أن تُحتسب، فتعود المحاولة للطالب.
- **ملاحظات النزاهة للمراجعة.** إذا شغّلت النزاهة، يسجّل أطلس أحداثًا مثل التبديل إلى تبويب آخر، والخروج من ملء الشاشة، والنسخ واللصق والطباعة، ويعرضها للمراجعين مع تفسيرات بريئة محتملة. هي ملاحظات وليست دليلًا، وأنت من يقرر معناها.
- **ما لا يُجمع أبدًا.** أطلس لا يستخدم الكاميرا أو الميكروفون، ولا يسجّل الشاشة أو ما يكتبه الطالب، ولا يرى أي شيء خارج صفحة الاختبار.

راجع [إدارة الاختبارات والامتحانات أونلاين](https://docs.atlass.dpdns.org/ar/tasks/run-exams) لخطوات العمل كاملة.

## أسئلة شائعة

**هل أحتاج كاميرا ويب لامتحان عادل؟**
لا. تصميم الأسئلة الجيد، والنافذة الزمنية المعقولة، والقواعد الواضحة تخدم العدالة أكثر، وتحترم خصوصية الطلاب.

**هل أستطيع إعطاء طالب واحد وقتًا إضافيًا دون تغيير الامتحان للجميع؟**
نعم، إذا كانت منصتك تدعم الاستثناءات لكل طالب. سجّل السبب، وطبّق نفس القاعدة على الحالات المشابهة.

**ماذا أفعل إذا تطابقت إجابات طالبين؟**
راجع المحاولتين بالكامل، وفكّر في التفسيرات البريئة، ثم تكلّم مع كل طالب على حدة قبل أن تقرر.

## قائمة ما قبل الامتحان

1. نوّع أنواع الأسئلة واسحبها من بنك.
2. حدد النافذة الزمنية والمؤقت وعدد المحاولات.
3. قرر متى تظهر الدرجات والإجابات.
4. جرّب الامتحان على موبايل.
5. اعمل جولة تدريب أولًا.
6. اكتب كيف ستتعامل مع الاستثناءات وحالات الشك.

لتعمل أول اختبار تدريب وأول امتحان محسوب على أكاديميتك، [ابدأ تجربة أكاديميتك](/ar/pricing).
$atlasblog$,
   $atlasblog$رسم لميزان ذهبي بجوار تابلت يعرض اختبار اختيار من متعدد، وساعة رملية، وكومة أوراق امتحان.$atlasblog$,
   $atlasblog$كيف تعمل امتحانات أونلاين عادلة لطلاب الثانوي$atlasblog$,
   $atlasblog$الامتحان الأونلاين العادل يأتي من قرارات التصميم: نوع الأسئلة، ووقت الامتحان، وعدد المحاولات، وظهور النتيجة، وطريقة واضحة لو شككت في غش.$atlasblog$,
   6),
  ($atlasblog$5cdb7352-565e-57a5-b406-7f6fa77e1944$atlasblog$,
   $atlasblog$build-a-website-for-your-teaching-academy$atlasblog$,
   $atlasblog$pillar$atlasblog$::"platform_blog_post_kind",
   $atlasblog$website$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-11T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-11T08:00:00Z$atlasblog$::timestamp,
   true,
   $atlasblog$/marketing-assets/blog/build-a-website-for-your-teaching-academy.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$49f7ec27-733e-58c9-8881-ca5fd039d9d0$atlasblog$,$atlasblog$75b60022-36b1-5589-b77d-090bb07fbb39$atlasblog$,$atlasblog$3e427114-ca5b-590b-8fe3-b23f85784955$atlasblog$]::TEXT[],
   $atlasblog$How to build a website for your teaching academy (Arabic and English)$atlasblog$,
   $atlasblog$Social page, custom build or academy platform? Compare the three routes, list what your site must do, and estimate the real cost over a year with your own numbers.$atlasblog$,
   $atlasblog$Many teachers run their whole teaching business from a Facebook page and a few WhatsApp groups. At some point that stops being enough: students ask where to sign up, parents want somewhere to check, and you want your name on something you control. This guide compares the three main routes to an academy website, lists what the site actually needs to do, and helps you estimate the real cost with your own numbers.

## Do you need a website yet?

You probably do if any of these are true:

- you sell recorded courses, not only live sessions;
- you spend hours each week answering "how do I join?" and "how do I pay?";
- students need one place to find your courses, prices and rules;
- you want to build something under your own name that does not depend on one social network.

If you teach a handful of students in person and fill every group by word of mouth, a website can wait. Come back to this guide when the admin starts eating your evenings.

## Three routes

### A social page only

A Facebook or Instagram page, plus WhatsApp groups, costs nothing to start and meets students where they already are. The limits show up as you grow: there is no proper course catalogue, payments and access are all handled by hand, and the platform decides who sees your posts and can change its rules at any time.

### A custom build

You hire a developer or an agency to build a site and a student area. You get exactly what you specify, under your own domain. You also become the owner of a software project: hosting, security updates, bug fixes, video hosting, payment handling and every future change need someone to do them, and to be paid for them. Ask any developer you talk to who will look after the site in its second year.

### An academy platform

A platform built for teaching academies gives you a ready site, a student area, courses and payments, maintained by the platform. You trade some flexibility for not having to run the software yourself. The questions to ask are how the site looks under your name, what happens to your students' data, and which of your requirements the platform does not cover.

## The requirement checklist

Whichever route you choose, write down what the site must do. Teachers commonly need:

- a home page, an about page and a contact page under your name;
- a course catalogue with a page for each course;
- student accounts and a place where students find their courses;
- a way for students to pay and for you to confirm it;
- access control, so only enrolled students open paid lessons;
- some protection against account sharing and leaks;
- quizzes, assignments or exams;
- Arabic and English, laid out properly in each;
- your own address: a subdomain at first, your own domain later;
- a way to update content without calling a developer.

Mark each item as "must have now", "later" or "not needed". That list is what you compare routes against.

## What a cost estimate must include

A quote for "a website" rarely covers everything. Build your estimate from your own numbers:

- **Build:** design and development, or a platform subscription.
- **Hosting:** the server, the domain and the security certificate.
- **Video:** where your lesson videos live and what that costs as students grow.
- **Upkeep:** updates, fixes and changes over a full year, not just launch.
- **Your time:** hours each week you spend on admin that the site could save or add.

Compare the totals over twelve months, not just the first payment. A cheap build that needs constant fixing is not cheap.

## Arabic and English: plan both from the start

If your students read Arabic and some parents or adult learners prefer English, plan both versions from day one. Retrofitting a second language later is slow and error-prone. Decide which language is your main one, make sure every page has text in it, and translate the rest properly. Arabic pages need to read right to left, with numbers and Latin names displayed correctly.

## Your address and your pages

Start with a clear, short address that students can type and share. Many platforms give you a subdomain straight away, and you can move to your own domain once you have one. For pages, the core set is usually home, about, courses, FAQs and contact, plus a page for each course.

## Real student reviews

Reviews persuade parents more than any headline. Use only real ones, from students or parents who agreed to be quoted, and never invent names or quotes. Sample text that comes with a template should be replaced or removed before launch.

## Before you share the link

A new site is easy to share and hard to fix once hundreds of students have the link. Take an hour to check it as a visitor would:

- Open the site in a private browser window on a phone, not only on your laptop.
- Sign up as a test student with a second email address, and check the welcome you get.
- Open a course page and check the price, the description and the button a visitor sees.
- Switch to the other language and read every page. Look for English left in Arabic boxes and the reverse.
- Replace every piece of sample text, every placeholder image and every invented review.
- Check your phone number, email and address on the contact page.

Fix what you find, then share the link everywhere at once, so students do not end up on an old page or a group link.

## How this works in Atlas

Atlas gives every academy a public website, built from the same account that runs your courses and payments.

- **Your address.** Your academy gets its own Atlas address with HTTPS as soon as it is created. You can connect a domain you own, such as learn.your-academy.com, and it becomes your main address once it is verified and live.
- **Pages ready to edit.** Every academy starts with six core pages: Home, About, Courses, FAQs, Contact and the course details page, with starter content to replace before launch.
- **A visual editor.** Edit each page on the page itself, from more than 30 ready-made section types, such as a hero banner, featured courses, a class schedule, pricing plans, FAQs and a contact form, with previews at desktop, tablet and mobile widths.
- **Four themes.** Modern Education, Atelier, Manara and Riwaq. Switching keeps your content.
- **Your brand.** Upload your logo and Atlas suggests a readable colour palette from it.
- **Draft, then publish.** Changes stay in a draft until you publish, and Atlas keeps earlier versions of each page so you can go back.
- **Arabic and English.** Choose English or Arabic as your main language; the other is optional, and Arabic pages are shown right to left. Visitors can switch language from the header.
- **Search settings.** Each page is sent as complete HTML with its title, description and share image, and your site has a sitemap. Atlas cannot promise when or where your site appears in search results.

The website builder has no field for custom code, HTML or tracking pixels. See [Website builder overview](https://docs.atlass.dpdns.org/website/overview).

## Common questions

**Do I need my own domain on day one?**
No. Start with the address you get when the academy is created, and connect your own domain when you are ready.

**Can I build the site in Arabic only?**
You can make Arabic your main language and fill English later, or not at all. Where the other language is empty, visitors see the main-language text.

**How long does it take to launch?**
That depends on how much content you write and how many courses you prepare. Plan time to replace the sample text and to test the whole path as a student before you share the link.

## Key takeaways

- Choose a route by what you will have to manage, not only by the first price.
- Write a requirement list and mark what you need now.
- Estimate twelve months of cost, including your own time.
- Plan Arabic and English together, and use only real reviews.

For the payments side of your site, read [collecting course payments in Egypt](/blog/collecting-course-payments-in-egypt). To build and preview your own academy site, [start an academy trial](/pricing).
$atlasblog$,
   $atlasblog$Illustration of a laptop and a phone showing an academy website made of blocks, with a gold paintbrush and colour swatches.$atlasblog$,
   $atlasblog$How to build a website for your teaching academy$atlasblog$,
   $atlasblog$Social page, custom build or academy platform? Compare the routes, check the requirements, and estimate the real cost with your own numbers.$atlasblog$,
   7,
   $atlasblog$كيف تعمل موقعًا لأكاديميتك التعليمية بالعربي والإنجليزي$atlasblog$,
   $atlasblog$صفحة على السوشيال ميديا، أم موقع مبرمج خصيصًا، أم منصة أكاديميات؟ قارن الطرق الثلاث، وحدد ما يجب أن يفعله موقعك، واحسب التكلفة الحقيقية لسنة بأرقامك.$atlasblog$,
   $atlasblog$كثير من المدرسين يديرون شغلهم كله من صفحة فيسبوك وبضعة جروبات واتساب. وفي لحظة ما لا يعود هذا كافيًا: الطلاب يسألون أين يسجّلون، وأولياء الأمور يريدون مكانًا يتابعون منه، وأنت تريد اسمك على شيء تتحكم فيه. هذا الدليل يقارن بين الطرق الثلاث الرئيسية للحصول على موقع لأكاديميتك، ويحدد ما يجب أن يفعله الموقع فعلًا، ويساعدك على حساب التكلفة الحقيقية بأرقامك أنت.

## هل تحتاج موقعًا الآن؟

غالبًا تحتاجه إذا انطبق عليك أي مما يلي:

- تبيع كورسات مسجّلة، وليس حصصًا مباشرة فقط؛
- تقضي ساعات كل أسبوع في الرد على «أشترك إزاي؟» و«أدفع إزاي؟»؛
- يحتاج طلابك مكانًا واحدًا يجدون فيه كورساتك وأسعارك وقواعدك؛
- تريد أن تبني شيئًا باسمك لا يعتمد على شبكة اجتماعية واحدة.

أما إذا كنت تدرّس عددًا قليلًا من الطلاب حضوريًا، وتمتلئ مجموعاتك بالسمعة وحدها، فالموقع يمكن أن ينتظر. ارجع إلى هذا الدليل حين يبدأ الشغل الإداري في أكل أمسياتك.

## ثلاث طرق

### صفحة على السوشيال ميديا فقط

صفحة فيسبوك أو إنستجرام، ومعها جروبات واتساب، لا تكلّف شيئًا لتبدأ، وتصل إلى الطلاب حيث يوجدون بالفعل. لكن الحدود تظهر مع النمو: لا يوجد كتالوج كورسات حقيقي، والدفع والوصول للدروس كلها بيدك، والمنصة هي التي تقرر من يرى منشوراتك، وتستطيع تغيير قواعدها في أي وقت.

### موقع مبرمج خصيصًا لك

تتعاقد مع مبرمج أو شركة لبناء موقع ومنطقة للطلاب. تحصل على ما تطلبه بالضبط، وعلى الدومين الخاص بك. لكنك تصبح أيضًا صاحب مشروع برمجي: الاستضافة، وتحديثات الأمان، وإصلاح الأعطال، واستضافة الفيديو، والتعامل مع المدفوعات، وكل تعديل مستقبلي، كلها تحتاج من يقوم بها ومن يُدفع له. اسأل أي مبرمج تتحدث معه: من سيعتني بالموقع في سنته الثانية؟

### منصة أكاديميات

المنصة المصممة للأكاديميات التعليمية تعطيك موقعًا جاهزًا، ومنطقة للطلاب، وكورسات ومدفوعات، والمنصة هي التي تتولى صيانتها. تتنازل عن بعض المرونة مقابل ألا تدير البرامج بنفسك. والأسئلة المهمة: كيف يبدو الموقع باسمك؟ وماذا يحدث لبيانات طلابك؟ وأي متطلباتك لا تغطيها المنصة؟

## قائمة المتطلبات

أيًّا كانت الطريقة، اكتب ما يجب أن يفعله الموقع. المدرسون يحتاجون عادةً:

- صفحة رئيسية، وصفحة «عن الأكاديمية»، وصفحة تواصل باسمك؛
- كتالوج كورسات وصفحة لكل كورس؛
- حسابات للطلاب ومكانًا يجدون فيه كورساتهم؛
- طريقة يدفع بها الطلاب وتتأكد أنت من الدفع؛
- تحكمًا في الوصول، بحيث يفتح الدروس المدفوعة المشتركون فقط؛
- قدرًا من الحماية من مشاركة الحسابات والتسريب؛
- اختبارات أو واجبات أو امتحانات؛
- العربية والإنجليزية، بتنسيق صحيح في كل منهما؛
- عنوانًا خاصًا بك: نطاق فرعي في البداية، ثم الدومين الخاص بك لاحقًا؛
- طريقة لتحديث المحتوى بدون الاتصال بمبرمج.

ضع أمام كل بند: «لازم الآن»، أو «لاحقًا»، أو «لا أحتاجه». هذه القائمة هي ما تقارن به بين الطرق.

## ما يجب أن يشمله حساب التكلفة

عرض السعر لـ«موقع» نادرًا ما يغطي كل شيء. احسب التكلفة من أرقامك أنت:

- **البناء:** التصميم والبرمجة، أو اشتراك المنصة.
- **الاستضافة:** الخادم والدومين وشهادة الأمان.
- **الفيديو:** أين تُستضاف فيديوهات دروسك، وكم يكلّف ذلك مع زيادة الطلاب.
- **الصيانة:** التحديثات والإصلاحات والتعديلات على مدار سنة كاملة، وليس عند الإطلاق فقط.
- **وقتك:** الساعات التي تقضيها كل أسبوع في العمل الإداري، والتي قد يوفرها الموقع أو يزيدها.

قارن الإجمالي على مدى اثني عشر شهرًا، وليس الدفعة الأولى فقط. الموقع الرخيص الذي يحتاج إصلاحًا دائمًا ليس رخيصًا.

## العربية والإنجليزية: خطط للغتين من البداية

إذا كان طلابك يقرؤون بالعربية، وبعض أولياء الأمور أو الدارسين الكبار يفضّلون الإنجليزية، فخطط للنسختين من اليوم الأول. إضافة لغة ثانية لاحقًا عمل بطيء وكثير الأخطاء. حدد لغتك الأساسية، وتأكد أن كل صفحة فيها نص بهذه اللغة، ثم ترجم الباقي ترجمة سليمة. والصفحات العربية يجب أن تُقرأ من اليمين إلى اليسار، مع ظهور الأرقام والأسماء اللاتينية بشكل صحيح.

## عنوانك وصفحاتك

ابدأ بعنوان قصير وواضح يستطيع الطلاب كتابته ومشاركته. كثير من المنصات تعطيك نطاقًا فرعيًا فورًا، وتستطيع الانتقال إلى الدومين الخاص بك حين يكون لديك واحد. أما الصفحات، فالمجموعة الأساسية عادةً: الرئيسية، وعن الأكاديمية، والكورسات، والأسئلة الشائعة، والتواصل، بالإضافة إلى صفحة لكل كورس.

## آراء طلاب حقيقية

آراء الطلاب تقنع أولياء الأمور أكثر من أي عنوان رنان. استخدم الآراء الحقيقية فقط، من طلاب أو أولياء أمور وافقوا على نشر كلامهم، ولا تخترع أسماء أو اقتباسات أبدًا. والنصوص التجريبية التي تأتي مع أي قالب يجب استبدالها أو حذفها قبل الإطلاق.

## قبل أن تنشر اللينك

الموقع الجديد سهل المشاركة، لكن إصلاحه صعب بعد أن يصل لينكه إلى مئات الطلاب. خصّص ساعة لمراجعته كما يراه الزائر:

- افتح الموقع في نافذة تصفح خاصة على الموبايل، وليس على اللابتوب فقط.
- سجّل كطالب تجريبي ببريد إلكتروني آخر، وراجع رسالة الترحيب التي تصلك.
- افتح صفحة كورس، وراجع السعر والوصف والزر الذي يظهر للزائر.
- غيّر اللغة واقرأ كل صفحة. ابحث عن نص إنجليزي متروك في خانات العربية، والعكس.
- استبدل كل نص تجريبي، وكل صورة مؤقتة، وكل رأي غير حقيقي.
- راجع رقم موبايلك وبريدك وعنوانك في صفحة التواصل.

أصلح ما تجده، ثم انشر اللينك في كل مكان مرة واحدة، حتى لا يصل الطلاب إلى صفحة قديمة أو لينك جروب قديم. ومن المفيد أن تطلب من زميل أو طالب تثق فيه أن يجرّب الموقع من موبايله ويخبرك بأي شيء لم يفهمه، لأن عينك اعتادت على صفحاتك ولن تلاحظ كل شيء.

## كيف يعمل هذا في أطلس

يعطي أطلس كل أكاديمية موقعًا عامًا، من نفس الحساب الذي تدير منه كورساتك ومدفوعاتك.

- **عنوانك.** تحصل أكاديميتك على عنوان خاص بها على أطلس مع HTTPS فور إنشائها. وتستطيع ربط دومين تملكه، مثل learn.your-academy.com، فيصبح عنوانك الأساسي بعد التحقق منه وتفعيله.
- **صفحات جاهزة للتعديل.** كل أكاديمية تبدأ بست صفحات أساسية: الرئيسية، وعن الأكاديمية، والكورسات، والأسئلة الشائعة، وتواصل معنا، وصفحة تفاصيل الكورس، ومعها محتوى مبدئي تستبدله قبل الإطلاق.
- **محرّر مرئي.** تعدّل كل صفحة على الصفحة نفسها، من أكثر من ثلاثين نوعًا جاهزًا من الأقسام، مثل البانر الرئيسي، والكورسات المميزة، وجدول الحصص، والباقات، والأسئلة الشائعة، ونموذج التواصل، مع معاينة على الكمبيوتر والتابلت والموبايل.
- **أربعة تصميمات.** Modern Education وAtelier وManara وRiwaq. وتغيير التصميم يحافظ على محتواك.
- **هويتك.** ارفع شعارك، فيقترح أطلس ألوانًا مقروءة مستوحاة منه.
- **مسودة ثم نشر.** تعديلاتك تبقى في المسودة حتى تنشر، ويحتفظ أطلس بنسخ سابقة من كل صفحة لتعود إليها.
- **العربية والإنجليزية.** اختر الإنجليزية أو العربية لغة أساسية؛ واللغة الأخرى اختيارية، والصفحات العربية تُعرض من اليمين إلى اليسار. ويستطيع الزائر تغيير اللغة من أعلى الموقع.
- **إعدادات محركات البحث.** كل صفحة تُرسل كـHTML كامل بعنوانها ووصفها وصورة المشاركة، ولموقعك خريطة موقع. ولا يستطيع أطلس أن يعدك بموعد أو مكان ظهور موقعك في نتائج البحث.

ومنشئ الموقع ليس فيه خانة لكود مخصص أو HTML أو أكواد تتبّع. راجع [نظرة على منشئ الموقع](https://docs.atlass.dpdns.org/ar/website/overview).

## أسئلة شائعة

**هل أحتاج دومينًا خاصًا من أول يوم؟**
لا. ابدأ بالعنوان الذي تحصل عليه عند إنشاء الأكاديمية، واربط الدومين الخاص بك حين تكون جاهزًا.

**هل أستطيع بناء الموقع بالعربية فقط؟**
تستطيع أن تجعل العربية لغتك الأساسية وتملأ الإنجليزية لاحقًا، أو لا تملأها أصلًا. وحيث تكون اللغة الأخرى فارغة، يرى الزائر نص اللغة الأساسية.

**كم يستغرق الإطلاق؟**
يعتمد ذلك على كمية المحتوى الذي تكتبه وعدد الكورسات التي تجهزها. خصّص وقتًا لاستبدال النص المبدئي، ولتجربة المسار كاملًا كطالب قبل أن تنشر اللينك.

## الخلاصة

- اختر الطريقة بناءً على ما ستضطر لإدارته، وليس بالسعر الأول فقط.
- اكتب قائمة متطلبات، وحدد ما تحتاجه الآن.
- احسب تكلفة اثني عشر شهرًا، ومعها وقتك.
- خطط للعربية والإنجليزية معًا، واستخدم الآراء الحقيقية فقط.

لجانب المدفوعات في موقعك، اقرأ [تحصيل فلوس الكورسات في مصر](/ar/blog/collecting-course-payments-in-egypt). ولتبني موقع أكاديميتك وتعاينه، [ابدأ تجربة أكاديميتك](/ar/pricing).
$atlasblog$,
   $atlasblog$رسم للابتوب وموبايل يعرضان موقع أكاديمية مكوّنًا من أقسام، وبجوارهما فرشاة ذهبية وعينات ألوان.$atlasblog$,
   $atlasblog$كيف تعمل موقعًا لأكاديميتك التعليمية بالعربي والإنجليزي$atlasblog$,
   $atlasblog$صفحة فيسبوك أم موقع مبرمج خصيصًا أم منصة أكاديميات؟ قارن بين الطرق، وراجع المتطلبات، واحسب التكلفة الحقيقية بأرقامك أنت قبل أن تقرر.$atlasblog$,
   6),
  ($atlasblog$3e427114-ca5b-590b-8fe3-b23f85784955$atlasblog$,
   $atlasblog$thanaweya-amma-season-planner$atlasblog$,
   $atlasblog$pillar$atlasblog$::"platform_blog_post_kind",
   $atlasblog$season$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-13T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-13T08:00:00Z$atlasblog$::timestamp,
   true,
   $atlasblog$/marketing-assets/blog/thanaweya-amma-season-planner.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$49f7ec27-733e-58c9-8881-ca5fd039d9d0$atlasblog$,$atlasblog$a574cf55-55ed-5d59-af53-4c9d76a3dff5$atlasblog$,$atlasblog$5cdb7352-565e-57a5-b406-7f6fa77e1944$atlasblog$]::TEXT[],
   $atlasblog$Thanaweya Amma season planner for teachers moving online$atlasblog$,
   $atlasblog$Plan the Thanaweya year online, phase by phase: the decisions to make before the season, during each term, through revision and exam weeks, and after results.$atlasblog$,
   $atlasblog$A Thanaweya Amma year online runs in phases: setup before the season, the first term, the mid-year break, the second term and revision, exam weeks, and the weeks after results. Each phase has a few decisions that cannot be left late. This planner lists them in order so you can turn it into your own checklist. Exact term and exam dates change each year, so take them from the Ministry of Education's official calendar and fill them in yourself.

## The season at a glance

| Phase | Your main job | Decisions due |
|---|---|---|
| Before the season | Set up | Price model, payment routine, device rule, team, exam plan |
| First term | Deliver and settle the routine | Renewal dates, support hours |
| Mid-year break | Fix and prepare | What broke, term two content |
| Second term and revision | Revise and test | Revision packages, practice and graded exams |
| Exam weeks | Support | What stays open, how you answer questions |
| After results | Renew and reflect | Next cohort, what to keep and change |

## Before the season: setup decisions

Most of the stress of a season comes from decisions made in a hurry in its first week. Make these before you open registration.

- **Price model.** Per course, per term or per month. Whatever you choose, write down what each payment buys and when access ends.
- **Payment routine.** Which payment methods you accept, what reference students write, who confirms payments and how quickly. Our guide on [collecting course payments in Egypt](/blog/collecting-course-payments-in-egypt) covers this in detail.
- **Device rule.** How many devices a student account can use, and what students do when they change phones. Tell students before they pay.
- **Your team.** If assistants help you, decide who does what: who builds lessons, who grades, who answers students. Keep money decisions with one person.
- **Exam plan.** How many quizzes and exams, roughly when, and whether results count toward anything. See [how to run fair online exams](/blog/fair-online-exams-for-secondary-students).
- **Who can join.** Open sign-up, sign-ups you approve, or invitation only.

Then build the first weeks of content and test the whole path yourself: sign up as a student, pay, open a lesson, take a quiz. Preview every course as a student before you publish it, so nobody enrols in an empty course.

## First term: delivery routine and monthly renewals

The first term is when your routine either settles or starts to fray.

- **Publish on a rhythm.** Students and parents relax when lessons arrive on the same days each week.
- **Renewals.** If students pay monthly, keep a list of access end dates and remind students a few days before.
- **Support hours.** Decide when you answer messages and say so. Students accept a clear answer time far better than silence.
- **Watch the signals.** Look for students who stop opening lessons, and for accounts that may be shared.

## Mid-year break: fix what broke, prepare term two

The break is short, and it is the only quiet stretch you will get.

- Review the first term: which payments caused problems, which lessons confused students, which questions came up again and again.
- Fix the routine before term two, not during it.
- Build the first weeks of term two content so you start ahead.
- If term two has new students joining, prepare a short welcome: how to sign up, how to pay, how many devices, where to ask for help.

## Second term and revision season

This is the busiest stretch. Many students who were quiet all year now want everything at once.

- **Revision packages.** Package revision sessions (مراجعات) as their own courses, with a clear price and end date, so students know exactly what they are buying.
- **Practice before graded exams.** Run practice quizzes with answers shown straight away, then graded exams with a time limit and answers hidden until the end.
- **Plan around Ramadan.** In years when Ramadan falls during this stretch, adjust lesson and exam times, and confirm the dates locally.
- **Watch capacity.** If many students join late, check that your payment routine and support hours still hold.

## Exam weeks: support and calm

Once the official exams start, your role changes from teacher to steady presence.

- Decide what stays open: revision lessons, practice quizzes, a final summary.
- Keep messages short and calm. Avoid adding new content students feel they must watch.
- Do not change rules, prices or access in the middle of exams.

## After results: renewals and the next cohort

When results are announced, your year closes and the next one starts.

- Thank students and parents, and ask for honest feedback.
- Collect real testimonials only from students or parents who agree to be quoted.
- Decide what to keep, change or drop next year.
- Open registration for the next cohort with your rules already written.

## Keep one record for the whole year

A season is long, and it is easy to forget in May what you decided in September. Keep one simple record, a notebook or a shared sheet, with four parts:

- **Decisions.** Your prices, access end dates, device rule and exam plan, with the date you made each decision.
- **Students.** Who joined when, which courses they hold, and anything you agreed with them individually.
- **Payments.** Every confirmed payment, with the date, amount and reference.
- **Lessons and exams.** What you published and when, and what you plan next.

Ten minutes at the end of each week keeps it current. When a parent asks a question in March, or you plan next year in July, the answer is already written down.

## How this works in Atlas

Atlas lets you run the year above from one account.

- **Guided setup.** After you sign up and start a trial, a setup wizard takes you through your plan, your academy, publishing your website and your first course. A checklist on your dashboard shows what is left.
- **Courses from what you already have.** Build courses from units of YouTube video lessons, quizzes and assignments. Quizzes have practice and exam presets, time limits, attempts and exceptions for individual students.
- **Payments you approve.** Students pay you by wallet, InstaPay or bank transfer and upload the proof. You approve it and they are enrolled in the course.
- **Access end dates.** When you enrol a student by hand, for example after a cash payment, you can set the day their access ends and change it later.
- **Who can join.** Choose open registration, approval required, or invite only.
- **Your team.** Add assistants as managers or instructors. Instructors work only on the courses you assign to them. Only you, the owner, approve payments.

Before your first student joins, work through the [launch checklist](https://docs.atlass.dpdns.org/getting-started/launch-checklist): publish your website, publish a course with a lesson that opens, turn on a payment method, choose who can join, and test the whole path as a student.

## Common questions

**When should I start setting up?**
Before you announce registration. Give yourself time to build the first weeks of content and to test the path as a student.

**Should I charge per month or per term?**
Either works if it is clear. Monthly payments mean more renewals to manage; term payments mean larger amounts at once. Write down what each payment buys and when access ends.

**Where do I get the exam dates?**
From the Ministry of Education's official announcements. Dates shared on social media change and are often wrong.

**What if many students join in the middle of the year?**
Prepare a short welcome for late joiners: how to sign up, how to pay, how many devices, and which earlier lessons to watch first. Decide in advance whether late joiners pay the full price or only for the months left, and apply the same rule to everyone.

## Your season checklist

1. Write your price model and access end dates.
2. Set your payment routine and who approves.
3. Decide your device rule and tell students.
4. Assign roles to your assistants.
5. Plan quizzes and exams, practice first.
6. Test the full student path before opening registration.

To start setting up your season, [start an academy trial](/pricing).
$atlasblog$,
   $atlasblog$Illustration of a wall calendar with gold-highlighted days, a winding path with flags leading to a graduation cap, and a lantern.$atlasblog$,
   $atlasblog$Thanaweya Amma season planner for teachers going online$atlasblog$,
   $atlasblog$Plan the Thanaweya year online: the decisions to make before the season, during each term, through revision and after results.$atlasblog$,
   7,
   $atlasblog$مخطط موسم الثانوية العامة للمدرس الذي ينقل دروسه أونلاين$atlasblog$,
   $atlasblog$خطط سنة الثانوية العامة أونلاين مرحلة بمرحلة: القرارات المطلوبة قبل الموسم، وفي كل ترم، وفي المراجعات وأسابيع الامتحانات، وبعد النتيجة.$atlasblog$,
   $atlasblog$سنة الثانوية العامة أونلاين تمر بمراحل: التجهيز قبل الموسم، ثم الترم الأول، ثم إجازة نصف العام، ثم الترم الثاني والمراجعات، ثم أسابيع الامتحانات، ثم الأسابيع التي تلي النتيجة. ولكل مرحلة قرارات قليلة لا تحتمل التأجيل. هذا المخطط يرتّبها لك حتى تحوّلها إلى قائمة مهام خاصة بك. ومواعيد الترمات والامتحانات تتغير كل سنة، فخذها من التقويم الرسمي لوزارة التربية والتعليم واكتبها بنفسك.

## الموسم في لمحة

| المرحلة | مهمتك الأساسية | القرارات المطلوبة |
|---|---|---|
| قبل الموسم | التجهيز | طريقة التسعير، ونظام التحصيل، وقاعدة الأجهزة، والفريق، وخطة الامتحانات |
| الترم الأول | التدريس وتثبيت النظام | مواعيد التجديد، وساعات الرد |
| إجازة نصف العام | الإصلاح والتحضير | ما الذي تعطّل، ومحتوى الترم الثاني |
| الترم الثاني والمراجعات | المراجعة والاختبار | باقات المراجعات، وامتحانات التدريب والامتحانات المحسوبة |
| أسابيع الامتحانات | الدعم | ما يظل متاحًا، وطريقة الرد على الأسئلة |
| بعد النتيجة | التجديد والمراجعة | الدفعة الجديدة، وما تبقيه وما تغيّره |

## قبل الموسم: قرارات التجهيز

أغلب ضغط الموسم يأتي من قرارات تؤخذ على عجل في أسبوعه الأول. خذ هذه القرارات قبل أن تفتح باب التسجيل.

- **طريقة التسعير.** بالكورس، أو بالترم، أو بالشهر. وأيًّا كان اختيارك، اكتب ما تشتريه كل دفعة ومتى ينتهي الوصول.
- **نظام التحصيل.** أي طرق دفع تقبل، وأي مرجع يكتبه الطلاب، ومن يؤكد المدفوعات وبأي سرعة. دليلنا عن [تحصيل فلوس الكورسات في مصر](/ar/blog/collecting-course-payments-in-egypt) يشرح ذلك بالتفصيل.
- **قاعدة الأجهزة.** كم جهازًا يعمل عليه حساب الطالب، وماذا يفعل الطالب إذا غيّر موبايله. أخبر الطلاب قبل أن يدفعوا.
- **فريقك.** إذا كان معك مساعدون، فحدد من يفعل ماذا: من يجهّز الدروس، ومن يصحح، ومن يرد على الطلاب. واجعل قرارات الفلوس مع شخص واحد.
- **خطة الامتحانات.** كم اختبارًا وامتحانًا، وفي أي توقيت تقريبًا، وهل تُحتسب نتائجها في شيء. راجع [كيف تعمل امتحانات أونلاين عادلة](/ar/blog/fair-online-exams-for-secondary-students).
- **من يستطيع الانضمام.** تسجيل مفتوح، أو تسجيل تراجعه وتوافق عليه، أو بالدعوة فقط.

ثم جهّز محتوى الأسابيع الأولى، وجرّب المسار كله بنفسك: سجّل كطالب، وادفع، وافتح درسًا، وحلّ اختبارًا. واعرض كل كورس كما يراه الطالب قبل أن تنشره، حتى لا يشترك أحد في كورس فارغ.

## الترم الأول: نظام التدريس والتجديد الشهري

الترم الأول هو الوقت الذي يثبت فيه نظامك أو يبدأ في التفكك.

- **انشر بإيقاع ثابت.** الطلاب وأولياء الأمور يطمئنون حين تصل الدروس في نفس الأيام كل أسبوع.
- **التجديدات.** إذا كان الطلاب يدفعون شهريًا، فاحتفظ بقائمة بمواعيد انتهاء الوصول، وذكّر الطلاب قبلها ببضعة أيام.
- **ساعات الرد.** حدد متى ترد على الرسائل وأعلن ذلك. الطلاب يتقبلون موعد رد واضحًا أكثر بكثير من الصمت.
- **راقب المؤشرات.** انتبه للطلاب الذين توقفوا عن فتح الدروس، وللحسابات التي قد تكون متشاركة.

## إجازة نصف العام: أصلح ما تعطّل وجهّز الترم الثاني

الإجازة قصيرة، وهي الفترة الهادئة الوحيدة التي ستحصل عليها.

- راجع الترم الأول: أي مدفوعات سببت مشاكل، وأي دروس أربكت الطلاب، وأي أسئلة تكررت كثيرًا.
- أصلح نظامك قبل الترم الثاني، وليس أثناءه.
- جهّز محتوى الأسابيع الأولى من الترم الثاني حتى تبدأ متقدمًا.
- إذا كان هناك طلاب جدد سينضمون في الترم الثاني، فجهّز لهم ترحيبًا قصيرًا: كيف يسجّلون، وكيف يدفعون، وكم جهازًا مسموحًا، وأين يسألون.

## الترم الثاني وموسم المراجعات

هذه أزحم فترة في السنة. كثير من الطلاب الذين كانوا هادئين طوال العام يريدون الآن كل شيء دفعة واحدة.

- **باقات المراجعات.** اجعل المراجعات كورسات مستقلة، بسعر واضح وموعد انتهاء واضح، حتى يعرف الطالب بالضبط ما يشتريه.
- **التدريب قبل الامتحانات المحسوبة.** اعمل اختبارات تدريب تظهر إجاباتها فورًا، ثم امتحانات محسوبة بوقت محدد وإجابات مخفية حتى النهاية.
- **خطط حول رمضان.** في السنوات التي يأتي فيها رمضان خلال هذه الفترة، عدّل مواعيد الدروس والامتحانات، وتأكد من التواريخ محليًا.
- **راقب قدرتك.** إذا انضم طلاب كثيرون متأخرين، فتأكد أن نظام التحصيل وساعات الرد ما زالا يتحملان.

## أسابيع الامتحانات: دعم وهدوء

حين تبدأ الامتحانات الرسمية، يتغير دورك من مدرس إلى حضور ثابت ومطمئن.

- حدد ما يظل متاحًا: دروس المراجعة، واختبارات التدريب، وملخص أخير.
- اجعل رسائلك قصيرة وهادئة. وتجنّب إضافة محتوى جديد يشعر الطلاب أنهم ملزمون بمشاهدته.
- لا تغيّر القواعد أو الأسعار أو الوصول في منتصف الامتحانات.

## بعد النتيجة: التجديد والدفعة الجديدة

حين تُعلن النتيجة، تُغلق سنتك وتبدأ السنة التالية.

- اشكر الطلاب وأولياء الأمور، واطلب رأيهم بصراحة.
- اجمع آراء حقيقية فقط، من طلاب أو أولياء أمور وافقوا على نشر كلامهم.
- قرر ما تبقيه، وما تغيّره، وما تتركه في السنة القادمة.
- افتح التسجيل للدفعة الجديدة وقواعدك مكتوبة بالفعل.

## سجل واحد للسنة كلها

الموسم طويل، ومن السهل أن تنسى في مايو ما قررته في سبتمبر. احتفظ بسجل واحد بسيط، كشكول أو شيت مشترك، فيه أربعة أجزاء:

- **القرارات.** أسعارك، ومواعيد انتهاء الوصول، وقاعدة الأجهزة، وخطة الامتحانات، مع تاريخ كل قرار.
- **الطلاب.** من انضم ومتى، وما الكورسات التي معه، وأي اتفاق خاص عقدته معه.
- **المدفوعات.** كل دفعة تأكدت منها، بتاريخها ومبلغها ومرجعها.
- **الدروس والامتحانات.** ما نشرته ومتى، وما تخطط له بعد ذلك.

عشر دقائق في نهاية كل أسبوع تكفي لتحديثه. وحين يسألك ولي أمر سؤالًا في مارس، أو تخطط للسنة الجديدة في يوليو، تجد الإجابة مكتوبة بالفعل. وإذا كان معك مساعدون، فاجعل السجل في مكان يراه الجميع، حتى لا تتكرر الأسئلة ولا تضيع القرارات بين المحادثات، وحتى يعرف كل واحد منهم ما اتفقتم عليه دون أن يسألك في كل مرة.

## كيف يعمل هذا في أطلس

يتيح لك أطلس إدارة السنة كلها من حساب واحد.

- **تجهيز بخطوات واضحة.** بعد التسجيل وبدء التجربة، يأخذك معالج الإعداد خطوة بخطوة: الباقة، ثم الأكاديمية، ثم نشر الموقع، ثم أول كورس. وفي لوحة التحكم قائمة توضح ما تبقى.
- **كورسات مما لديك بالفعل.** ابنِ كورساتك من وحدات فيها دروس فيديو من يوتيوب واختبارات وواجبات. وللاختبارات إعدادان جاهزان للتدريب والامتحان، ووقت محدد، وعدد محاولات، واستثناءات لطلاب بعينهم.
- **مدفوعات توافق عليها.** يدفع لك الطلاب بالمحفظة أو إنستاباي أو التحويل البنكي، ويرفعون الإثبات. توافق أنت، فيُسجَّلون في الكورس.
- **مواعيد انتهاء الوصول.** حين تسجّل طالبًا بنفسك، مثلًا بعد دفع نقدي، تستطيع تحديد اليوم الذي ينتهي فيه وصوله وتغييره لاحقًا.
- **من يستطيع الانضمام.** اختر بين التسجيل المفتوح، أو التسجيل بموافقتك، أو بالدعوة فقط.
- **فريقك.** أضف مساعديك كمديرين أو مدرّسين. المدرّس يعمل فقط في الكورسات التي تسندها إليه. وأنت وحدك، صاحب الحساب، توافق على المدفوعات.

وقبل أن ينضم أول طالب، امشِ على [قائمة الإطلاق](https://docs.atlass.dpdns.org/ar/getting-started/launch-checklist): انشر موقعك، وانشر كورسًا فيه درس يفتح، وفعّل طريقة دفع، واختر من يستطيع الانضمام، وجرّب المسار كاملًا كطالب.

## أسئلة شائعة

**متى أبدأ التجهيز؟**
قبل أن تعلن عن التسجيل. أعطِ نفسك وقتًا لتجهيز محتوى الأسابيع الأولى وتجربة المسار كطالب.

**هل أحاسب بالشهر أم بالترم؟**
الاثنان ينفعان ما دامت القاعدة واضحة. الدفع الشهري يعني تجديدات أكثر تديرها، والدفع بالترم يعني مبالغ أكبر مرة واحدة. اكتب ما تشتريه كل دفعة ومتى ينتهي الوصول.

**من أين آخذ مواعيد الامتحانات؟**
من الإعلانات الرسمية لوزارة التربية والتعليم. المواعيد المتداولة على السوشيال ميديا تتغير، وكثيرًا ما تكون خاطئة.

**وماذا لو انضم طلاب كثيرون في منتصف السنة؟**
جهّز ترحيبًا قصيرًا للمنضمين متأخرين: كيف يسجّلون، وكيف يدفعون، وكم جهازًا مسموحًا لهم، وأي الدروس السابقة يشاهدونها أولًا. وقرر مسبقًا هل يدفع المنضم متأخرًا السعر كاملًا أم الشهور المتبقية فقط، وطبّق نفس القاعدة على الجميع حتى لا يشعر أحد بأنه ظُلم.

## قائمة الموسم

1. اكتب طريقة التسعير ومواعيد انتهاء الوصول.
2. حدد نظام التحصيل ومن يوافق.
3. قرر قاعدة الأجهزة وأخبر بها الطلاب.
4. وزّع الأدوار على مساعديك.
5. خطط للاختبارات والامتحانات، والتدريب أولًا.
6. جرّب مسار الطالب كاملًا قبل فتح التسجيل.

لتبدأ تجهيز موسمك، [ابدأ تجربة أكاديميتك](/ar/pricing).
$atlasblog$,
   $atlasblog$رسم لتقويم حائط فيه أيام مظللة بالذهبي، وطريق متعرج عليه أعلام ينتهي بقبعة تخرج، وفانوس.$atlasblog$,
   $atlasblog$مخطط موسم الثانوية العامة للمدرس الذي ينقل دروسه أونلاين$atlasblog$,
   $atlasblog$خطط سنة الثانوية العامة أونلاين: القرارات التي يجب أن تأخذها قبل الموسم، وفي كل ترم، وفي موسم المراجعات، وبعد إعلان النتيجة.$atlasblog$,
   6),
  ($atlasblog$5ae035f1-0fe2-50cb-ac85-689682b880a2$atlasblog$,
   $atlasblog$can-you-stop-screen-recording$atlasblog$,
   $atlasblog$cluster$atlasblog$::"platform_blog_post_kind",
   $atlasblog$protection$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-15T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-15T08:00:00Z$atlasblog$::timestamp,
   false,
   $atlasblog$/marketing-assets/blog/can-you-stop-screen-recording.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$9f9b6dcd-ebd3-5061-8e0f-e2e8d2d628db$atlasblog$,$atlasblog$5b2b0f14-bf04-5f81-869c-30f3d565432f$atlasblog$,$atlasblog$d4375d4e-64a1-5988-955a-819100fa6442$atlasblog$]::TEXT[],
   $atlasblog$Can you stop screen recording of online lessons? An honest answer$atlasblog$,
   $atlasblog$No web page can fully stop screen or camera recording. Here is why, what plugins and DRM really do, and the measures that still make sharing your lessons less likely.$atlasblog$,
   $atlasblog$The short answer is no. No web page, plugin or teaching platform can fully stop a student from recording the screen or filming it with a second phone. What you can do is make recordings traceable, make account sharing inconvenient, and close a few smaller gaps such as picture-in-picture and casting. The rest of this post explains why, and what to do instead.

## Why a browser cannot block recording

Your lesson plays inside a web page, and the web page runs inside the student's browser on the student's device. Screen recording tools sit one level below that: they are part of the phone or laptop's operating system, or separate programs the student installed. The page has no say over them.

Then there is the simplest method of all. A student can prop up a second phone and film the screen. That needs no software on the laptop, leaves no trace in the browser, and works on every lesson ever made. Any promise to "block recording" has to ignore this case to sound true.

## What anti-recording plugins and DRM really do

Some tools do have an effect. Certain plugins detect or block some recording programs in some browsers. DRM systems can protect the video stream itself in certain setups. These are real features, and for some teachers they are worth the cost.

The honest framing is narrower than the marketing:

- They cover some recording programs, not all of them.
- They depend on the browser and device the student uses, and can cause playback problems on others.
- None of them can stop a phone camera pointed at the screen.

If you use one, describe it to students for what it does. Telling a class that lessons "cannot be recorded" invites someone to prove you wrong, and it makes your other rules look less credible.

## Picture-in-picture, casting and full screen

There are smaller leaks worth closing. Picture-in-picture pops the video into a floating window, and casting sends it to another screen. Both can show the video outside the player your rules apply to. A player can switch these off in browsers that respect the setting. Some browsers, including some versions of Firefox, show their own picture-in-picture button anyway, so treat this as reducing the gap, not closing it.

Full screen matters too. If anything you show on top of the video, such as a viewer code, disappears in full screen, students will simply watch in full screen.

## What works instead

Since recording cannot be blocked, aim for three things.

1. **Make every recording carry a name.** A visible code on the video, tied to the student watching, means a recording is no longer anonymous. Students know it, and that changes how many of them share. Our guide to [the forensic watermark](/blog/forensic-watermark-explained) explains what such a code can and cannot tell you.
2. **Make account sharing annoying.** One account per student, a limit on devices, and lessons that play on one screen at a time mean a shared password gets in everyone's way.
3. **Have a response plan.** When a copy turns up, act in a set order: evidence, code, trace, account, report. The broader picture is in our pillar guide on [how to protect paid courses from leaks](/blog/how-to-protect-paid-courses-from-leaks).

## How this works in Atlas

Atlas cannot stop screen recording, and it has no DRM. It tells students the same thing: each lesson has a small panel, "What is actually protecting this lesson", which lists the measures that apply and says that none of them stops screen recording.

What Atlas does:

- Every lesson video watched in your academy shows a visible label with the student's personal code, moving around the picture, plus a faint pattern of the code across the whole video. It is always on.
- Full screen keeps the watermark.
- The player has no download button, and it turns off picture-in-picture and casting in browsers that respect that setting.
- If the watermark is hidden or removed in the browser, playback pauses and Atlas is notified. Someone who controls their own browser can still remove it; Atlas notices, but cannot make that impossible.
- Each student can use a limited number of devices, which you set, and lessons play on one device at a time.

One more limit: lessons on Atlas are YouTube videos played inside your academy. A determined student can find the YouTube link and watch the video on YouTube, where there is no watermark. See [the content protection FAQ](https://docs.atlass.dpdns.org/faq/content-protection) for the full list.

## Common questions

**Will students know the code is there?**
Yes, and that is the point. The code is visible on purpose so that students know a recording carries it.

**Does a visible code slow the video down?**
The code is drawn over the player while the video plays. Students watch the lesson as usual, with the code moving on top.

**What about phone recordings of the screen?**
Nothing on the web can stop them. A phone recording of a lesson with a visible code still captures the code, as long as it stays readable in the copy.

## Key takeaways

- No web page can fully stop screen recording or filming.
- Plugins and DRM cover some cases; describe them honestly if you use them.
- A visible viewer code, device limits and a response plan do more than any "no recording" promise.

Want to see what students see? [Start an academy trial](/pricing), add a YouTube lesson and preview it with the viewer code moving on top.
$atlasblog$,
   $atlasblog$Illustration of a phone on a small tripod pointed at a laptop that is playing a lesson video, with notebooks and pencils on the desk.$atlasblog$,
   $atlasblog$Can you block screen recording of online lessons?$atlasblog$,
   $atlasblog$No web page can fully stop screen or camera recording. What that means for paid lessons, and the measures that still reduce sharing.$atlasblog$,
   5,
   $atlasblog$هل يمكن منع تصوير الشاشة في الدروس الأونلاين؟ إجابة بصراحة$atlasblog$,
   $atlasblog$لا توجد صفحة ويب تستطيع منع تسجيل الشاشة أو تصويرها بالكاميرا تمامًا. إليك السبب، وما تفعله إضافات المنع وDRM فعلًا، والإجراءات التي تقلل مشاركة دروسك.$atlasblog$,
   $atlasblog$الإجابة المختصرة: لا. لا توجد صفحة ويب أو إضافة أو منصة تعليمية تستطيع أن تمنع الطالب تمامًا من تسجيل الشاشة أو تصويرها بموبايل ثانٍ. ما تستطيعه هو أن تجعل التسجيل قابلًا للتتبّع، وأن تجعل مشاركة الحساب متعبة، وأن تغلق بعض الثغرات الصغيرة مثل الصورة داخل الصورة والبث إلى شاشة أخرى. باقي المقال يشرح السبب، وما الذي تفعله بدلًا من ذلك.

## لماذا لا يستطيع المتصفح منع التسجيل؟

درسك يعمل داخل صفحة ويب، والصفحة تعمل داخل متصفح الطالب على جهاز الطالب. أما برامج تسجيل الشاشة فتعمل في مستوى أعمق من ذلك: هي جزء من نظام تشغيل الموبايل أو اللابتوب، أو برامج مستقلة ثبّتها الطالب بنفسه. والصفحة لا سلطان لها عليها.

ثم هناك الطريقة الأبسط على الإطلاق. يستطيع الطالب أن يسند موبايلًا ثانيًا ويصوّر الشاشة. هذا لا يحتاج أي برنامج على اللابتوب، ولا يترك أي أثر في المتصفح، وينجح مع أي درس. وأي وعد بأن المنصة «تمنع التسجيل» يتجاهل هذه الحالة حتى يبدو صحيحًا.

## ماذا تفعل إضافات منع التسجيل وDRM فعلًا؟

بعض الأدوات لها أثر حقيقي. بعض الإضافات تكتشف أو تمنع برامج تسجيل معينة في متصفحات معينة. وأنظمة DRM قد تحمي بث الفيديو نفسه في إعدادات معينة. هذه مزايا حقيقية، وقد تستحق تكلفتها عند بعض المدرسين.

لكن الوصف الصادق أضيق من الدعاية:

- تغطي بعض برامج التسجيل، وليس كلها.
- تعتمد على المتصفح والجهاز الذي يستخدمه الطالب، وقد تسبب مشاكل في التشغيل على أجهزة أخرى.
- لا يستطيع أي منها أن يمنع كاميرا موبايل موجّهة إلى الشاشة.

إذا استخدمت واحدة منها، فاشرحها لطلابك كما هي. حين تقول لطلابك إن الدروس «لا يمكن تسجيلها»، فأنت تدعو أحدهم لإثبات العكس، وتُضعف ثقتهم في باقي قواعدك.

## الصورة داخل الصورة والبث وملء الشاشة

هناك ثغرات أصغر تستحق أن تُغلق. خاصية الصورة داخل الصورة تُخرج الفيديو في نافذة عائمة، والبث يرسله إلى شاشة أخرى. وكلاهما قد يعرض الفيديو خارج المشغّل الذي تنطبق عليه قواعدك. المشغّل يستطيع إيقاف هاتين الخاصيتين في المتصفحات التي تلتزم بالإعداد. لكن بعض المتصفحات، ومنها بعض إصدارات فايرفوكس، تُظهر زر الصورة داخل الصورة الخاص بها على أي حال، لذلك اعتبر هذا تقليلًا للثغرة وليس إغلاقًا كاملًا لها.

وملء الشاشة مهم أيضًا. إذا اختفى أي شيء تعرضه فوق الفيديو، مثل كود المشاهد، عند ملء الشاشة، فسيشاهد الطلاب ببساطة في وضع ملء الشاشة.

## ما الذي ينفع بدلًا من ذلك؟

ما دام التسجيل لا يمكن منعه، فاجعل هدفك ثلاثة أشياء:

1. **اجعل كل تسجيل يحمل اسم صاحبه.** كود ظاهر على الفيديو، مرتبط بالطالب الذي يشاهد، يعني أن التسجيل لم يعد مجهول المصدر. الطلاب يعرفون ذلك، وهذا يغيّر عدد من يشارك منهم. دليلنا عن [العلامة المائية للتتبّع](/ar/blog/forensic-watermark-explained) يشرح ما يستطيع هذا الكود أن يخبرك به وما لا يستطيع.
2. **اجعل مشاركة الحساب مزعجة.** حساب لكل طالب، وحد لعدد الأجهزة، ودروس تعمل على شاشة واحدة في المرة. بهذا تصبح كلمة السر المتشاركة عائقًا لكل من يستخدمها.
3. **جهّز خطة للتصرف.** حين تظهر نسخة، تحرّك بترتيب ثابت: الدليل، ثم الكود، ثم التتبّع، ثم قرار الحساب، ثم البلاغ. الصورة الكاملة في دليلنا الرئيسي عن [حماية الكورسات المدفوعة من التسريب](/ar/blog/how-to-protect-paid-courses-from-leaks).

## كيف يعمل هذا في أطلس

أطلس لا يستطيع منع تسجيل الشاشة، وليس فيه DRM. ويقول ذلك لطلابك أيضًا: في كل درس لوحة صغيرة بعنوان «ما الذي يحمي هذا الدرس فعليًا»، تذكر الإجراءات المطبّقة، وتوضح أن أيًّا منها لا يوقف تسجيل الشاشة.

ما يفعله أطلس:

- كل فيديو درس يُشاهَد في أكاديميتك تظهر عليه علامة فيها كود الطالب الشخصي وتتحرك على الصورة، ومعها نقشة خفيفة بنفس الكود على الفيديو كله. والعلامة تعمل دائمًا.
- العلامة تبقى في وضع ملء الشاشة.
- المشغّل ليس فيه زر تحميل، ويوقف الصورة داخل الصورة والبث إلى شاشة أخرى في المتصفحات التي تلتزم بهذا الإعداد.
- إذا أُخفيت العلامة أو أُزيلت داخل المتصفح، يتوقف التشغيل ويصل التنبيه إلى أطلس. الشخص المتحكّم في متصفحه يستطيع إزالتها رغم ذلك؛ أطلس يلاحظ ما حدث، لكنه لا يستطيع أن يجعله مستحيلًا.
- كل طالب يستخدم عددًا محدودًا من الأجهزة تحدده أنت، والدروس تعمل على جهاز واحد في المرة.

وحدّ أخير: الدروس على أطلس فيديوهات يوتيوب تُعرض داخل أكاديميتك. الطالب المصمّم يستطيع الوصول إلى لينك يوتيوب ومشاهدة الفيديو هناك، حيث لا توجد علامة مائية. القائمة الكاملة في [الأسئلة الشائعة عن حماية المحتوى](https://docs.atlass.dpdns.org/ar/faq/content-protection).

## أسئلة شائعة

**هل سيعرف الطلاب أن الكود موجود؟**
نعم، وهذا هو المقصود. الكود ظاهر عن عمد حتى يعرف الطالب أن أي تسجيل سيحمله.

**هل الكود الظاهر يبطّئ الفيديو؟**
الكود يُرسم فوق المشغّل أثناء تشغيل الفيديو. والطالب يشاهد الدرس كالمعتاد، والكود يتحرك فوقه.

**وماذا عن تصوير الشاشة بالموبايل؟**
لا شيء على الويب يستطيع منعه. لكن تصوير درس عليه كود ظاهر يلتقط الكود أيضًا، ما دام مقروءًا في النسخة.

## الخلاصة

- لا توجد صفحة ويب تستطيع منع تسجيل الشاشة أو تصويرها منعًا كاملًا.
- الإضافات وDRM تغطي بعض الحالات، فاشرحها بصدق إذا استخدمتها.
- كود المشاهد الظاهر وحدود الأجهزة وخطة التصرف تفيدك أكثر من أي وعد بـ«منع التسجيل».

تحب ترى ما يراه طلابك؟ [ابدأ تجربة أكاديميتك](/ar/pricing)، وأضف درس يوتيوب، واعرضه بنفسك لترى كود المشاهد يتحرك فوقه.
$atlasblog$,
   $atlasblog$رسم لموبايل على حامل صغير موجّه إلى لابتوب يعرض فيديو درس، وبجواره كتب وأقلام.$atlasblog$,
   $atlasblog$هل يمكن منع تصوير الشاشة في الدروس الأونلاين؟$atlasblog$,
   $atlasblog$لا توجد صفحة ويب تمنع تسجيل الشاشة أو تصويرها بالكاميرا تمامًا. ماذا يعني ذلك لدروسك المدفوعة، وما الإجراءات التي ما زالت تقلل المشاركة.$atlasblog$,
   4),
  ($atlasblog$5b2b0f14-bf04-5f81-869c-30f3d565432f$atlasblog$,
   $atlasblog$forensic-watermark-explained$atlasblog$,
   $atlasblog$cluster$atlasblog$::"platform_blog_post_kind",
   $atlasblog$protection$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-17T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-17T08:00:00Z$atlasblog$::timestamp,
   false,
   $atlasblog$/marketing-assets/blog/forensic-watermark-explained.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$9f9b6dcd-ebd3-5061-8e0f-e2e8d2d628db$atlasblog$,$atlasblog$d4375d4e-64a1-5988-955a-819100fa6442$atlasblog$,$atlasblog$5ae035f1-0fe2-50cb-ac85-689682b880a2$atlasblog$]::TEXT[],
   $atlasblog$What is a forensic watermark, and how does it trace a leaked copy?$atlasblog$,
   $atlasblog$A forensic watermark puts a viewer code on every lesson. Learn what that code can and cannot tell you, when tracing fails, and what students should be told.$atlasblog$,
   $atlasblog$A forensic watermark is a mark placed on a video so that a copy can be traced back to where it came from. For paid lessons, that usually means a code tied to the student watching, shown on every lesson they open. If a recording leaks and the code is still readable, the code points to the account and session that watched it. It does not stop anyone recording, and it does not tell you who was holding the phone.

## A forensic watermark in one paragraph

Every time a student plays a lesson, the platform shows a code that belongs to that student and that viewing session. A student who records the screen records the code too. Later, if the recording turns up on Telegram or YouTube, someone reads the code from the copy and looks it up in the platform's records. The answer is an account and a sign-in, which gives you something concrete to act on.

## Visible codes and invisible marks

There are two broad families of forensic watermark.

- **Visible codes** are drawn on top of the video where the viewer can see them. Their strength is deterrence: students see their own code and know a recording carries it. Their weakness is that a visible mark can be cropped, covered or blurred, so good designs move the code around and repeat it.
- **Invisible marks** are hidden in the video itself and need special tools to read. They are harder to remove but do nothing to discourage sharing, since the student never sees them, and they usually require the platform to process and host the video itself.

For a teacher, the useful question is simple: does the student know the mark is there? If the goal is to make fewer students share in the first place, a visible code does more of that work.

## What the code tells you, and what it does not

A code can tell you:

- which account the lesson was played on;
- which sign-in session it belonged to;
- which lesson it was shown on.

A code cannot tell you:

- who was physically watching or holding the camera;
- whether the account owner shared their password with someone else;
- where else the copy has been posted.

So if a code points to a student's account, the account was used to watch the lesson that leaked. That is a good reason for a private conversation, and often for ending that account's access. It is not proof of who pressed record.

## When tracing fails

Tracing only works when the code can be read in the copy. It can fail when:

- the copy is cropped so the code is cut out;
- the code is blurred or covered;
- the copy has been re-encoded at low quality;
- the lesson was copied in a way that skips your player entirely, so no code was ever drawn. This last case is easy to miss.

## Privacy: what is stored

To look up a code later, the platform keeps a record linking it to an account. That is personal data, so students deserve to know it exists, who can read it and how long it is kept.

## How this works in Atlas

Atlas draws a visible forensic watermark over every lesson video watched in your academy, including YouTube lessons.

- **What students see.** A label with their personal code and a masked hint of their account, which moves to a new spot every so often, plus a very faint, slowly drifting pattern of the same code across the whole picture. Covering the label still leaves the code in the recording.
- **Always on.** You cannot switch the watermark off, and it stays in full screen.
- **Fails closed.** If Atlas cannot issue a code, the video does not play.
- **Notices tampering.** If the watermark is hidden or removed in the browser, playback pauses and Atlas is notified. Someone who controls their own browser can still remove it; Atlas notices but cannot prevent it.
- **Who looks it up.** Only Atlas. You send the code you can read in a leaked copy to Atlas support in a ticket, and Atlas tells you which account and sign-in it was issued to.
- **What is kept.** Atlas keeps an encrypted record of each code, linked to the account, the sign-in and the lesson, for up to two years after the code was last shown. Students can read this under the video in "About the watermark". The record is kept even if the student later deletes their account, so a leak can still be traced.

The limits apply here too. The watermark is drawn by the browser over the video, not burned into the video file. And because lessons are YouTube videos, a student who copies a lesson's YouTube link can watch it on YouTube with no watermark, and that copy cannot be traced. Details are in [The forensic watermark explained](https://docs.atlass.dpdns.org/protection/forensic-watermark).

## Common questions

**Can I look up a code myself?**
Not in Atlas. Only the Atlas team can look codes up. Open a support ticket with the code and a screenshot of a frame where it is clear.

**Does the code show the student's name?**
No. It shows a personal code and a masked hint of the account, such as the first letter of the email. The full link between code and student stays in Atlas's encrypted records.

**What if the student blurs the code?**
Then the copy may not be traceable. The faint pattern across the picture makes this harder, but a heavily cropped, blurred or low-quality copy can still hide it.

## Key takeaways

- A forensic watermark traces a copy to an account and session, not to a person.
- Visible codes deter sharing; invisible marks do not.
- Tracing needs a readable code in the copy.
- Tell students what is recorded and for how long.

For the wider plan, read [how to protect paid courses from leaks](/blog/how-to-protect-paid-courses-from-leaks), and keep [the response plan for a leaked course](/blog/course-leaked-on-telegram-response-plan) bookmarked. To see the code on your own lesson, [start an academy trial](/pricing) and preview a YouTube lesson.
$atlasblog$,
   $atlasblog$Illustration of a video frame with a gold tag floating over the picture and a magnifying glass examining it.$atlasblog$,
   $atlasblog$What is a forensic watermark? How it traces leaked lessons$atlasblog$,
   $atlasblog$A forensic watermark puts a viewer code on every lesson. Learn what that code reveals, when tracing fails, and who can look it up.$atlasblog$,
   5,
   $atlasblog$ما هي العلامة المائية للتتبّع؟ وكيف تكشف مصدر النسخة المسرّبة$atlasblog$,
   $atlasblog$العلامة المائية للتتبّع تضع كود المشاهد على كل درس. اعرف ما يستطيع الكود أن يخبرك به وما لا يستطيع، ومتى يفشل التتبّع، وماذا يجب أن يعرف الطلاب.$atlasblog$,
   $atlasblog$العلامة المائية للتتبّع علامة توضع على الفيديو حتى يمكن تتبّع أي نسخة منه إلى مصدرها. في الدروس المدفوعة يعني ذلك غالبًا كودًا مرتبطًا بالطالب الذي يشاهد، يظهر على كل درس يفتحه. فإذا تسرّب تسجيل وكان الكود ما زال مقروءًا، يوصلك الكود إلى الحساب وجلسة الدخول التي شوهد منها الدرس. لكنها لا تمنع أحدًا من التسجيل، ولا تخبرك من الذي كان يمسك الموبايل.

## العلامة المائية للتتبّع في فقرة واحدة

في كل مرة يشغّل فيها الطالب درسًا، تعرض المنصة كودًا خاصًا بهذا الطالب وبجلسة المشاهدة هذه. الطالب الذي يسجّل الشاشة يسجّل الكود معها. وإذا ظهر التسجيل لاحقًا على تليجرام أو يوتيوب، يقرأ أحدهم الكود من النسخة ويبحث عنه في سجلات المنصة. والنتيجة حساب وجلسة دخول، أي شيء محدد تستطيع أن تتصرف بناءً عليه.

## الكود الظاهر والعلامة المخفية

هناك نوعان رئيسيان من العلامات المائية للتتبّع:

- **الكود الظاهر** يُرسم فوق الفيديو حيث يراه المشاهد. قوته في الردع: الطالب يرى كوده ويعرف أن أي تسجيل سيحمله. ونقطة ضعفه أن العلامة الظاهرة يمكن قصّها أو تغطيتها أو تمويهها، ولذلك تحرّك التصميمات الجيدة الكود من مكان لآخر وتكرره.
- **العلامة المخفية** توضع داخل الفيديو نفسه، وتحتاج أدوات خاصة لقراءتها. إزالتها أصعب، لكنها لا تقلل الرغبة في المشاركة لأن الطالب لا يراها أصلًا، وتتطلب غالبًا أن تعالج المنصة الفيديو وتستضيفه بنفسها.

بالنسبة للمدرس، السؤال المفيد بسيط: هل يعرف الطالب أن العلامة موجودة؟ إذا كان هدفك أن يقل عدد من يشارك من الأساس، فالكود الظاهر يؤدي هذا الدور أكثر.

## ماذا يخبرك الكود، وماذا لا يخبرك

الكود يستطيع أن يخبرك:

- على أي حساب شوهد الدرس؛
- إلى أي جلسة دخول ينتمي؛
- على أي درس ظهر.

ولا يستطيع أن يخبرك:

- من الذي كان يشاهد فعليًا أو يمسك الكاميرا؛
- هل شارك صاحب الحساب كلمة السر مع غيره؛
- أين نُشرت النسخة في أماكن أخرى.

هذا مهم حين تقرر ما ستفعله. إذا أشار الكود إلى حساب طالب، فهذا يعني أن الحساب استُخدم لمشاهدة الدرس الذي تسرّب. وهذا سبب وجيه لكلام هادئ على انفراد، وغالبًا لإنهاء وصول هذا الحساب. لكنه ليس دليلًا على من ضغط زر التسجيل.

## متى يفشل التتبّع؟

التتبّع ينجح فقط إذا كان الكود مقروءًا في النسخة. وقد يفشل حين:

- تُقص النسخة بحيث يخرج الكود من الإطار؛
- يُموَّه الكود أو يُغطّى؛
- يُعاد ضغط النسخة بجودة منخفضة؛
- يُنسخ الدرس بطريقة تتجاوز مشغّلك تمامًا، فلا يُرسم أي كود من الأساس. وهذه الحالة الأخيرة سهل أن تغيب عنك.

## الخصوصية: ماذا يُحفظ؟

حتى يمكن البحث عن الكود لاحقًا، يجب أن تحتفظ المنصة بسجل يربطه بحساب. وهذا السجل بيانات شخصية، فمن حق الطالب أن يعرف أنه موجود، ومن يستطيع قراءته، وكم يُحتفظ به. والإعداد العادل يخبر الطالب بالثلاثة بكلمات واضحة بجوار الفيديو.

## كيف يعمل هذا في أطلس

يرسم أطلس علامة مائية تتبّعية ظاهرة فوق كل فيديو درس يُشاهَد في أكاديميتك، ومنها دروس يوتيوب.

- **ما يراه الطالب.** علامة فيها كوده الشخصي وجزء مخفي من حسابه، تنتقل إلى مكان جديد كل فترة، ومعها نقشة خفيفة جدًا بنفس الكود تتحرك ببطء على الصورة كلها. فتغطية العلامة تترك الكود في التسجيل رغم ذلك.
- **تعمل دائمًا.** لا تستطيع إيقاف العلامة، وهي تبقى في وضع ملء الشاشة.
- **لا تشغيل بدون كود.** إذا لم يستطع أطلس إصدار كود، لا يعمل الفيديو.
- **يلاحظ العبث.** إذا أُخفيت العلامة أو أُزيلت داخل المتصفح، يتوقف التشغيل ويصل التنبيه إلى أطلس. الشخص المتحكّم في متصفحه يستطيع إزالتها رغم ذلك؛ أطلس يلاحظ، لكنه لا يستطيع منع ذلك.
- **من يبحث عن الكود.** أطلس فقط. ترسل الكود الذي تقرؤه في النسخة المسرّبة إلى دعم أطلس في تذكرة، فيخبرك أطلس بالحساب وجلسة الدخول اللذين صدر لهما.
- **ما يُحفظ.** يحتفظ أطلس بسجل مشفّر لكل كود، مرتبط بالحساب وجلسة الدخول والدرس، لمدة تصل إلى سنتين بعد آخر مرة ظهر فيها الكود. ويستطيع الطالب قراءة ذلك تحت الفيديو في «عن العلامة المائية». ويبقى السجل حتى لو حذف الطالب حسابه لاحقًا، حتى يظل التتبّع ممكنًا.

والحدود تنطبق هنا أيضًا. العلامة يرسمها المتصفح فوق الفيديو، وليست محفورة داخل ملف الفيديو. ولأن الدروس فيديوهات يوتيوب، فالطالب الذي ينسخ لينك يوتيوب الخاص بالدرس يستطيع مشاهدته على يوتيوب بلا علامة، وهذه النسخة لا يمكن تتبّعها. التفاصيل في [شرح العلامة المائية التتبّعية](https://docs.atlass.dpdns.org/ar/protection/forensic-watermark).

## أسئلة شائعة

**هل أستطيع البحث عن الكود بنفسي؟**
ليس داخل أطلس. فريق أطلس وحده يستطيع البحث عن الأكواد. افتح تذكرة دعم فيها الكود وصورة من لقطة يظهر فيها بوضوح.

**هل يظهر اسم الطالب في الكود؟**
لا. يظهر كود شخصي وجزء مخفي من الحساب، مثل أول حرف من البريد الإلكتروني. أما الربط الكامل بين الكود والطالب فيبقى في سجلات أطلس المشفّرة.

**وماذا لو موّه الطالب الكود؟**
قد لا يمكن تتبّع النسخة حينها. النقشة الخفيفة على الصورة تجعل ذلك أصعب، لكن النسخة المقصوصة بشدة أو المموّهة أو الرديئة الجودة قد تخفي الكود رغم ذلك.

## الخلاصة

- العلامة المائية للتتبّع توصلك إلى حساب وجلسة، وليس إلى شخص.
- الكود الظاهر يردع المشاركة، والعلامة المخفية لا تفعل ذلك.
- التتبّع يحتاج كودًا مقروءًا في النسخة.
- أخبر طلابك بما يُسجَّل وكم يُحتفظ به.

للخطة الأشمل اقرأ [كيف تحمي الكورسات المدفوعة من التسريب](/ar/blog/how-to-protect-paid-courses-from-leaks)، واحتفظ بـ[خطة التصرف لو كورسك اتسرّب](/ar/blog/course-leaked-on-telegram-response-plan). ولترى الكود على درسك أنت، [ابدأ تجربة أكاديميتك](/ar/pricing) واعرض درس يوتيوب.
$atlasblog$,
   $atlasblog$رسم لإطار فيديو تطفو فوقه علامة ذهبية وعدسة مكبرة تفحصها.$atlasblog$,
   $atlasblog$ما هي العلامة المائية للتتبّع؟ وكيف تكشف مصدر التسريب$atlasblog$,
   $atlasblog$العلامة المائية للتتبّع تضع كود المشاهد على كل درس. اعرف ماذا يكشف الكود، ومتى لا ينجح التتبّع، ومن يستطيع البحث عنه، وماذا يُحفظ.$atlasblog$,
   4),
  ($atlasblog$d4375d4e-64a1-5988-955a-819100fa6442$atlasblog$,
   $atlasblog$course-leaked-on-telegram-response-plan$atlasblog$,
   $atlasblog$cluster$atlasblog$::"platform_blog_post_kind",
   $atlasblog$protection$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-19T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-19T08:00:00Z$atlasblog$::timestamp,
   false,
   $atlasblog$/marketing-assets/blog/course-leaked-on-telegram-response-plan.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$9f9b6dcd-ebd3-5061-8e0f-e2e8d2d628db$atlasblog$,$atlasblog$5b2b0f14-bf04-5f81-869c-30f3d565432f$atlasblog$,$atlasblog$5ae035f1-0fe2-50cb-ac85-689682b880a2$atlasblog$]::TEXT[],
   $atlasblog$Your course leaked on Telegram: a step-by-step response plan$atlasblog$,
   $atlasblog$What to do in the first hours after a paid course leaks: save the evidence, read the viewer code, ask for a trace, decide on the account and report the copy.$atlasblog$,
   $atlasblog$Finding your paid lessons on a Telegram channel is upsetting, and the first instinct is often to post about it or message the student you suspect. Both can make things worse. A calm plan in a fixed order protects you, keeps you fair to students, and gives you the best chance of finding the account the copy came from. A viewer code on your lessons makes several steps much easier.

## Step 1: Save the evidence first

Before anything is deleted or changed, record what you found:

- the link to the channel or post, and the channel name;
- the date and time you found it;
- screenshots of the post and of a few video frames, especially frames where any code on the video is clearest;
- which of your lessons it is, and roughly when that lesson was published.

Keep these in one folder. Do not contact the student you suspect yet, and do not post publicly about the leak. Your next steps should rest on facts.

## Step 2: Look for the viewer code in the copy

If your lessons show a personal code on the video, look for it in the leaked copy. Pause on frames where it is sharp, and write it down exactly as you see it. If the code moves around the picture, check several frames and compare.

If there is no readable code, the copy may have been cropped, blurred or recorded at low quality, or it came from a route that skips your player. Note that too.

## Step 3: Ask for a trace

A code on its own means nothing until someone matches it to an account. Whoever runs your platform holds those records. Send them the code, the lesson, where and when you found the copy, and a screenshot of a frame that shows the code. Ask which account and session the code was issued to.

## Step 4: Decide what happens to the account

Once you know the account, decide what to do with it. Common choices are to end that student's access to the course, or to block them from your academy. Whatever you choose:

- Talk to the student privately. If the student is a minor, involve a parent.
- Keep your response proportionate and consistent with the rules you told students before they paid.
- Never name or shame a student in public, in a group, or on social media. Apart from being unfair if you are wrong, it can expose you to legal trouble.

Remember that the code points to an account, not a person. A student who lent their login may not be the one who recorded.

## Step 5: Report the copy to the platform

Telegram, YouTube and most other platforms have their own process for reporting material that infringes copyright. Use the official reporting route on the platform where the copy appears, and attach the evidence you saved in step 1. Check the platform's current help pages for the exact steps, since they change. A report can remove the copy you found; it will not remove copies elsewhere.

## Step 6: Tell your other students what they need to know

You do not owe anyone details about who was involved. A short, calm message is enough: lessons are for enrolled students only, copies are being reported, and the course rules still apply.

## What a trace cannot prove

Be clear with yourself about the limits before you act:

- A code identifies an account and a session, not who held the camera.
- If the code is not readable, there may be no trace at all.
- A trace does not remove the copy from the site where it was posted.

## Reduce the next leak

Once things are calm, review your setup. Our pillar guide on [how to protect paid courses from leaks](/blog/how-to-protect-paid-courses-from-leaks) walks through each measure, and [the forensic watermark guide](/blog/forensic-watermark-explained) explains what codes can and cannot do.

## How this works in Atlas

- **Read the code.** Every lesson video watched in an Atlas academy shows the viewer's personal code, moving around the picture, with a faint pattern of the same code across the whole video.
- **Ask Atlas to trace it.** In your dashboard, open **Support**, choose **New ticket**, give the code, the course, and where and when you found the copy, and attach a screenshot of a frame with the code. Atlas looks the code up and replies in the ticket with the account and sign-in it was issued to. Only Atlas can look codes up, and Atlas does not promise a response time.
- **Act in your academy.** You can block the student or end their enrollment. Those actions apply to your academy only.
- **Check sharing signals.** The Sharing signals report shows whether the same account was refused repeatedly for the device limit or another active session.

The limits: a copy with no readable code cannot be traced; a copy made from a lesson's YouTube link carries no watermark; code records are kept up to two years after the code was last shown; and reporting the copy to Telegram or YouTube happens outside Atlas. The full steps are in [If your content leaks](https://docs.atlass.dpdns.org/protection/leak-response).

## Common questions

**Can I sue the person who leaked my course?**
That is a legal question, and the answer depends on your situation. Speak to a lawyer before you take any legal step or make any public accusation.

**Should I message the student straight away?**
Not before you have the evidence and the trace. Then talk to them privately, and to a parent if the student is a minor.

## Your first-hour checklist

1. Save links, dates and screenshots.
2. Read and write down the code.
3. Ask for a trace with the code and a screenshot.
4. Decide on the account, privately and proportionately.
5. Report the copy on the platform.
6. Send a short note to your other students.

If you want to talk through how this would work in your academy before you need it, [contact the Atlas team](/contact?topic=sales).
$atlasblog$,
   $atlasblog$Illustration of a clipboard with an empty checklist, a phone showing a speech bubble, an alarm clock and a folder of saved images.$atlasblog$,
   $atlasblog$Course leaked on Telegram? A step-by-step response plan$atlasblog$,
   $atlasblog$What to do in the first hours after a paid course leaks: save the evidence, check the viewer code, ask for a trace and report the copy.$atlasblog$,
   5,
   $atlasblog$كورسك اتسرّب على تليجرام؟ خطة تتحرك بها خطوة بخطوة$atlasblog$,
   $atlasblog$ماذا تفعل في الساعات الأولى بعد تسريب كورس مدفوع: احفظ الدليل، واقرأ كود المشاهد، واطلب التتبّع، وقرر بشأن الحساب، وبلّغ عن النسخة.$atlasblog$,
   $atlasblog$أن تجد دروسك المدفوعة على قناة تليجرام أمر مزعج، وأول رد فعل عند كثيرين أن ينشروا عن الموضوع أو يراسلوا الطالب الذي يشكّون فيه. والاثنان قد يزيدان الأمر سوءًا. الخطة الهادئة بترتيب ثابت تحميك، وتجعلك عادلًا مع طلابك، وتعطيك أفضل فرصة للوصول إلى الحساب الذي خرجت منه النسخة. ووجود كود للمشاهد على دروسك يسهّل عدة خطوات كثيرًا.

## الخطوة الأولى: احفظ الدليل قبل أي شيء

قبل أن يُحذف أي شيء أو يتغيّر، سجّل ما وجدته:

- لينك القناة أو المنشور، واسم القناة؛
- تاريخ ووقت عثورك عليه؛
- صورًا للمنشور ولعدة لقطات من الفيديو، خاصة اللقطات التي يظهر فيها أي كود على الفيديو بأوضح شكل؛
- أي درس من دروسك هو، وتقريبًا متى نُشر.

ضع كل ذلك في مجلد واحد. ولا تتواصل مع الطالب الذي تشك فيه بعد، ولا تنشر شيئًا علنًا عن التسريب. خطواتك التالية يجب أن تقوم على وقائع.

## الخطوة الثانية: ابحث عن كود المشاهد في النسخة

إذا كان على دروسك كود شخصي يظهر على الفيديو، فابحث عنه في النسخة المسرّبة. أوقف الفيديو عند لقطات يكون فيها واضحًا، واكتبه كما تراه بالضبط. وإذا كان الكود يتحرك على الصورة، فراجع أكثر من لقطة وقارن بينها.

إذا لم تجد كودًا مقروءًا، فربما قُصّت النسخة أو مُوّهت أو سُجّلت بجودة منخفضة، وربما خرجت من طريق يتجاوز مشغّلك تمامًا. سجّل ذلك أيضًا، فهو يخبرك بشيء عن الطريقة التي خرج بها الدرس.

## الخطوة الثالثة: اطلب التتبّع

الكود وحده لا يعني شيئًا حتى يطابقه أحد بحساب. والجهة التي تشغّل منصتك هي التي تملك هذه السجلات. أرسل لها الكود، واسم الدرس، وأين ومتى وجدت النسخة، وصورة للقطة يظهر فيها الكود، واسأل: لأي حساب وأي جلسة صدر هذا الكود؟

## الخطوة الرابعة: قرّر ماذا يحدث للحساب

حين تعرف الحساب، قرّر ماذا تفعل به. الخيارات المعتادة أن تنهي وصول الطالب إلى الكورس، أو تحظره من أكاديميتك. وأيًّا كان قرارك:

- تكلّم مع الطالب على انفراد. وإذا كان الطالب قاصرًا، فأشرك ولي أمره.
- اجعل ردّك متناسبًا ومتسقًا مع القواعد التي أخبرت بها الطلاب قبل أن يدفعوا.
- لا تذكر اسم طالب أو تفضحه علنًا، لا في جروب ولا على وسائل التواصل. فإلى جانب أن ذلك ظلم إن كنت مخطئًا، قد يعرّضك لمشاكل قانونية.

وتذكّر أن الكود يشير إلى حساب، وليس إلى شخص. الطالب الذي أعار حسابه قد لا يكون هو من سجّل.

## الخطوة الخامسة: بلّغ المنصة عن النسخة

تليجرام ويوتيوب وأغلب المنصات الأخرى لديها طريقة خاصة للإبلاغ عن المحتوى الذي ينتهك حقوق النشر. استخدم طريق الإبلاغ الرسمي في المنصة التي ظهرت عليها النسخة، وأرفق الدليل الذي حفظته في الخطوة الأولى. وراجع صفحات المساعدة الحالية في المنصة لتعرف الخطوات بالضبط، لأنها تتغير. البلاغ قد يحذف النسخة التي وجدتها، لكنه لن يحذف النسخ في أماكن أخرى.

## الخطوة السادسة: أخبر باقي طلابك بما يلزم

لست مطالبًا بإعطاء أحد تفاصيل عمّن تورّط. تكفي رسالة قصيرة وهادئة: الدروس للطلاب المشتركين فقط، والنسخ يجري الإبلاغ عنها، وقواعد الكورس ما زالت سارية.

## ما الذي لا يثبته التتبّع

كن واضحًا مع نفسك بشأن الحدود قبل أن تتصرف:

- الكود يحدد حسابًا وجلسة، ولا يحدد من كان يمسك الكاميرا.
- إذا لم يكن الكود مقروءًا، فقد لا يوجد تتبّع أصلًا.
- التتبّع لا يحذف النسخة من الموقع الذي نُشرت عليه.

## قلّل التسريب القادم

بعد أن تهدأ الأمور، راجع إعداداتك. دليلنا الرئيسي عن [حماية الكورسات المدفوعة من التسريب](/ar/blog/how-to-protect-paid-courses-from-leaks) يمرّ على كل إجراء، و[دليل العلامة المائية للتتبّع](/ar/blog/forensic-watermark-explained) يشرح ما تستطيعه الأكواد وما لا تستطيعه.

## كيف يعمل هذا في أطلس

- **اقرأ الكود.** كل فيديو درس يُشاهَد في أكاديمية على أطلس يظهر عليه كود المشاهد الشخصي متحركًا على الصورة، ومعه نقشة خفيفة بنفس الكود على الفيديو كله.
- **اطلب من أطلس تتبّعه.** من لوحة التحكم افتح **الدعم**، واضغط **تذكرة جديدة**، واكتب الكود والكورس وأين ومتى وجدت النسخة، وأرفق صورة للقطة فيها الكود. يبحث أطلس عن الكود ويرد عليك في نفس التذكرة بالحساب وجلسة الدخول اللذين صدر لهما. أطلس وحده يستطيع البحث عن الأكواد، ولا يلتزم بوقت محدد للرد.
- **تصرّف داخل أكاديميتك.** تستطيع حظر الطالب أو إنهاء اشتراكه في الكورس. وهذه الإجراءات تنطبق على أكاديميتك فقط.
- **راجع مؤشرات المشاركة.** تقرير مؤشرات المشاركة يوضح هل رُفض فتح الدروس لنفس الحساب مرارًا بسبب حد الأجهزة أو وجود جلسة أخرى.

والحدود: النسخة التي ليس فيها كود مقروء لا يمكن تتبّعها؛ والنسخة المأخوذة من لينك يوتيوب الخاص بالدرس لا تحمل علامة مائية؛ وسجلات الأكواد تُحفظ حتى سنتين بعد آخر ظهور للكود؛ والإبلاغ عن النسخة لتليجرام أو يوتيوب يتم خارج أطلس. الخطوات الكاملة في [لو المحتوى بتاعك اتسرّب](https://docs.atlass.dpdns.org/ar/protection/leak-response).

## أسئلة شائعة

**هل أستطيع مقاضاة من سرّب الكورس؟**
هذا سؤال قانوني، وإجابته تعتمد على حالتك. استشر محاميًا قبل أي خطوة قانونية أو أي اتهام علني.

**هل أراسل الطالب فورًا؟**
ليس قبل أن يكون معك الدليل ونتيجة التتبّع. بعدها تكلّم معه على انفراد، ومع ولي أمره إذا كان قاصرًا.

## قائمة الساعة الأولى

1. احفظ اللينكات والتواريخ والصور.
2. اقرأ الكود واكتبه.
3. اطلب التتبّع بالكود وصورة اللقطة.
4. قرّر بشأن الحساب على انفراد وبشكل متناسب.
5. بلّغ المنصة عن النسخة.
6. أرسل رسالة قصيرة لباقي طلابك.

لو تحب أن تعرف كيف سيعمل هذا في أكاديميتك قبل أن تحتاجه، [تواصل مع فريق أطلس](/ar/contact?topic=sales).
$atlasblog$,
   $atlasblog$رسم للوحة كتابة عليها قائمة مهام فارغة، وموبايل عليه فقاعة محادثة، ومنبه، وملف فيه صور محفوظة.$atlasblog$,
   $atlasblog$كورسك اتسرّب على تليجرام؟ خطة خطوة بخطوة$atlasblog$,
   $atlasblog$ماذا تفعل في الساعات الأولى بعد تسريب كورس مدفوع: احفظ الدليل، وابحث عن كود المشاهد، واطلب التتبّع، وبلّغ المنصة عن النسخة المسرّبة.$atlasblog$,
   4),
  ($atlasblog$5071618b-4156-5c3d-ad06-11a8275e2ca2$atlasblog$,
   $atlasblog$from-whatsapp-screenshots-to-approval-queue$atlasblog$,
   $atlasblog$cluster$atlasblog$::"platform_blog_post_kind",
   $atlasblog$payments$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-21T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-21T08:00:00Z$atlasblog$::timestamp,
   false,
   $atlasblog$/marketing-assets/blog/from-whatsapp-screenshots-to-approval-queue.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$49f7ec27-733e-58c9-8881-ca5fd039d9d0$atlasblog$,$atlasblog$3e427114-ca5b-590b-8fe3-b23f85784955$atlasblog$,$atlasblog$75b60022-36b1-5589-b77d-090bb07fbb39$atlasblog$]::TEXT[],
   $atlasblog$From WhatsApp screenshots to an approval queue: verifying student payments$atlasblog$,
   $atlasblog$Five checks for every wallet or InstaPay proof, how to reject one with a clear reason, and how to make a single approval open the course.$atlasblog$,
   $atlasblog$Many teachers start the season the same way: a wallet number in the group description, and a phone that fills with transfer screenshots. Checking each one by scrolling through WhatsApp is slow, and it is easy to approve the wrong student or the same image twice. A short, fixed check for every proof, done in one place, makes verification faster and fairer.

## Five checks for every transfer proof

For each payment proof, check these five things before you open access:

1. **Amount.** Does it match the course price exactly?
2. **Reference.** Does the transfer note or reference match what you asked the student to write?
3. **Time.** Was it sent recently, and after the student started the purchase?
4. **Sender.** Does the sending number, name or InstaPay address make sense for this student or their family?
5. **Duplicate image.** Have you seen this exact screenshot before, for another student or another month?

Then do the step that matters most: open your own wallet, bank or InstaPay app and find the money. The five checks tell you what to look for. Your own app tells you whether it arrived.

## Match the proof to the student

The hardest part of verification is usually knowing who paid. Parents, siblings and friends often send money on a student's behalf, so the sender's name is rarely enough. Two habits help:

- Ask every student to write a fixed reference in the transfer, such as their phone number or a short code you give them.
- Keep the student's own phone number on record, so you can match it with the sender or the reference.

If you still cannot match a payment, ask the student for the transfer reference before you approve.

## Duplicate or edited images: confirm in your own app

A screenshot is a picture, and pictures can be reused or edited. You do not need to become an expert in spotting edits. You only need one rule: never approve on the image alone. If the money is in your account with the right amount, reference and time, approve. If it is not there yet, wait or ask.

## Reject with a reason the student understands

Some proofs will not match. A clear, kind reason saves a round of messages. A few lines you can adapt:

- "The amount received is different from the course price. Please send the remaining amount and upload the new proof."
- "We could not find this transfer in our account yet. Please check the reference and send it again."
- "This screenshot was already used for another payment. Please upload the proof for this transfer."

Keep the tone neutral. Most mismatches are honest mistakes, and many proofs are sent by parents doing their best.

## Approve once, then access

The point of verification is a single moment: the payment is confirmed and the student gets the course. If approval and access are two separate jobs, for example approving in one place and adding the student to a group somewhere else, one of them will eventually be forgotten. Tie them together so one approval opens the course.

## Who approves: keep it to one person

Money decisions work best with one owner. If several people approve payments, nobody is sure who checked what, and mistakes are hard to trace. Assistants can help with questions and reminders, but the approval itself should stay with one person who can see the account the money goes into.

## How this works in Atlas

- **Students upload the proof in your academy.** At checkout the student pays with one of your methods (bank transfer, e-wallet or InstaPay), then uploads a screenshot or receipt with the transfer reference and a note if they like.
- **One queue.** You get an email and a notification for each proof. In **Student payments**, the **Waiting for review** tab lists every proof, with search, a method filter and sorting.
- **Everything on one panel.** Open a payment to see the proof, the reference, the student's note and the details the student was shown at checkout, so you can compare them with your own app.
- **Approve to enrol.** Choose **Approve** and confirm. The student is enrolled in the course straight away and emailed.
- **Reject with a reason.** Choose **Reject…** and write a reason. The student sees it, gets it by email, and can send a new payment for the same order.
- **One decision per payment.** A student can have only one payment waiting on an order, so they cannot pay twice by mistake, and **Review history** shows who decided and when.
- **Owner only.** Only the organization owner can review payments. Managers and instructors do not see these pages.

Atlas does not check your bank or wallet. Approving is your confirmation that the money arrived. Full steps are in [Review payment proofs and approve enrollments](https://docs.atlass.dpdns.org/selling/review-payments).

## Common questions

**Can my assistant approve payments?**
In Atlas, no. Only the organization owner can review payments. Assistants can help students with questions in the meantime.

**How fast should I approve?**
Set your own promise and tell students, for example "within one working day". Nothing is approved automatically, so a clear promise prevents anxious messages.

**What if a student says they paid but I cannot see it?**
Ask for the transfer reference and the exact time, then check your app again. Do not approve until you see the money.

## Key takeaways

- Check amount, reference, time, sender and duplicates on every proof.
- Confirm in your own app before approving.
- Reject with a clear, kind reason.
- Let one person approve, and let one approval open the course.

For the bigger picture on wallets, InstaPay and bank transfer, read [collecting course payments in Egypt](/blog/collecting-course-payments-in-egypt). To try the queue yourself, [start an academy trial](/pricing) and make a test purchase on your own academy.
$atlasblog$,
   $atlasblog$Illustration of a messy pile of image cards turning into a tidy column of cards with gold check marks, beside a laptop and a phone.$atlasblog$,
   $atlasblog$Verifying student payments: from screenshots to approvals$atlasblog$,
   $atlasblog$Five checks for every wallet or InstaPay proof, how to reject one with a clear reason, and how one approval can enrol the student.$atlasblog$,
   5,
   $atlasblog$من سكرينات الواتساب إلى قائمة موافقات: كيف تراجع مدفوعات طلابك$atlasblog$,
   $atlasblog$خمس نقاط تراجعها في كل إثبات دفع بالمحفظة أو إنستاباي، وكيف ترفض إثباتًا بسبب واضح، وكيف تجعل موافقة واحدة تفتح الكورس للطالب.$atlasblog$,
   $atlasblog$كثير من المدرسين يبدأون الموسم بنفس الطريقة: رقم محفظة في وصف الجروب، وموبايل يمتلئ بسكرينات التحويل. ومراجعة كل سكرين بالتنقل في واتساب عمل بطيء، ومن السهل أن توافق للطالب الخطأ أو على نفس الصورة مرتين. مراجعة قصيرة وثابتة لكل إثبات، في مكان واحد، تجعل التأكد أسرع وأعدل.

## خمس نقاط تراجعها في كل إثبات تحويل

قبل أن تفتح الوصول للدروس، راجع هذه النقاط الخمس في كل إثبات دفع:

1. **المبلغ.** هل يطابق سعر الكورس بالضبط؟
2. **المرجع.** هل ملاحظة التحويل أو المرجع تطابق ما طلبت من الطالب أن يكتبه؟
3. **الوقت.** هل أُرسل التحويل حديثًا، وبعد أن بدأ الطالب عملية الشراء؟
4. **المرسل.** هل رقم المرسل أو اسمه أو عنوان إنستاباي منطقي بالنسبة لهذا الطالب أو أسرته؟
5. **الصورة المكررة.** هل رأيت نفس السكرين من قبل، لطالب آخر أو لشهر آخر؟

ثم الخطوة الأهم: افتح تطبيق المحفظة أو البنك أو إنستاباي الخاص بك وابحث عن المبلغ. النقاط الخمس تقول لك عمّا تبحث، وتطبيقك أنت يقول لك هل وصلت الفلوس.

## طابق الإثبات بالطالب

أصعب ما في المراجعة عادةً هو معرفة من الذي دفع. أولياء الأمور والإخوة والأصدقاء يحوّلون كثيرًا نيابة عن الطالب، لذلك نادرًا ما يكفي اسم المرسل. عادتان تساعدانك:

- اطلب من كل طالب أن يكتب مرجعًا ثابتًا في التحويل، مثل رقم موبايله أو كود قصير تعطيه له.
- احتفظ برقم موبايل الطالب نفسه، حتى تطابقه بالمرسل أو بالمرجع.

وإذا لم تستطع مطابقة دفعة، فاطلب من الطالب مرجع التحويل قبل أن توافق.

## الصور المكررة أو المعدّلة: تأكد من تطبيقك

السكرين صورة، والصور يمكن إعادة استخدامها أو تعديلها. لست بحاجة لأن تصبح خبيرًا في كشف التعديل. تحتاج قاعدة واحدة فقط: لا توافق على الصورة وحدها أبدًا. إذا كانت الفلوس في حسابك بالمبلغ والمرجع والوقت الصحيح، وافق. وإذا لم تصل بعد، انتظر أو اسأل.

## ارفض بسبب يفهمه الطالب

بعض الإثباتات لن تتطابق. والسبب الواضح اللطيف يوفّر عليك جولة رسائل. بعض الجمل التي تستطيع تعديلها:

- «المبلغ الذي وصلنا مختلف عن سعر الكورس. من فضلك أرسل المبلغ المتبقي وارفع الإثبات الجديد.»
- «لم نجد هذا التحويل في حسابنا حتى الآن. من فضلك راجع المرجع وأرسله مرة أخرى.»
- «هذا السكرين استُخدم من قبل لدفعة أخرى. من فضلك ارفع إثبات هذا التحويل.»

حافظ على نبرة محايدة. أغلب الأخطاء غير مقصودة، وكثير من الإثباتات يرسلها أولياء أمور يبذلون جهدهم.

## وافق مرة واحدة، ثم يُفتح الوصول

الهدف من المراجعة لحظة واحدة: تأكيد الدفعة، فيحصل الطالب على الكورس. إذا كانت الموافقة وفتح الوصول عمليتين منفصلتين، مثل أن توافق في مكان ثم تضيف الطالب إلى جروب في مكان آخر، فستُنسى إحداهما في يوم ما. اربط بينهما حتى تفتح موافقة واحدة الكورس.

## من يوافق؟ اجعلها مسؤولية شخص واحد

قرارات الفلوس تنجح أكثر حين يملكها شخص واحد. إذا كان أكثر من شخص يوافق على المدفوعات، فلا أحد متأكد من الذي راجع ماذا، ويصعب تتبّع الأخطاء. المساعدون يستطيعون الرد على الأسئلة والتذكير، لكن الموافقة نفسها تبقى مع شخص واحد يستطيع رؤية الحساب الذي تصل إليه الفلوس.

## كيف يعمل هذا في أطلس

- **الطلاب يرفعون الإثبات داخل أكاديميتك.** عند الشراء يدفع الطالب بإحدى طرقك (تحويل بنكي أو محفظة إلكترونية أو إنستاباي)، ثم يرفع سكرين شوت أو إيصالًا، ومعه مرجع التحويل وملاحظة إن أراد.
- **قائمة واحدة.** يصلك بريد وإشعار مع كل إثبات. وفي **مدفوعات الطلاب** يعرض تبويب **بانتظار المراجعة** كل الإثباتات، مع البحث وفلتر طريقة الدفع والترتيب.
- **كل شيء في لوحة واحدة.** افتح الدفعة لترى الإثبات والمرجع وملاحظة الطالب والبيانات التي ظهرت له عند الشراء، فتقارنها بتطبيقك.
- **وافق فيُسجَّل.** اضغط **موافقة** وأكّد. يُسجَّل الطالب في الكورس مباشرة ويصله بريد.
- **ارفض مع السبب.** اضغط **رفض…** واكتب السبب. يراه الطالب ويصله بالبريد، ويستطيع إرسال دفعة جديدة لنفس الطلب.
- **قرار واحد لكل دفعة.** لا يمكن أن تكون للطالب أكثر من دفعة تنتظر المراجعة على نفس الطلب، فلا يدفع مرتين بالخطأ، و**سجل المراجعة** يوضح من قرر ومتى.
- **لصاحب الحساب فقط.** صاحب الحساب وحده يراجع المدفوعات. المديرون والمدرّسون لا يرون هذه الصفحات.

أطلس لا يراجع بنكك أو محفظتك. موافقتك تعني أنك تأكدت من وصول الفلوس. الخطوات الكاملة في [مراجعة إثباتات الدفع والموافقة على التسجيل](https://docs.atlass.dpdns.org/ar/selling/review-payments).

## أسئلة شائعة

**هل يستطيع مساعدي الموافقة على المدفوعات؟**
في أطلس، لا. صاحب الحساب وحده يراجع المدفوعات. والمساعدون يستطيعون الرد على أسئلة الطلاب في الأثناء.

**ما السرعة المناسبة للموافقة؟**
حدد وعدك وأخبر به الطلاب، مثلًا «خلال يوم عمل». لا شيء يُوافَق عليه تلقائيًا، والوعد الواضح يمنع رسائل القلق.

**وماذا لو قال الطالب إنه دفع ولم أجد المبلغ؟**
اطلب مرجع التحويل والوقت بالضبط، ثم راجع تطبيقك مرة أخرى. ولا توافق حتى ترى الفلوس.

## الخلاصة

- راجع المبلغ والمرجع والوقت والمرسل والتكرار في كل إثبات.
- تأكد من تطبيقك قبل الموافقة.
- ارفض بسبب واضح ولطيف.
- اجعل الموافقة لشخص واحد، واجعل موافقة واحدة تفتح الكورس.

للصورة الأشمل عن المحافظ وإنستاباي والتحويل البنكي، اقرأ [تحصيل فلوس الكورسات في مصر](/ar/blog/collecting-course-payments-in-egypt). ولتجرّب القائمة بنفسك، [ابدأ تجربة أكاديميتك](/ar/pricing) واعمل عملية شراء تجريبية على أكاديميتك.
$atlasblog$,
   $atlasblog$رسم لكومة بطاقات صور غير مرتبة تتحول إلى عمود مرتب من البطاقات عليها علامات صح ذهبية، بجوار لابتوب وموبايل.$atlasblog$,
   $atlasblog$مراجعة مدفوعات الطلاب: من سكرينات الواتساب لقائمة موافقات$atlasblog$,
   $atlasblog$خمس نقاط تراجعها في كل إثبات دفع بفودافون كاش أو إنستاباي، وكيف ترفض بسبب واضح، وكيف تُدخل موافقة واحدة الطالب إلى الكورس فورًا.$atlasblog$,
   4),
  ($atlasblog$1a56576a-9789-5f6a-890f-311a812471cf$atlasblog$,
   $atlasblog$exam-integrity-without-cameras$atlasblog$,
   $atlasblog$cluster$atlasblog$::"platform_blog_post_kind",
   $atlasblog$exams$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-23T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-23T08:00:00Z$atlasblog$::timestamp,
   false,
   $atlasblog$/marketing-assets/blog/exam-integrity-without-cameras.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$a574cf55-55ed-5d59-af53-4c9d76a3dff5$atlasblog$,$atlasblog$3e427114-ca5b-590b-8fe3-b23f85784955$atlasblog$,$atlasblog$5ae035f1-0fe2-50cb-ac85-689682b880a2$atlasblog$]::TEXT[],
   $atlasblog$Exam integrity without cameras: what browser signals can and can't tell you$atlasblog$,
   $atlasblog$Leaving the page, pasting or exiting full screen can mean many things. How to read exam signals fairly, talk to a student about them, and what should never be recorded.$atlasblog$,
   $atlasblog$Browser signals during an online exam, such as a student leaving the page or pasting text, are evidence for a conversation, never a verdict. Each one has innocent explanations, and some ways of cheating leave no signal at all. Used well, signals tell you which attempts are worth a closer look. Used badly, they punish a student whose phone rang. Here is how to read them fairly.

## Signal by signal

| Signal | What it might mean | What else could cause it |
|---|---|---|
| Switching to another tab or window | Looking up an answer | A notification, a message from a parent, checking the time, a pop-up |
| Leaving full screen | Opening something else | Pressing the wrong key, a phone call, a browser that cannot hold full screen |
| Pasting text | Copying an answer from elsewhere | Pasting their own notes typed earlier, a keyboard shortcut by habit |
| Copying text | Sharing a question with someone | Selecting text to reread it, habit |
| Printing | Saving the questions to share | Pressing a shortcut by mistake |
| A gap in connection | Disconnecting on purpose | Weak home internet, mobile data running out, a power cut |

Notice that every row has a plausible innocent cause. That is normal, and it is why a signal on its own decides nothing.

## Why one signal is rarely proof

A single event says very little. A pattern says more: many tab switches in a short time, each followed by a correct answer, from a student whose other work does not match. Even then, you are looking at circumstantial evidence. Turning signals into an automatic score or a "cheating probability" hides that uncertainty behind a number and makes it look like a fact. Keep the judgement with a person who knows the student.

## What a browser cannot see

A browser only knows what happens on the exam page. It cannot see:

- a second phone in the student's other hand;
- a friend or sibling in the room;
- notes on the desk;
- a modified browser that hides or fakes its own signals.

So a clean record does not prove an honest attempt either. Signals are one input among several, next to the answers themselves, the time taken and what you know about the student.

## What should never be collected

Many secondary students are minors. Recording their camera, microphone, screen or keystrokes collects far more than an exam needs, inside their homes, and it is very hard to justify to parents. A fair setup records only what happens on the exam page, tells students exactly what that is before they start, and stops there.

## Talking to a student about a flagged attempt

If an attempt looks wrong, talk before you decide. A simple structure:

1. **Describe, do not accuse.** "Your attempt shows you left the exam page six times in ten minutes."
2. **Ask.** "Can you tell me what was happening?"
3. **Listen for the ordinary.** Calls, shared phones and weak internet are common.
4. **Decide on the whole picture.** The answers, the timing, the explanation and the student's other work.
5. **Explain your decision.** Whatever you decide, say why.

If the student is a minor, involve a parent, and keep the conversation private.

## How this works in Atlas

Atlas integrity settings record events in the student's browser and show them to reviewers as signals for review.

- **Four modes.** Off records nothing. Monitor records events without warning the student. Warn records events and warns the student each time. Strict also submits the attempt automatically once a limit you set is reached.
- **What is recorded.** Switching to another tab or window, leaving full screen, copying, pasting and printing on the quiz page, and a regular connection check so gaps show up.
- **Students are told first.** Before a monitored quiz, students see what is recorded and confirm they understand.
- **Full screen where the browser allows it.** You can require full screen. Some browsers, including every browser on iPhone, cannot use it; those students take the quiz as usual, and you see that full screen was unavailable.
- **"Worth a look".** Each attempt shows facts from its timeline with possible innocent explanations, such as a phone call or a dropped connection, plus the full event timeline. There is no score or verdict.
- **Never collected.** No camera, no microphone, no screen recording, no record of what students type, and nothing outside the quiz page. Nothing is blocked either: a student can still switch tabs, and it is recorded.

Signals come from the student's browser, so a modified browser can hide or fake them, and some rule-breaking leaves no trace. Read more in [Exam integrity and full-screen exams](https://docs.atlass.dpdns.org/courses/exam-integrity).

## Common questions

**Can I catch cheating without a webcam?**
You can notice attempts worth a closer look, and good exam design reduces the chance of cheating in the first place. No tool can catch everything, with or without a camera.

**Should a student lose marks for leaving full screen?**
Not on that alone. Look at the whole attempt and ask the student first.

**Do signals work on phones?**
Events on the quiz page are recorded on phones too, but full screen is not available in every phone browser, so leaving full screen may never show up there.

## Key takeaways

- Signals start a conversation; they do not end one.
- Every signal has innocent explanations.
- A browser cannot see second phones or people in the room.
- Never collect camera, microphone or keystrokes.

For the full exam design checklist, read [how to run fair online exams for secondary students](/blog/fair-online-exams-for-secondary-students). To see the integrity settings on a quiz of your own, [start an academy trial](/pricing).
$atlasblog$,
   $atlasblog$Illustration of a laptop showing a quiz, a webcam crossed out with a gold line, and small icons for a tab, a clock and a wifi signal.$atlasblog$,
   $atlasblog$Exam integrity without cameras: what browser signals show$atlasblog$,
   $atlasblog$Leaving the page, pasting or exiting full screen can mean many things. How to read exam signals fairly, and what should never be recorded.$atlasblog$,
   5,
   $atlasblog$امتحان بدون كاميرا: ماذا تخبرك ملاحظات المتصفح وماذا لا تخبرك$atlasblog$,
   $atlasblog$الخروج من الصفحة أو اللصق أو الخروج من ملء الشاشة لها أكثر من معنى. كيف تقرأ ملاحظات الامتحان بعدل، وكيف تتكلم مع الطالب عنها، وما الذي لا يجب تسجيله أبدًا.$atlasblog$,
   $atlasblog$ملاحظات المتصفح أثناء الامتحان الأونلاين، مثل خروج الطالب من الصفحة أو لصقه نصًا، هي مدخل لحوار، وليست حكمًا أبدًا. لكل واحدة منها تفسيرات بريئة، وبعض طرق الغش لا تترك أي ملاحظة على الإطلاق. إذا استُخدمت الملاحظات جيدًا، دلّتك على المحاولات التي تستحق نظرة أقرب. وإذا أُسيء استخدامها، عاقبت طالبًا رنّ موبايله. إليك كيف تقرؤها بعدل.

## الملاحظات واحدة واحدة

| الملاحظة | ما قد تعنيه | ما قد يسببها أيضًا |
|---|---|---|
| التبديل إلى تبويب أو نافذة أخرى | البحث عن إجابة | إشعار، أو رسالة من ولي الأمر، أو النظر إلى الساعة، أو نافذة منبثقة |
| الخروج من ملء الشاشة | فتح شيء آخر | ضغط زر بالخطأ، أو مكالمة، أو متصفح لا يثبت على ملء الشاشة |
| لصق نص | نقل إجابة من مكان آخر | لصق ملاحظاته التي كتبها قبل الامتحان، أو اختصار لوحة مفاتيح بحكم العادة |
| نسخ نص | إرسال سؤال لشخص آخر | تظليل النص لإعادة قراءته، أو مجرد عادة |
| الطباعة | حفظ الأسئلة لمشاركتها | ضغط اختصار بالخطأ |
| انقطاع في الاتصال | قطع الاتصال عن قصد | إنترنت ضعيف في البيت، أو انتهاء باقة الموبايل، أو انقطاع الكهرباء |

لاحظ أن لكل سطر سببًا بريئًا معقولًا. هذا طبيعي، ولهذا لا تحسم ملاحظة واحدة أي شيء.

## لماذا لا تكفي ملاحظة واحدة دليلًا؟

حدث واحد يقول القليل. أما النمط فيقول أكثر: تبديلات كثيرة بين التبويبات في وقت قصير، وبعد كل منها إجابة صحيحة، من طالب لا يتسق باقي أدائه مع ذلك. وحتى في هذه الحالة، ما أمامك قرائن وليس يقينًا. وتحويل الملاحظات إلى درجة تلقائية أو «نسبة احتمال غش» يخفي هذا الشك خلف رقم ويجعله يبدو حقيقة. اترك الحكم لشخص يعرف الطالب.

## ما الذي لا يستطيع المتصفح رؤيته؟

المتصفح يعرف فقط ما يحدث داخل صفحة الامتحان. ولا يستطيع أن يرى:

- موبايلًا ثانيًا في يد الطالب الأخرى؛
- صديقًا أو أخًا في نفس الغرفة؛
- ورقة ملاحظات على المكتب؛
- متصفحًا معدّلًا يخفي ملاحظاته أو يزوّرها.

لذلك فالسجل النظيف لا يثبت أن المحاولة نزيهة أيضًا. الملاحظات مدخل واحد بين عدة مدخلات، بجوار الإجابات نفسها، والوقت المستغرق، وما تعرفه عن الطالب.

## ما الذي لا يجب جمعه أبدًا

كثير من طلاب الثانوي قُصّر. وتسجيل الكاميرا أو الميكروفون أو الشاشة أو ما يكتبونه يجمع أكثر بكثير مما يحتاجه الامتحان، ومن داخل بيوتهم، ومن الصعب جدًا تبريره لأولياء الأمور. الإعداد العادل يسجّل فقط ما يحدث في صفحة الامتحان، ويخبر الطلاب بذلك بالضبط قبل أن يبدأوا، ويتوقف عند هذا الحد.

## كيف تتكلم مع طالب عن محاولة عليها ملاحظات

إذا بدت محاولة غير طبيعية، تكلّم قبل أن تقرر. خطوات بسيطة:

1. **صِف ولا تتّهم.** «محاولتك توضح أنك خرجت من صفحة الامتحان ست مرات في عشر دقائق.»
2. **اسأل.** «ممكن تحكي لي إيه اللي كان بيحصل؟»
3. **انتبه للأسباب العادية.** المكالمات، والموبايل المشترك، والإنترنت الضعيف أمور شائعة.
4. **قرر بناءً على الصورة كاملة.** الإجابات، والتوقيت، والتفسير، وباقي أداء الطالب.
5. **اشرح قرارك.** أيًّا كان قرارك، قل لماذا.

وإذا كان الطالب قاصرًا، أشرك ولي أمره، واجعل الكلام على انفراد.

## كيف يعمل هذا في أطلس

إعدادات النزاهة في أطلس تسجّل أحداثًا في متصفح الطالب، وتعرضها للمراجعين كملاحظات للمراجعة.

- **أربعة أوضاع.** متوقف: لا يُسجَّل شيء. مراقبة: تُسجَّل الأحداث دون تنبيه الطالب. تنبيه: تُسجَّل الأحداث ويُنبَّه الطالب كل مرة. صارم: وفوق ذلك تُسلَّم المحاولة تلقائيًا عند الوصول إلى حد تحدده أنت.
- **ما يُسجَّل.** التبديل إلى تبويب أو نافذة أخرى، والخروج من ملء الشاشة، والنسخ واللصق والطباعة في صفحة الاختبار، وفحص دوري للاتصال حتى تظهر أي فجوات.
- **الطالب يعرف مسبقًا.** قبل الاختبار المراقَب، يرى الطالب ما يُسجَّل ويؤكد أنه فهم ذلك.
- **ملء الشاشة حيث يسمح المتصفح.** تستطيع اشتراط ملء الشاشة. بعض المتصفحات، ومنها كل المتصفحات على الآيفون، لا تدعمه؛ وهؤلاء الطلاب يحلّون الاختبار عاديًا، وترى أنت أن ملء الشاشة لم يكن متاحًا.
- **«يستحق النظر».** كل محاولة تعرض وقائع من سجلها الزمني مع تفسيرات بريئة محتملة، مثل مكالمة أو انقطاع الإنترنت، ومعها السجل الزمني الكامل للأحداث. ولا توجد درجة أو حكم.
- **ما لا يُجمع أبدًا.** لا كاميرا، ولا ميكروفون، ولا تسجيل للشاشة، ولا سجل لما يكتبه الطالب، ولا شيء خارج صفحة الاختبار. ولا يُمنع شيء أيضًا: يستطيع الطالب التبديل بين التبويبات، ويُسجَّل ذلك.

الملاحظات تأتي من متصفح الطالب، لذلك قد يخفيها متصفح معدّل أو يزوّرها، وبعض المخالفات لا تترك أثرًا. اقرأ المزيد في [نزاهة الامتحان والامتحانات بملء الشاشة](https://docs.atlass.dpdns.org/ar/courses/exam-integrity).

## أسئلة شائعة

**هل أستطيع كشف الغش بدون كاميرا ويب؟**
تستطيع أن تلاحظ المحاولات التي تستحق نظرة أقرب، وتصميم الامتحان الجيد يقلل فرص الغش من الأساس. ولا توجد أداة تكشف كل شيء، بكاميرا أو بدونها.

**هل يخسر الطالب درجات لأنه خرج من ملء الشاشة؟**
ليس لهذا السبب وحده. راجع المحاولة كاملة، واسأل الطالب أولًا.

**هل تعمل الملاحظات على الموبايل؟**
الأحداث داخل صفحة الاختبار تُسجَّل على الموبايل أيضًا، لكن ملء الشاشة غير متاح في كل متصفحات الموبايل، فقد لا يظهر الخروج منه هناك أبدًا.

## الخلاصة

- الملاحظات تبدأ حوارًا، ولا تنهيه.
- لكل ملاحظة تفسيرات بريئة.
- المتصفح لا يرى الموبايل الثاني ولا الأشخاص في الغرفة.
- لا تجمع الكاميرا أو الميكروفون أو ما يكتبه الطالب أبدًا.

لقائمة تصميم الامتحان كاملة، اقرأ [كيف تعمل امتحانات أونلاين عادلة لطلاب الثانوي](/ar/blog/fair-online-exams-for-secondary-students). ولترى إعدادات النزاهة على اختبار خاص بك، [ابدأ تجربة أكاديميتك](/ar/pricing).
$atlasblog$,
   $atlasblog$رسم للابتوب يعرض اختبارًا، وكاميرا ويب عليها خط ذهبي، وأيقونات صغيرة لتبويب وساعة وإشارة واي فاي.$atlasblog$,
   $atlasblog$امتحان بدون كاميرا: ماذا تقول ملاحظات المتصفح؟$atlasblog$,
   $atlasblog$الخروج من الصفحة أو اللصق أو الخروج من ملء الشاشة لها أكثر من معنى. كيف تقرأ ملاحظات الامتحان بعدل، وما الذي لا يجب أن يُسجَّل أبدًا.$atlasblog$,
   4),
  ($atlasblog$75b60022-36b1-5589-b77d-090bb07fbb39$atlasblog$,
   $atlasblog$one-academy-or-several$atlasblog$,
   $atlasblog$cluster$atlasblog$::"platform_blog_post_kind",
   $atlasblog$teaching$atlasblog$::"platform_blog_topic",
   'published'::"platform_blog_post_status",
   $atlasblog$2026-10-25T08:00:00Z$atlasblog$::timestamp,
   $atlasblog$2026-10-25T08:00:00Z$atlasblog$::timestamp,
   false,
   $atlasblog$/marketing-assets/blog/one-academy-or-several.webp$atlasblog$,
   1200,
   630,
   $atlasblog$Atlas team$atlasblog$,
   ARRAY[$atlasblog$5cdb7352-565e-57a5-b406-7f6fa77e1944$atlasblog$,$atlasblog$5071618b-4156-5c3d-ad06-11a8275e2ca2$atlasblog$,$atlasblog$49f7ec27-733e-58c9-8881-ca5fd039d9d0$atlasblog$]::TEXT[],
   $atlasblog$One academy or several? Structuring a multi-teacher center online$atlasblog$,
   $atlasblog$Compare one shared academy with an academy per teacher on brand, payments, students and reporting, and plan what happens when a teacher leaves.$atlasblog$,
   $atlasblog$If several teachers work under one roof, sooner or later you have to decide how that looks online: one shared academy with every teacher's courses inside it, or a separate academy for each teacher. One shared academy suits a center that sells under a single name with one team running it. Separate academies suit teachers who each have their own brand, students and pricing. In both cases, someone has to own the account and approve the money, and that decision matters more than the structure.

## One shared academy: when it fits

A single academy works well when:

- students know the center's name rather than individual teachers;
- the same office team handles sign-ups, questions and payments for everyone;
- students often take courses with more than one teacher;
- prices and rules are set centrally.

Students see one website, one catalogue and one place to pay. Teachers work on their own courses inside it. The trade-off is that a teacher with a strong personal following does not get a site under their own name.

## One academy per teacher: when it fits

Separate academies work well when:

- each teacher has their own name, audience and social pages;
- teachers set their own prices and rules;
- students rarely cross between teachers;
- you want each teacher's website, domain and student list kept apart.

Each academy can look and feel different; our guide on [building a website for your teaching academy](/blog/build-a-website-for-your-teaching-academy) covers what each site needs. The trade-off is more setup and more places to check: several websites, several payment lists, several teams.

## The decision matrix

| Question | One shared academy | One academy per teacher |
|---|---|---|
| Brand | The center's name | Each teacher's name |
| Website and domain | One site, one address | A site and address per teacher |
| Students | One student list | A separate list per academy |
| Payments | One set of payment details | Payment details per academy |
| Reporting | One academy's reports | Reports per academy |
| Revenue split | Agreed between you, outside the platform | Agreed between you, outside the platform |
| When a teacher leaves | Their courses stay in the academy | Their academy stays with the account owner |

## Money: who receives it and who approves it

Decide two things in writing before you set anything up.

1. **Whose account receives student payments.** The center's, or each teacher's. Students pay the details shown at checkout, so those details decide where the money goes.
2. **Who confirms payments and opens access.** One person should do this for each set of payment details, someone who can see the account the money lands in.

Revenue splits between a center and its teachers are a business agreement. Write them down between you; a teaching platform records sales, it does not divide them. For a routine the approver can follow on every proof, see [from WhatsApp screenshots to an approval queue](/blog/from-whatsapp-screenshots-to-approval-queue).

## When a teacher leaves

Plan for this on day one, because it will happen.

- **Content.** Who owns the recorded lessons and quizzes? Agree it in writing.
- **Students.** Who keeps the relationship with students who are mid-course?
- **Access.** Remove the teacher's access to the dashboard on their last day.
- **Payments.** If students paid into the teacher's own account, agree how refunds or remaining months are handled.

A structure where the center owns the account and adds teachers as team members makes the exit simpler, because nothing has to be moved.

## How this works in Atlas

- **Several academies in one account.** The organization owner can create more academies, up to the number the plan allows. Each academy has its own website, theme and address, its own courses, quizzes and certificates, its own managers, instructors and students, and its own payment methods and course orders. All of them share one subscription.
- **Its own domain.** Each academy can connect its own domain.
- **One switcher.** A switcher in the dashboard's top bar moves between academies and shows your role in each. The owner sees every academy; managers and instructors see only the academies they were added to.
- **Separate students.** Each academy sees only its own students. A student can use the same Atlas account at another academy, but the academies' lists stay apart.
- **Teachers as instructors.** Add each teacher as an instructor; instructors work only on the courses they are assigned to. Managers help run an academy day to day.
- **The owner approves payments.** In either structure, only the organization owner sets up payment methods and approves student payments. Managers and instructors cannot.
- **When a teacher leaves.** The owner removes them from the academy. They lose access straight away, and the academy's courses stay where they are.

Details are in [Create another academy](https://docs.atlass.dpdns.org/academy/another-academy) and [Roles and permissions](https://docs.atlass.dpdns.org/roles/roles-and-permissions).

## Common questions

**Can each teacher approve their own students' payments?**
Not in Atlas. Payment approval stays with the organization owner. If each teacher needs to approve their own payments, each would need their own organization and subscription.

**Can one student study with two of our academies?**
Yes, with the same account. Each academy enrols and manages them separately.

**Can we start with one academy and split later?**
You can add academies later. Each academy has its own courses and students, so a later split means building the new academy's courses and bringing its students in there. If you expect to split, decide early.

## Key takeaways

- One shared academy for one brand and one team; one per teacher for separate brands.
- Decide whose account receives payments and who approves them.
- Write down revenue splits and what happens when a teacher leaves.

If you run a multi-teacher center and want to talk through the right structure, [contact the Atlas team](/contact?topic=sales).
$atlasblog$,
   $atlasblog$Illustration of one large learning center building and three smaller academy buildings, linked by gold lines to a single key.$atlasblog$,
   $atlasblog$One academy or several for a multi-teacher center?$atlasblog$,
   $atlasblog$Compare one shared academy with an academy per teacher on branding, payments, students and reporting, and what happens when a teacher leaves.$atlasblog$,
   5,
   $atlasblog$أكاديمية واحدة أم أكاديمية لكل مدرس؟ تنظيم مركز تعليمي فيه عدة مدرسين$atlasblog$,
   $atlasblog$قارن بين أكاديمية واحدة للجميع وأكاديمية لكل مدرس في الاسم والمدفوعات والطلاب والتقارير، وخطط لما يحدث حين يغادر أحد المدرسين.$atlasblog$,
   $atlasblog$إذا كان معك عدة مدرسين في مركز تعليمي واحد، فستحتاج عاجلًا أو آجلًا أن تقرر شكل ذلك أونلاين: أكاديمية واحدة مشتركة فيها كورسات كل المدرسين، أم أكاديمية مستقلة لكل مدرس. الأكاديمية المشتركة تناسب مركزًا يبيع باسم واحد ويديره فريق واحد. والأكاديميات المستقلة تناسب مدرسين لكل منهم اسمه وطلابه وأسعاره. وفي الحالتين لا بد أن يملك شخص ما الحساب ويوافق على الفلوس، وهذا القرار أهم من شكل التنظيم نفسه.

## أكاديمية واحدة مشتركة: متى تناسبك؟

الأكاديمية الواحدة تنجح حين:

- يعرف الطلاب اسم المركز أكثر من أسماء المدرسين؛
- يتولى نفس فريق الإدارة التسجيل والأسئلة والمدفوعات للجميع؛
- يأخذ الطلاب كثيرًا كورسات مع أكثر من مدرس؛
- تُحدَّد الأسعار والقواعد مركزيًا.

يرى الطلاب موقعًا واحدًا، وكتالوجًا واحدًا، ومكانًا واحدًا للدفع. ويعمل كل مدرس على كورساته داخلها. والمقابل أن المدرس صاحب الجمهور الشخصي الكبير لا يحصل على موقع باسمه.

## أكاديمية لكل مدرس: متى تناسبك؟

الأكاديميات المستقلة تنجح حين:

- يكون لكل مدرس اسمه وجمهوره وصفحاته على السوشيال ميديا؛
- يحدد كل مدرس أسعاره وقواعده؛
- نادرًا ما ينتقل الطلاب بين المدرسين؛
- تريد أن يبقى موقع كل مدرس ودومينه وقائمة طلابه منفصلة.

كل أكاديمية يمكن أن يكون لها شكل وطابع مختلف، ودليلنا عن [بناء موقع لأكاديميتك التعليمية](/ar/blog/build-a-website-for-your-teaching-academy) يشرح ما يحتاجه كل موقع. والمقابل مزيد من الإعداد وأماكن أكثر للمتابعة: عدة مواقع، وعدة قوائم مدفوعات، وعدة فرق.

## جدول المقارنة

| السؤال | أكاديمية واحدة مشتركة | أكاديمية لكل مدرس |
|---|---|---|
| الاسم | اسم المركز | اسم كل مدرس |
| الموقع والدومين | موقع واحد وعنوان واحد | موقع وعنوان لكل مدرس |
| الطلاب | قائمة طلاب واحدة | قائمة مستقلة لكل أكاديمية |
| المدفوعات | بيانات دفع واحدة | بيانات دفع لكل أكاديمية |
| التقارير | تقارير أكاديمية واحدة | تقارير لكل أكاديمية |
| تقسيم الإيراد | اتفاق بينكم، خارج المنصة | اتفاق بينكم، خارج المنصة |
| حين يغادر مدرس | تبقى كورساته في الأكاديمية | تبقى أكاديميته مع صاحب الحساب |

## الفلوس: من يستلمها ومن يوافق عليها

قرر أمرين كتابةً قبل أن تجهّز أي شيء:

1. **حساب من يستلم مدفوعات الطلاب.** حساب المركز، أم حساب كل مدرس. الطلاب يدفعون للبيانات التي تظهر لهم عند الشراء، فهذه البيانات هي التي تحدد أين تذهب الفلوس.
2. **من يؤكد المدفوعات ويفتح الوصول.** يجب أن يتولى ذلك شخص واحد لكل مجموعة بيانات دفع، شخص يستطيع رؤية الحساب الذي تصل إليه الفلوس.

أما تقسيم الإيراد بين المركز ومدرسيه فهو اتفاق عمل. اكتبوه بينكم؛ منصة التدريس تسجّل المبيعات، ولا تقسّمها. ولخطوات يتبعها المسؤول عن الموافقة في كل إثبات، راجع [من سكرينات الواتساب إلى قائمة موافقات](/ar/blog/from-whatsapp-screenshots-to-approval-queue).

## حين يغادر مدرس

خطط لهذا من اليوم الأول، لأنه سيحدث.

- **المحتوى.** من يملك الدروس المسجّلة والاختبارات؟ اتفقوا على ذلك كتابةً.
- **الطلاب.** من يحتفظ بالعلاقة مع الطلاب الذين في منتصف الكورس؟
- **الوصول.** أزل وصول المدرس إلى لوحة التحكم في آخر يوم له.
- **المدفوعات.** إذا كان الطلاب يدفعون إلى حساب المدرس الشخصي، فاتفقوا على طريقة التعامل مع الاسترداد أو الشهور المتبقية.

التنظيم الذي يملك فيه المركز الحساب ويضيف المدرسين كأعضاء في الفريق يجعل المغادرة أبسط، لأنه لا شيء يحتاج إلى نقل.

## كيف يعمل هذا في أطلس

- **عدة أكاديميات في حساب واحد.** صاحب الحساب يستطيع إنشاء أكاديميات إضافية، حتى العدد الذي تسمح به الباقة. لكل أكاديمية موقعها وتصميمها وعنوانها، وكورساتها واختباراتها وشهاداتها، ومديروها ومدرّسوها وطلابها، وطرق الدفع وطلبات الشراء الخاصة بها. وكلها تشترك في اشتراك واحد.
- **دومين خاص لكل أكاديمية.** كل أكاديمية تستطيع ربط الدومين الخاص بها.
- **مبدّل واحد.** في الشريط العلوي للوحة التحكم مبدّل يتنقل بين الأكاديميات ويوضح دورك في كل منها. صاحب الحساب يرى كل الأكاديميات، والمديرون والمدرّسون يرون فقط الأكاديميات التي أُضيفوا إليها.
- **طلاب منفصلون.** كل أكاديمية ترى طلابها فقط. يستطيع الطالب استخدام نفس حسابه على أطلس في أكاديمية أخرى، لكن قوائم الأكاديميات تبقى منفصلة.
- **المدرسون كمدرّسين.** أضف كل مدرس بدور مدرّس؛ والمدرّس يعمل فقط في الكورسات المسندة إليه. والمديرون يساعدون في إدارة الأكاديمية يومًا بيوم.
- **صاحب الحساب يوافق على المدفوعات.** في أي من التنظيمين، صاحب الحساب وحده يضبط طرق الدفع ويوافق على مدفوعات الطلاب. المديرون والمدرّسون لا يستطيعون ذلك.
- **حين يغادر مدرس.** يزيله صاحب الحساب من الأكاديمية، فيفقد وصوله فورًا، وتبقى كورسات الأكاديمية في مكانها.

التفاصيل في [إنشاء أكاديمية أخرى](https://docs.atlass.dpdns.org/ar/academy/another-academy) و[الأدوار والصلاحيات](https://docs.atlass.dpdns.org/ar/roles/roles-and-permissions).

## أسئلة شائعة

**هل يستطيع كل مدرس الموافقة على مدفوعات طلابه؟**
ليس في أطلس. الموافقة على المدفوعات تبقى مع صاحب الحساب. وإذا احتاج كل مدرس أن يوافق على مدفوعاته بنفسه، فسيحتاج كل منهم حسابًا واشتراكًا خاصًا به.

**هل يستطيع طالب واحد الدراسة في أكاديميتين من أكاديمياتنا؟**
نعم، بنفس الحساب. وكل أكاديمية تسجّله وتديره بشكل منفصل.

**هل نبدأ بأكاديمية واحدة ثم نقسّمها لاحقًا؟**
تستطيع إضافة أكاديميات لاحقًا. لكن لكل أكاديمية كورساتها وطلابها، فالتقسيم لاحقًا يعني بناء كورسات الأكاديمية الجديدة وضم طلابها إليها. إذا كنت تتوقع التقسيم، فقرر مبكرًا.

## الخلاصة

- أكاديمية واحدة مشتركة لاسم واحد وفريق واحد، وأكاديمية لكل مدرس للأسماء المستقلة.
- قرر حساب من يستلم المدفوعات ومن يوافق عليها.
- اكتب تقسيم الإيراد، وما يحدث حين يغادر مدرس.

إذا كنت تدير مركزًا فيه عدة مدرسين وتحب أن تناقش التنظيم المناسب لكم، [تواصل مع فريق أطلس](/ar/contact?topic=sales).
$atlasblog$,
   $atlasblog$رسم لمبنى مركز تعليمي كبير وثلاثة مبانٍ صغيرة لأكاديميات، تربطها خطوط ذهبية بمفتاح واحد.$atlasblog$,
   $atlasblog$أكاديمية واحدة أم أكاديمية لكل مدرس؟$atlasblog$,
   $atlasblog$قارن بين أكاديمية واحدة للجميع وأكاديمية لكل مدرس في الاسم والدفع والطلاب والتقارير، وما الذي يحدث لما يغادر أحد المدرسين المركز.$atlasblog$,
   4)
)
INSERT INTO "platform_blog_posts" ("id","slug","kind","topic","status","publish_at","published_at","featured","cover_image_url","cover_image_width","cover_image_height","author_name","related_post_ids","title_en","excerpt_en","body_en","cover_alt_en","seo_title_en","seo_description_en","reading_minutes_en","title_ar","excerpt_ar","body_ar","cover_alt_ar","seo_title_ar","seo_description_ar","reading_minutes_ar", "version", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at")
SELECT d."id", d."slug", d."kind", d."topic", d."status", d."publish_at", d."published_at", d."featured", d."cover_image_url", d."cover_image_width", d."cover_image_height", d."author_name", d."related_post_ids", d."title_en", d."excerpt_en", d."body_en", d."cover_alt_en", d."seo_title_en", d."seo_description_en", d."reading_minutes_en", d."title_ar", d."excerpt_ar", d."body_ar", d."cover_alt_ar", d."seo_title_ar", d."seo_description_ar", d."reading_minutes_ar", 1, owner."id", owner."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM data d CROSS JOIN owner
ON CONFLICT ("slug") DO NOTHING;
