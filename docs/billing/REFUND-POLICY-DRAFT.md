# DRAFT — pending legal review (RV-04); not published; Terms unchanged

# Atlas subscription refund policy (draft for counsel)

**Record:** B0-BIL-09 (drafting part: this draft and `REFUND-LOG-TEMPLATE.md`). **Owner:** Platform Owner. **Reviewer:** counsel (OQ-15, RV-04).
**Status:** working draft written for counsel. It is **not** a policy and **not** published, and it does not change the Terms of Service. Until counsel approves a final text and the owner publishes it in the Terms, Terms §10 stays as it is today: refunds are "considered case by case" and nothing promises one (`atlas` `src/features/legal/content/terms.en.ts` L223).

**Do not** quote this draft to customers, link it, or use any "money-back" or "guaranteed refund" wording anywhere (product, website, sales, social) before the published policy exists.

**This document makes no legal claims.** It says what the product does today and offers policy options. Which laws apply (consumer or commercial rules, tax, data retention) and what they require is for counsel. Every clause marked **[COUNSEL]** needs counsel's review. **[OWNER]** marks a business choice for the owner.

---

## Part A — What the product does today (code-verified 14 Oct 2026)

Counsel should read this first: the policy must not promise anything the product or the operations cannot deliver.

| # | Fact | Evidence (atlas-backend unless stated) |
|---|---|---|
| A1 | **Free trials charge nothing.** No card is collected and a trial does not turn into a paid subscription by itself. There is nothing to refund for a trial. | Terms §8 (`atlas` `terms.en.ts`, "No payment card is required…"); trial start creates no payment (`src/plans/services/trial-redemption.service.ts`). |
| A2 | **Subscriptions are paid by manual transfer** (bank transfer, mobile wallet, InstaPay). The customer uploads proof, and the Platform Owner approves or rejects it. Atlas never sees card details. | `src/billing/controllers/platform-payment.controller.ts` L58 (`approve`), L67 (`reject`); Terms §9. |
| A3 | **The product has no subscription refund feature.** A payment has no "refunded" state. Manual-transfer methods declare `supportsRefunds: false`. The gateway webhook handler ignores refund events ("no refund flow exists yet"). | `prisma/schema.prisma` `enum PaymentLifecycleStatus` (L3932: no refunded value); `src/billing/utils/manual-payment-instructions.util.ts` L30; `src/billing/services/payment-webhook.service.ts` L141–144. |
| A4 | **A refund cannot be recorded on the payment.** There is no endpoint to add a note to a payment after it has been reviewed. A refund has to be kept in the owner's refund log (`REFUND-LOG-TEMPLATE.md`) until a refund record exists (EP-31, deferred). | `platform-payment.controller.ts` (only `approve` and `reject` write). |
| A5 | **Cancelling a paid subscription stops renewal.** The customer keeps access until the end of the period already paid for. Cancelling never shortens paid time. | `src/plans/controllers/tenant-subscription.controller.ts` L195–219; `src/plans/repositories/tenant-subscriptions.repository.ts` `markPaidCancelAtPeriodEnd`. |
| A6 | **The Platform Owner can extend a period, grant days or change the plan,** each audited with a reason. **No action shortens or ends a paid period early** (the number of days must be at least 1). So a refund does not change the customer's access in the product. Ending access early after a refund would need an engineering action. | `src/platform/controllers/admin-subscriptions.controller.ts` (`extend`, `grant-days`, `change-plan`); `src/platform/dto/subscription-adjustment.dto.ts` L24–29. |
| A7 | **Gifted setup days are free**, given once per customer on a first paid subscription, and **a refund does not restore eligibility** for them. | `src/plans/services/paid-gift-eligibility.service.ts` L29–30; Privacy Policy (`atlas` `privacy-policy.en.ts` L264). |
| A8 | **Course fees are not Atlas's money.** With Academy Manual Payments the learner pays the academy directly, and the API refuses a learner's refund request with "contact the academy" (`errors.courseOrder.refundContactAcademy`). The learner screen says: "Paid to the academy directly. For a refund, contact the academy." | `src/course-commerce/services/course-order-refunds.service.ts` L142–150; `atlas` `learning.json` `contactAcademy`. |
| A9 | **Atlas Payments (Atlas collects course fees and takes a commission) is not launched.** An organization cannot select it (`TENANT_SELECTABLE_MODES = ['unconfigured']`). Code exists for a 30-day self-service refund on Atlas-collected course orders, but no organization should be on that mode at launch. | `src/billing/services/organization-payment-settings.service.ts` L20, L48–64 (refused with `errors.payment.collectionModeNotAvailable`); `src/course-commerce/dto/course-commerce.constants.ts` L21 (`REFUND_WINDOW_DAYS = 30`). Whether any organization was switched to it before this guard is a production-data check (B0-COM-03). |
| A10 | Plans are priced in **EGP**. VAT registration, VAT-inclusive prices and tax invoices are **undecided** (B0-BIL-10). Today the customer gets an email receipt, not a tax invoice. | Owner decision 12 Oct 2026; Terms §9. |

