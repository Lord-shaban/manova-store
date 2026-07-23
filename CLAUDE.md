# CLAUDE.md — دليل المشروع (اقرأه الأول، وفّر وقت الاستكشاف)

> ملف مرجعي مكثّف عشان تشتغل من غير ما تعيد قراءة نص المشروع كل سيشن.
> **رد على المستخدم بالعامية المصرية دايمًا.** المستخدم = أحمد، صاحب براند **MANOVA** (ملابس رجالي، اسنا). كل الواجهات عربي RTL بألوان ذهبي/أسود.

## إيه المشروع
متجر إلكتروني **static بالكامل** (HTML/CSS/JS خام، بدون build) بيتكلم مباشرة مع **Firebase** (Firestore + Auth + Storage). بيستضاف مجانًا على **Cloudflare Pages** — مجلد النشر = `public`.

## التشغيل والفحص
```bash
npm run dev            # = node scripts/dev-server.js — سيرفر معاينة على :3000 (بيحاكي Cloudflare)
node --check <file.js> # فحص syntax لأي ملف JS
```
- **فحص السكربتات الداخلية في HTML**: `new Function(scriptText)` جوه Node لكل صفحة.
- **فحص توازن CSS**: عدّ `{` مقابل `}`.
- بعد أي تعديل: شغّل الـ dev server واعمل smoke test بـ curl على المسارات (`/`, `/shop`, `/product?id=1`, `/admin`, ...) — لازم 200، و404 لصفحة غير موجودة.
- لو ظهر `EADDRINUSE` على 3000: فيه سيرفر شغال بالفعل، استخدمه بدل ما تشغّل تاني.

## خريطة الملفات
```
public/
  index·shop·product·cart·checkout·track·success·404.html   # المتجر (كل صفحة سكربت inline + استدعاء الطبقات)
  css/store.css                 # تصميم المتجر كامل (~810 سطر)
  js/firebase-config.js         # إعدادات Firebase (قيم عامة بطبيعتها)
  js/firebase.js  → window.MDB  # طبقة Firestore/Storage + الكاش + bindImg (346 سطر)
  js/store.js     → API, Cart, renderChrome, productCard, syncCart   (346 سطر)
  admin/*.html                  # لوحة التحكم (index·orders·products·categories·settings·login·setup)
  admin/pos·pos-history·pos-shifts·pos-reports.html   # نظام الكاشير (مبيعات المحل)
  admin/purchases·suppliers·treasuries·customers·cheques·company-assets·personal·balances.html  # نظام الحسابات
  admin/inventory·stocktake.html # المخازن: تقرير حركة كل منتج (اشترينا/بعنا/مرتجع/تالف/راكد) + الجرد الفعلي
  admin/crm.html                # تجميع كل العملاء (موقع+محل+آجل) + رسايل واتساب/SMS جماعية
  admin/accounts.html           # حسابات الفريق والصلاحيات (للـowner فقط)
  admin/assets/admin.js → AdminAPI  # نفس فكرة API بس للأدمن + Auth + صلاحيات (myProfile/hasPerm/requirePerm + PAGE_PERM + SIZES_STD)
  admin/assets/pos.js → PosAPI  # طبقة الكاشير: ورديات/مبيعات/مرتجعات + طابور أوفلاين + فواتير 80mm
  admin/assets/acc.js → AccAPI  # طبقة الحسابات: موردين/مشتريات/خزن/عملاء آجل/شيكات/أصول/يوميات/تالف/جرد
  admin/assets/barcode.js       # Code128 SVG + genBarcode + printDoc(iframe) + ليبل 40×25mm + بوليصة شحن 100×150mm
  admin/assets/admin.css        # تصميم اللوحة (~نفس هوية المتجر)
  admin/assets/pos.css          # تصميم شاشة الكاشير + طباعة حرارية 80mm
  admin/assets/charts.js        # رسوم SVG بسيطة (lineChart, hBars, dataTable)
  pos-sw.js · pos-manifest.json # Service Worker (نطاق /admin/) + PWA — كاشير شغال أوفلاين
  admin/assets/seed-data.js     # ⚠️ 2600 سطر — ماتقراهوش كامل، اعرف شكله من الوصف تحت بس
  images/products/*.jpeg         # صور المنتجات — ⚠️ ماتلمسهاش
  images/logo.jpeg · favicon.svg
firestore.rules · storage.rules · firebase.json · scripts/dev-server.js · SETUP.md
```

