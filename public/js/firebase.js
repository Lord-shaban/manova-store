/*
  MANOVA — طبقة الاتصال بـ Firebase (Firestore)
  تُستخدم في المتجر ولوحة التحكم. الـ SDK يتحمّل ديناميكيًا من CDN جوجل
  فلا حاجة لأي خطوة build — الموقع كله ملفات ثابتة تصلح لأي استضافة مجانية.
*/
window.MDB = (() => {
  const CDN = 'https://www.gstatic.com/firebasejs/11.0.2/';

  /* ---------- تحميل الـ SDK ---------- */
  function configured() {
    const c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.projectId && !String(c.apiKey).includes('ضع'));
  }

  let _fb = null;
  function fb() {
    if (!_fb) {
      _fb = (async () => {
        if (!configured()) {
          throw new Error('لم يتم ضبط إعدادات Firebase — افتح js/firebase-config.js والصق بيانات مشروعك (الخطوات في SETUP.md)');
        }
        const [appM, fsM] = await Promise.all([
          import(CDN + 'firebase-app.js'),
          import(CDN + 'firebase-firestore.js'),
        ]);
        const app = appM.getApps().length ? appM.getApp() : appM.initializeApp(window.FIREBASE_CONFIG);
        return { app, fs: fsM, db: fsM.getFirestore(app) };
      })();
      _fb.catch(() => { _fb = null; });
    }
    return _fb;
  }

  let _auth = null;
  function fbAuth() {
    if (!_auth) {
      _auth = (async () => {
        const { app } = await fb();
        const authM = await import(CDN + 'firebase-auth.js');
        return { authM, auth: authM.getAuth(app) };
      })();
      _auth.catch(() => { _auth = null; });
    }
    return _auth;
  }

  let _storage = null;
  function fbStorage() {
    if (!_storage) {
      _storage = (async () => {
        const { app } = await fb();
        const stM = await import(CDN + 'firebase-storage.js');
        return { stM, storage: stM.getStorage(app) };
      })();
      _storage.catch(() => { _storage = null; });
    }
    return _storage;
  }

  /* ---------- ترجمة أخطاء Firebase لرسائل مفهومة ---------- */
  function nice(e) {
    const code = (e && e.code) || '';
    if (code === 'permission-denied') return new Error('غير مصرح — سجّل الدخول وتأكد أن حسابك مضاف في مجموعة admins (راجع SETUP.md)');
    if (code === 'unavailable') return new Error('تعذر الاتصال بقاعدة البيانات — تأكد من الإنترنت وحاول تاني');
    if (code === 'resource-exhausted') return new Error('تم تجاوز الحد المجاني اليومي لقاعدة البيانات — حاول لاحقًا');
    if (e instanceof Error && e.message) return e;
    return new Error('حدث خطأ، حاول مرة أخرى');
  }

  /* ---------- كاش القراءات (طبقتان) ----------
     1) memo: لكل تحميل صفحة — يمنع تكرار نفس القراءة في الصفحة الواحدة.
     2) localStorage بمدة صلاحية (TTL): التنقل بين الصفحات أو الزيارة المتكررة
        خلال الدقائق دي = صفر قراءات من Firestore.
     ملاحظات أمان: إنشاء الطلب بيقرأ المنتجات طازة من القاعدة دايمًا (مش من
     الكاش)، فمفيش خطر بيع بكميات قديمة. ولوحة التحكم بتصفّر الكاش ده بعد
     أي تعديل عشان التغييرات تظهر فورًا عند صاحب المتجر. */
  const memo = {};
  const CACHE_PREFIX = 'mnc1:';
  const CACHE_TTL = 10 * 60 * 1000; // 10 دقائق
  function cacheGet(key, allowStale) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const { t, d } = JSON.parse(raw);
      if (!allowStale && (!t || Date.now() - t > CACHE_TTL)) return null;
      return d;
    } catch { return null; }
  }
  function cachePut(key, data) {
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), d: data })); }
    catch { /* المساحة ممتلئة — نكمل من غير كاش */ }
  }
  function cacheClear() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k));
    } catch { /* تجاهل */ }
  }
  function once(key, fn) {
    if (!memo[key]) {
      memo[key] = (async () => {
        const hit = cacheGet(key);
        if (hit !== null) return hit;
        try {
          const fresh = await fn();
          cachePut(key, fresh);
          return fresh;
        } catch (e) {
          // النت فصل أو القاعدة مش متاحة؟ نسخة قديمة أفضل من صفحة فاضية
          const stale = cacheGet(key, true);
          if (stale !== null) return stale;
          throw e;
        }
      })().catch(e => { delete memo[key]; throw e; });
    }
    return memo[key];
  }

  /* ---------- جلب البيانات الأساسية ---------- */
  async function fetchSettings() {
    const { fs, db } = await fb();
    const snap = await fs.getDoc(fs.doc(db, 'settings', 'store'));
    if (!snap.exists()) throw new Error('المتجر غير مجهز بعد — افتح /admin/setup وجهّز البيانات الأولية');
    return snap.data();
  }

  async function fetchCategories() {
    const { fs, db } = await fb();
    const snap = await fs.getDocs(fs.collection(db, 'categories'));
    return snap.docs
      .map(d => ({ slug: d.id, ...d.data() }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function mapProduct(d) {
    const p = d.data();
    return {
      id: d.id,
      name: p.name || '',
      category: p.category || '',
      categoryMain: p.categoryMain || '',  // القسم الرئيسي لو category قسم فرعي
      description: p.description || '',
      price: Number(p.price) || 0,
      oldPrice: Number(p.oldPrice) || 0,
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      colors: Array.isArray(p.colors) ? p.colors : [],
      images: Array.isArray(p.images) ? p.images : [],
      stock: Number(p.stock) || 0,
      barcode: String(p.barcode || ''),   // للكاشير (POS) — البحث بمسح السكانر
      cost: Number(p.cost) || 0,          // سعر التكلفة — تقارير ربح المحل فقط
      featured: !!p.featured,
      active: p.active !== false,
      createdAt: p.createdAt || '',
      inStock: (Number(p.stock) || 0) > 0,
    };
  }

  async function fetchActiveProducts() {
    const { fs, db } = await fb();
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'products'), fs.where('active', '==', true)));
    return snap.docs.map(mapProduct);
  }

  /* ---------- API المتجر ---------- */
  async function getStoreInfo() {
    const [settings, categories, products] = await Promise.all([
      once('settings', fetchSettings),
      once('categories', fetchCategories),
      once('products', fetchActiveProducts),
    ]);
    const cats = categories.filter(c => c.active !== false).map(c => {
      const inCat = products.filter(p => p.category === c.slug);
      const cover = inCat.find(p => p.images[0]);
      return { slug: c.slug, name: c.name, subtitle: c.subtitle || '', cover: cover ? cover.images[0] : '', count: inCat.length };
    });
    const s = settings;
    return {
      storeName: s.storeName, slogan: s.slogan, heroTitle: s.heroTitle, heroSubtitle: s.heroSubtitle,
      announcement: s.announcement, phone: s.phone, whatsapp: s.whatsapp, address: s.address,
      facebook: s.facebook, instagram: s.instagram, tiktok: s.tiktok,
      shipping: s.shipping || [], freeShippingOver: s.freeShippingOver || 0, walletNumber: s.walletNumber,
      categories: cats,
    };
  }

  async function getProducts({ category, q, sort, featured } = {}) {
    let list = await once('products', fetchActiveProducts);
    if (category && category !== 'all') list = list.filter(p => p.category === category);
    if (featured === '1' || featured === true) list = list.filter(p => p.featured);
    if (q) {
      const needle = String(q).trim();
      list = list.filter(p => p.name.includes(needle) || p.description.includes(needle));
    }
    if (sort === 'price_asc') list = [...list].sort((a, b) => a.price - b.price);
    else if (sort === 'price_desc') list = [...list].sort((a, b) => b.price - a.price);
    else list = [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  async function getProduct(id) {
    const products = await once('products', fetchActiveProducts);
    const p = products.find(x => x.id === String(id));
    if (!p) throw new Error('المنتج غير موجود');
    const related = products.filter(x => x.id !== p.id && x.category === p.category).slice(0, 4);
    return { product: p, related };
  }

  /* ---------- إنشاء الطلبات ----------
     الأسعار تُحسب من بيانات المنتجات الحالية في القاعدة (ليس من السلة)،
     والمخزون يُخصم عند تأكيد الطلب من لوحة التحكم — مش عند الإنشاء. */
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function orderCode() {
    let s = '';
    const rnd = new Uint32Array(6);
    crypto.getRandomValues(rnd);
    for (let i = 0; i < 6; i++) s += CODE_CHARS[rnd[i] % CODE_CHARS.length];
    return 'MN-' + s;
  }

  async function createOrder(body) {
    const { fs, db } = await fb();
    const b = body || {};
    const c = b.customer || {};
    if (!c.name || String(c.name).trim().length < 3) throw new Error('اكتب الاسم بالكامل');
    if (!/^01[0125][0-9]{8}$/.test(String(c.phone || '').trim())) throw new Error('رقم الموبايل غير صحيح (11 رقم يبدأ بـ 01)');
    if (!c.address || String(c.address).trim().length < 5) throw new Error('اكتب العنوان بالتفصيل');
    const settings = await once('settings', fetchSettings);
    const zone = (settings.shipping || []).find(z => z.name === c.zone);
    if (!zone) throw new Error('اختر منطقة التوصيل');
    if (!Array.isArray(b.items) || b.items.length === 0) throw new Error('السلة فارغة');
    const payment = b.payment === 'wallet' ? 'wallet' : 'cod';

    // نجيب كل منتجات السلة طازة من القاعدة بالتوازي (أسرع) للتحقق من السعر والمخزون
    const snaps = await Promise.all(
      b.items.map(it => fs.getDoc(fs.doc(db, 'products', String(it.id)))));
    const items = [];
    for (let i = 0; i < b.items.length; i++) {
      const it = b.items[i], snap = snaps[i];
      if (!snap.exists() || snap.data().active === false) throw new Error('منتج في السلة لم يعد متاحًا — حدّث السلة');
      const p = mapProduct(snap);
      const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
      if (p.stock < qty) throw new Error(`الكمية المتاحة من "${p.name}" هي ${p.stock} فقط`);
      if (p.sizes.length && !p.sizes.includes(String(it.size))) throw new Error(`اختر مقاس "${p.name}"`);
      items.push({
        productId: p.id, name: p.name, price: p.price, image: p.images[0] || '',
        size: String(it.size || ''), color: String(it.color || p.colors[0] || ''), qty,
      });
    }

    const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    const free = settings.freeShippingOver > 0 && subtotal >= settings.freeShippingOver;
    const shippingFee = free ? 0 : zone.fee;
    const now = new Date().toISOString();
    const order = {
      customer: {
        name: String(c.name).trim(), phone: String(c.phone).trim(),
        address: String(c.address).trim(), zone: zone.name,
        notes: String(c.notes || '').trim().slice(0, 500),
      },
      payment, items, subtotal, shippingFee, total: subtotal + shippingFee,
      status: 'new', createdAt: now, updatedAt: now,
      statusHistory: [{ status: 'new', at: now }],
      demo: false, stockApplied: false,
    };

    // الكود عشوائي — لو حصل تصادم نادر مع كود موجود، القواعد بترفض التعديل فنجرب كود جديد
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = orderCode();
      try {
        await fs.setDoc(fs.doc(db, 'orders', code), order);
        return { ok: true, orderId: code, total: order.total };
      } catch (e) { lastErr = e; }
    }
    throw nice(lastErr);
  }

  async function trackOrder(code, phone) {
    const { fs, db } = await fb();
    const id = String(code || '').trim().toUpperCase();
    const ph = String(phone || '').trim();
    const fail = () => { throw new Error('لا يوجد طلب بهذا الكود ورقم الموبايل'); };
    if (!id || !ph) fail();
    let snap;
    try { snap = await fs.getDoc(fs.doc(db, 'orders', id)); } catch { fail(); }
    if (!snap.exists()) fail();
    const o = snap.data();
    if (String((o.customer || {}).phone) !== ph) fail();
    return {
      id, status: o.status, createdAt: o.createdAt,
      statusHistory: o.statusHistory || [], items: o.items || [],
      subtotal: o.subtotal, shippingFee: o.shippingFee, total: o.total, zone: (o.customer || {}).zone,
    };
  }

  /* ---------- صور المنتجات ----------
     الصور الجديدة المرفوعة من لوحة التحكم بتترفع على Firebase Storage
     والمنتج بيخزّن رابط التحميل المباشر (https) — فالعرض بيحصل مباشرة.
     ملحوظة: bindImg بيدعم كمان الروابط المحلية (/images/...) والمرجع القديم
     "img:<id>" (صور اتخزنت جوه Firestore قبل التحويل لـ Storage). */
  const IMG_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 5"><rect width="4" height="5" fill="#efece3"/></svg>');
  const imgMem = {};

  async function imgSrc(ref) {
    const r = String(ref || '');
    if (!r.startsWith('img:')) return r;
    const id = r.slice(4);
    if (imgMem[id]) return imgMem[id];
    try {
      const cached = sessionStorage.getItem('mnimg:' + id);
      if (cached) { imgMem[id] = cached; return cached; }
    } catch { /* تجاهل */ }
    const { fs, db } = await fb();
    const snap = await fs.getDoc(fs.doc(db, 'images', id));
    if (!snap.exists()) return IMG_PLACEHOLDER;
    const data = snap.data().data || '';
    imgMem[id] = data;
    try { sessionStorage.setItem('mnimg:' + id, data); }
    catch {
      // مساحة الجلسة اتملت — نظّف كاش الصور وحاول مرة واحدة
      try {
        Object.keys(sessionStorage).filter(k => k.startsWith('mnimg:')).forEach(k => sessionStorage.removeItem(k));
        sessionStorage.setItem('mnimg:' + id, data);
      } catch { /* تجاهل */ }
    }
    return data;
  }

  function bindImg(el, ref, fallback) {
    if (!el) return;
    const r = String(ref || fallback || '');
    // لو الرابط نفسه فشل في التحميل (صورة محذوفة/رابط بايظ) نعرض البديل بدل أيقونة مكسورة
    el.onerror = () => {
      el.onerror = null;
      el.src = fallback && el.src !== fallback ? fallback : IMG_PLACEHOLDER;
    };
    if (!r.startsWith('img:')) { el.src = r || fallback || IMG_PLACEHOLDER; return; }
    el.src = IMG_PLACEHOLDER;
    imgSrc(r)
      .then(u => { el.src = u || fallback || IMG_PLACEHOLDER; })
      .catch(() => { el.src = fallback || IMG_PLACEHOLDER; });
  }

  return {
    fb, fbAuth, fbStorage, configured, nice, once, cacheClear,
    getStoreInfo, getProducts, getProduct, createOrder, trackOrder,
    imgSrc, bindImg, IMG_PLACEHOLDER, mapProduct,
  };
})();