---

## Part B — Draft policy text (EN)

*Bracketed options are for the owner to choose. Every numbered clause needs counsel's review.*

### 1. What this policy covers **[COUNSEL]**
This policy covers payments an organization makes **to Atlas** for an Atlas subscription plan. It does not cover fees a learner pays **to an academy** for a course. Those payments go to the academy, and the academy is responsible for refunding them (see clause 9).

### 2. Free trials **[COUNSEL]**
A free trial costs nothing and needs no payment card, so there is nothing to refund. Cancelling a trial ends it immediately.

### 3. Payments Atlas did not accept **[COUNSEL] [OWNER]**
If you sent money but Atlas did not approve the payment (for example, the proof was rejected or the transfer did not match an open payment), Atlas will return the amount it received to the account it came from, once it has confirmed that the money arrived. **[OWNER: target time, e.g. within 10 business days of confirming receipt.]**

### 4. Payments made in error **[COUNSEL] [OWNER]**
If you paid twice for the same period, or paid the wrong amount, tell us through Support. After checking our records, Atlas refunds the duplicate payment or the difference in full. **[OWNER: or offers to credit it to the next period as days, if the customer prefers. A credit is possible today with "grant days"; see A6.]**

### 5. Change of mind after a paid subscription starts **[COUNSEL] [OWNER — choose one]**
- **Option 5a (no refund, clear rule):** Paid periods are not refundable once Atlas has approved the payment. You can cancel at any time to stop renewal, and you keep access until the end of the period you paid for.
- **Option 5b (first-purchase window):** For your **first** paid subscription only, you can ask for a full refund within **[7 / 14] days** of the date Atlas approved the payment. After that window, option 5a applies. **[COUNSEL: whether a statutory withdrawal or cooling-off right applies to business customers and/or consumers, and whether a window has to be offered.]**
- **Option 5c (annual plans, pro rata):** For an annual plan cancelled in its first **[N] months**, Atlas refunds the unused **whole months** at the monthly-equivalent price **[less the value of any discount the annual price gave]**. Monthly plans follow option 5a.

*Not offered without the owner's explicit decision:* a founding-offer "money-back guarantee" (pricing §4.2.8). If chosen, it must be written into this clause with its exact conditions **before** it is mentioned anywhere.

### 6. When Atlas cannot provide the service **[COUNSEL]**
If Atlas cannot set up or provide the service you paid for (for example, your academy could not be created and the problem is on Atlas's side), and Atlas cannot fix it within **[OWNER: N days]**, you can choose between a refund of the unused part of the period **[or the full amount]** and extra days added free of charge. **[COUNSEL: interaction with Terms §11 (no uptime commitment or service credits) and any liability limits.]**

### 7. What is never refunded **[COUNSEL]**
- Gifted setup days, because they are free.
- Periods that have already ended.
- A refund does not restore a used free trial or gifted setup days.

### 8. How refunds are paid **[COUNSEL] [OWNER]**
- Atlas returns the money by manual transfer, to the same bank account, wallet or InstaPay address the payment came from, **in EGP**. **[OWNER: whether Atlas or the customer bears the transfer fees.]**
- Atlas does not refund to a different person's account. **[COUNSEL: identity checks needed before paying out.]**
- Target time once a refund is approved: **[OWNER: N business days]**.
- **[COUNSEL: tax treatment of a refunded amount once the VAT position (B0-BIL-10) is decided; credit notes if tax invoices are introduced.]**

### 9. Course fees paid to academies **[COUNSEL]**
Academies sell their own courses and receive learners' payments directly. Atlas does not hold that money and cannot refund it. A learner who wants a course refund should contact the academy. **[COUNSEL: whether Atlas must state any minimum the academies have to publish; how this interacts with the academies' own terms.]**