## المعمار المفتاحي (مهم تفهمه قبل ما تعدّل)
- **راوتر بدل REST**: `API` (store.js) و `AdminAPI` (admin.js) بيحاكوا مسارات `/api/...` القديمة بس بينفّذوها على Firestore عبر `MDB`. فمنطق الصفحات ما اتغيرش عند التحويل من Express.
- **MDB** (`window.MDB` في firebase.js): `fb()`/`fbAuth()`/`fbStorage()` بيحمّلوا SDK ديناميكيًا من gstatic CDN (v11.0.2). فيه `getStoreInfo/getProducts/getProduct/createOrder/trackOrder/bindImg/nice/once/cacheClear`.
- **الكاش (توفير قراءات — لا تكسره)**:
  - المتجر: `localStorage` بمفتاح `mnc1:` TTL **10 دقايق** (دالة `once`) + فولباك للنسخة القديمة لو الشبكة فصلت.
  - الأدمن: `sessionStorage` بمفتاح `adm1:` TTL **90 ثانية** (دالة `cached`)، و`fetchOrders` بحد `limit(400)`.
  - أي تعديل أدمن بينده `invalidate()` اللي بيصفّي كاش الأدمن + `MDB.cacheClear()` (كاش المتجر) → التغييرات تبان فورًا.
  - **إنشاء الطلب بيقرأ المنتجات طازة من القاعدة دايمًا** (مش من الكاش) — أمان السعر/المخزون.
- **الصور**: الجديدة بترفع على **Firebase Storage** (bucket `manova-store.firebasestorage.app`, مسار `products/`) و`product.images[]` بيخزّن رابط https مباشر. `bindImg(el, ref, fallback)` بيعرض: رابط https/محلي مباشرة، أو `img:<id>` قديم من Firestore (توافق فقط، مفيش داتا فيه)، وفيه فولباك `onerror`.
- **المخزون**: بيتخصم عند **تأكيد** الطلب من اللوحة (COUNTED = confirmed/shipped/delivered) داخل `runTransaction`، وبيرجع عند الإلغاء. العميل ما بيلمسوش.
- **الخطوط**: `Almarai` (عربي) + `Marcellus` (لاتيني للشعار/الأكواد) — في المتجر واللوحة. كلاس `.latin`.
- **أنيميشن الظهور**: كلاس `.rv` + `revealScan()` (IntersectionObserver).
- **صور الكوفرات في index.html**: `CURATED_COVERS` + كلاس `.crop-tr` (قص كولاج البراند) — فولباك بس، الأولوية لصور الأقسام من الإعدادات ثم أول منتج.
- **القائمة المنبثقة (Mega Menu)**: `renderChrome` في store.js بيبني قائمة الديسكتوب من `s.categoriesTree` (أقسام رئيسية)؛ القسم اللي له فروع بيبقى `.nav-item.has-mega` وجواه لوحة `.mega` (فرعية + صورة القسم + CTA) بتظهر بنيّة الهوفر (hover intent + `.mega-veil`). الموبايل أكورديون `.m-acc`. كل الأنيميشن في store.css (clip-path + stagger). صورة اللوحة = غلاف القسم (يتخصّص من الإعدادات).
- **صور وبانرات الموقع كلها من الإعدادات**: `settings/store` بيخزن `heroImage`, `heroTag`, `editorialImage/Kicker/Title/Body`, و`categoryImages: {slug:url}`. `getStoreInfo` بيرجّعها وبيحسب `cover` لكل قسم (categoryImages ← أول منتج بالقسم أو فروعه). صفحة الإعدادات فيها مكوّن `buildImgSet` عام (معاينة/رفع/مسح) للهيرو والبانر وصورة كل قسم (بتظهر تلقائيًا لأي قسم جديد).
- **الكاشير (POS)**: `PosAPI` (admin/assets/pos.js) — كل عملية (بيع/مرتجع/وردية) بتدخل طابور outbox في `localStorage` (`pos1:queue`) وبتتنفذ بالترتيب على Firestore عبر `runTransaction` (خصم/إرجاع مخزون فوري) — فالبيع شغال أوفلاين بالكامل والمزامنة تلقائية عند رجوع النت. الوردية المفتوحة محلية (`pos1:shift`) وبتتكتب merge في `pos_shifts` مع كل تغيير (عمليات الوردية بتتدمج في الطابور — coalesce). كتالوج المنتجات متكاش في `pos1:catalog` (TTL 5 دقايق + فولباك stale). مبيعات المحل منفصلة عن طلبات الموقع (`pos_sales` vs `orders`) لكن المخزون مشترك. المنتج فيه حقلين اختياريين للكاشير: `barcode` (مسح السكانر) و`cost` (تقارير الربح). الفواتير بتتطبع 80mm عبر `#receipt-area` + كلاس `print-receipt`.
- **المقاسات والمخزون**: المنتج بمقاسات قياسية (`SIZES_STD` = XS→7XL) بيتتبع مخزونه **لكل مقاس** في `sizeStock: {M:5,...}` و`stock` = المجموع، وسعر مختلف لمقاس في `sizePrices` (اختياري). كل تعديل مخزون في أي طبقة بيمر على `MDB.stockPatch(pdata, size, delta)` — متستخدمش stock مباشرة. `MDB.sizePrice/sizeAvail` للعرض والتحقق. المنتج ممكن يظهر في أكتر من قسم (`extraCategories`). الباركود بيتولد تلقائي (`genBarcode()`) لو فاضي.
- **الصلاحيات**: `admins/{uid}` فيه `role` (owner/staff) و`perms` — `renderShell` بيخفي اللينكات وبيطرد من الصفحات الممنوعة حسب `PAGE_PERM` (حماية واجهة تنظيمية، القواعد بتسمح لأي أدمن نشط). إنشاء حساب جديد بيتم بتطبيق Firebase ثانوي في `accounts.html`. صلاحية `pos_history_full` غيابها = الكاشير يفتح فاتورة بكودها بس.
- **التتبع**: بكود الطلب **أو** رقم الموبايل (فهرس `order_index/{phone}` بيتكتب مع إنشاء الطلب — الطلبات القديمة قبل الفهرس بتتجاب بالكود بس).
- **الطباعة**: 3 مقاسات — فاتورة 80mm (print-receipt في pos.css)، ليبل باركود 40×25mm، بوليصة شحن 100×150mm. الليبل والبوليصة عبر `printDoc` (iframe معزول بـ@page خاص) في barcode.js.
- **الحسابات (AccAPI)**: كل حركة فلوس بتعدي على خزنة (`treasuries` — فيه `main` بيتنشأ تلقائيًا) وبتتسجل قيد في دفتر اليومية `finance_log` (مبلغ بإشارة ± + kind) جوه نفس الـ transaction اللي بتعدّل الأرصدة. **فواتير الشراء** (`purchases`) هي اللي بتزوّد المخزون وبتحدّث `cost` (اتلغى تعديل المخزون اليدوي من صفحة المنتجات، وممكن إنشاء منتج جديد من جوه الفاتورة) والمتبقي بيزيد رصيد المورد. **البيع الآجل من الكاشير** (زرار «آجل») بيسجّل على `customers` (بينشأ العميل من الكاشير لو جديد — شغال أوفلاين عبر الطابور)، ومبيعات الكاشير غير الآجلة بتضيف للخزنة `main` + قيد `pos_sale` تلقائيًا. **الشيكات** (`cheques`) بتتصرف تلقائيًا لما معادها يعدي عبر `processDueCheques()` اللي بيتنده مع فتح أي صفحة حسابات. **الأقسام بقت رئيسي/فرعي** (حقل `parent` في `categories`، والمنتج فيه `categoryMain`) — المتجر لسه بيعرضها flat. صافي الأرصدة = (بضاعة بالتكلفة + خزن + عملاء آجل + أصول) − آجل موردين.