### 10. What a refund does to your subscription **[OWNER] [COUNSEL]**
- **[Option 10a]** A full refund of a period ends the subscription. Atlas cancels the renewal, and access ends **[at once / at a date agreed with you]**. *Ending access early needs an engineering action today (A6).*
- **[Option 10b]** A refund under clauses 3–4 changes nothing else. A refund under clause 5 or 6 cancels the renewal, and you keep access until the end of the paid period.

### 11. How to ask **[OWNER]**
The organization owner asks through **Dashboard → Support** (a support ticket), giving the payment and the reason. Atlas answers within **[OWNER: N business days]**. Learners contact their academy, not Atlas.

### 12. Misuse **[COUNSEL]**
Atlas may refuse a refund where it reasonably believes the request is abusive (for example, repeated buy-and-refund cycles), and will explain why.

---

## Part C — Draft policy text (AR) — REQUIRES NATIVE-SPEAKER AND LEGAL REVIEW

*Translation of Part B for review only. It is not approved wording. Bracketed options follow the English draft.*

### 1. نطاق هذه السياسة
تغطي هذه السياسة المبالغ التي تدفعها المؤسسة **إلى Atlas** مقابل خطة اشتراك في Atlas. ولا تغطي الرسوم التي يدفعها المتعلّم **إلى أكاديمية** مقابل دورة؛ فهذه المبالغ تذهب إلى الأكاديمية، والأكاديمية هي المسؤولة عن ردّها (انظر البند 9).

### 2. الفترات التجريبية المجانية
الفترة التجريبية مجانية ولا تتطلب بطاقة دفع، لذلك لا يوجد ما يُردّ. وإلغاء الفترة التجريبية ينهيها فورًا.

### 3. مدفوعات لم تقبلها Atlas
إذا حوّلت مبلغًا ولم توافق Atlas على الدفعة (مثلًا رُفض الإثبات أو لم يطابق التحويل دفعة مفتوحة)، تعيد Atlas المبلغ الذي استلمته إلى الحساب الذي جاء منه بعد التأكد من وصوله. **[المالك: المدة المستهدفة]**

### 4. مدفوعات تمت بالخطأ
إذا دفعت مرتين عن الفترة نفسها أو دفعت مبلغًا خاطئًا، أخبرنا عبر الدعم. بعد مراجعة سجلاتنا تردّ Atlas الدفعة المكررة أو الفرق كاملًا. **[المالك: أو إضافته أيامًا إلى الفترة التالية إن فضّل العميل ذلك]**

### 5. العدول بعد بدء اشتراك مدفوع **[اختيار واحد]**
- **الخيار 5أ:** لا تُردّ الفترات المدفوعة بعد موافقة Atlas على الدفعة. يمكنك الإلغاء في أي وقت لإيقاف التجديد، ويبقى وصولك حتى نهاية الفترة التي دفعتها.
- **الخيار 5ب:** لأول اشتراك مدفوع فقط، يمكنك طلب استرداد كامل خلال **[7 / 14] يومًا** من تاريخ موافقة Atlas على الدفعة. بعد ذلك ينطبق الخيار 5أ.
- **الخيار 5ج:** للخطة السنوية التي تُلغى خلال أول **[N] أشهر**، تردّ Atlas قيمة الأشهر الكاملة غير المستخدمة بالسعر الشهري المكافئ **[ناقص قيمة خصم السعر السنوي]**. وتخضع الخطط الشهرية للخيار 5أ.

### 6. إذا تعذّر على Atlas تقديم الخدمة
إذا لم تستطع Atlas إعداد الخدمة التي دفعت مقابلها أو تقديمها بسبب مشكلة من جانبها، ولم تُصلحها خلال **[المالك: N يومًا]**، يمكنك الاختيار بين ردّ قيمة الجزء غير المستخدم من الفترة **[أو المبلغ كاملًا]** وإضافة أيام مجانية.

### 7. ما لا يُردّ أبدًا
- أيام الإعداد المهداة، لأنها مجانية.
- الفترات التي انتهت بالفعل.
- لا يعيد الاسترداد فترة تجريبية مستخدمة ولا أيام إعداد مهداة.

### 8. كيف يُدفع المبلغ المسترد
- تعيد Atlas المبلغ بتحويل يدوي إلى الحساب البنكي أو المحفظة أو عنوان InstaPay الذي جاءت منه الدفعة، **بالجنيه المصري**. **[المالك: من يتحمل رسوم التحويل]**
- لا تردّ Atlas المبلغ إلى حساب شخص آخر.
- المدة المستهدفة بعد الموافقة على الاسترداد: **[المالك: N يوم عمل]**.

### 9. رسوم الدورات المدفوعة للأكاديميات
تبيع الأكاديميات دوراتها وتستلم مدفوعات المتعلّمين مباشرة. لا تحتفظ Atlas بهذه المبالغ ولا تستطيع ردّها. على المتعلّم الذي يريد استرداد رسوم دورة أن يتواصل مع الأكاديمية.

### 10. أثر الاسترداد على اشتراكك **[اختيار]**
- **[الخيار 10أ]** الاسترداد الكامل لفترة ينهي الاشتراك: تلغي Atlas التجديد، وينتهي الوصول **[فورًا / في تاريخ يُتفق عليه معك]**.
- **[الخيار 10ب]** الاسترداد وفق البندين 3 و4 لا يغيّر شيئًا آخر. والاسترداد وفق البند 5 أو 6 يلغي التجديد، ويبقى وصولك حتى نهاية الفترة المدفوعة.

### 11. كيف تطلب الاسترداد
يطلب مالك المؤسسة الاسترداد من **لوحة التحكم ← الدعم** (تذكرة دعم)، مع ذكر الدفعة والسبب. تردّ Atlas خلال **[المالك: N يوم عمل]**. أما المتعلّمون فيتواصلون مع أكاديميتهم، لا مع Atlas.

### 12. إساءة الاستخدام
يجوز لـ Atlas رفض طلب استرداد إذا رأت لأسباب معقولة أنه مسيء (مثل تكرار الشراء ثم الاسترداد)، وتوضح السبب.

---

## Part D — Questions for counsel (RV-04)

1. Which legal framework governs refunds to **organizations** (business customers) versus individual teachers who may count as consumers? Does any mandatory withdrawal, cooling-off or refund right apply, and from when (payment, approval, first use)?
2. Can a "no refund after approval" rule (option 5a) be enforced against each customer type? If not, what is the minimum that must be offered?
3. Required content and placement of a refund policy (Terms §10, a separate page, at checkout, in the receipt email), and the language versions needed (EN and AR).
4. Identity and anti-fraud checks before paying money back by manual transfer, and record-keeping duties for refunds (retention period for the refund log, its contents).
5. Tax: the treatment of refunds before and after any VAT registration (B0-BIL-10), and whether a credit note is needed.
6. Atlas's position on **course** refunds between learners and academies: is "the academy is responsible" enough, or must Atlas require academies to publish their own refund terms?
7. Interaction with Terms §11 (no uptime commitment or service credits) and any limitation of liability, for clause 6.
8. Whether a founding-offer guarantee may be advertised, and with what wording, once a policy is published.

## Part E — What happens after counsel

1. Counsel returns a marked-up text. The owner makes the **[OWNER]** choices.
2. Engineering checks the final text against Part A. Any promise the product cannot keep (for example, ending access early after a refund, A6) is either removed or turned into an engineering task first.
3. Terms §10 (EN and AR) and any checkout or receipt copy are updated in a separate, reviewed change, with a new "last updated" date. **Not part of this draft.**
4. The refund log (`REFUND-LOG-TEMPLATE.md`) is in use from the first refund, whether or not the policy is published yet.