## Firestore/Storage
- Collections: `settings/store` (دوك واحد) · `products` · `categories` (id=slug, فيه `parent`) · `orders` (id=`MN-XXXXXX`) · `order_index/{phone}` (أكواد طلبات الرقم — عام) · `admins/{uid}` (فيه role/perms) · `images` (قديمة) · `pos_sales` · `pos_shifts` · `suppliers` · `purchases` · `treasuries` · `customers` · `cheques` · `assets` · `personal` · `finance_log` · `stock_moves` (تالف) · `stocktakes` (جردات).
- **seed-data.js** = `window.MANOVA_SEED = { settings, categories:[{id,data}], products:[{id,data}], orders:[{id,data}] }` (14 منتج، قسمين، 49 طلب تجريبي). للاستيراد مرة واحدة من `/admin/setup`.
- **أدمن حالي**: `manova@manova.com` / `manova` (UID `mo0rnzVOOphqDOmxZqovTnvA04L2`) موجود في `admins` بـ role=owner.
- **⚠️ قواعد Firestore/Storage لسه كلها `true` للتجربة** — لازم تُنشر `firestore.rules` + `storage.rules` من Firebase Console قبل مشاركة الرابط. الأدمن دوك موجود فالقواعد الحقيقية هتسيبه يدير عادي.
- إعدادات `firebase-config.js` **عامة بطبيعتها** (بتتبعت لأي زائر) — الحماية في القواعد مش في إخفاء الكونفيج.

## ممنوعات
- **ماترفعش** `data-backup-db.json` (فيه بيانات عملاء + هاش باسورد قديم) — gitignored.
- **ماتعدّلش** صور المنتجات في `images/products/`.
- **ماتقراش** `seed-data.js` كامل (2600 سطر) — الوصف فوق كافي.
- ماتكسرش طبقة الكاش (mnc1/adm1) ولا تخلي إنشاء الطلب يقرا من الكاش.

## Git / النشر
- الفرع: `main`. Commit/push بس لما أحمد يطلب.
- Cloudflare Pages: **Build output directory = `public`** (خطأ شائع لو اتساب فاضي بيطلّع 404).
- تفاصيل الإعداد الكامل في `SETUP.md`.

## ذاكرة إضافية
سجل القرارات والتاريخ في `~/.claude/projects/.../memory/manova-brand-context.md` (بيتحمّل تلقائيًا). حدّثه لما يحصل قرار جديد مش واضح من الكود.
