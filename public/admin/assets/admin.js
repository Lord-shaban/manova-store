/* MANOVA لوحة التحكم — منطق مشترك
   AdminAPI بيتوجه مباشرة لـ Firestore + Firebase Auth (عبر طبقة MDB في js/firebase.js)
   بنفس مسارات الـ API القديمة، فمنطق الصفحات نفسه ما اتغيرش. */
const AdminAPI = (() => {
  const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
  // الحالات اللي المخزون بيكون مخصوم فيها — الخصم بيحصل عند تأكيد الطلب (مش عند إنشائه)
  const COUNTED = ['confirmed', 'shipped', 'delivered'];

  /* ---------- الجلسة ---------- */
  async function currentUser() {
    const { auth, authM } = await MDB.fbAuth();
    if (auth.currentUser) return auth.currentUser;
    return new Promise(resolve => {
      const un = authM.onAuthStateChanged(auth, u => { un(); resolve(u); });
    });
  }

  async function requireUser() {
    let u = null;
    try { u = await currentUser(); }
    catch (e) { throw MDB.nice(e); }
    if (!u) { location.href = '/admin/login'; throw new Error('انتهت الجلسة — سجّل الدخول'); }
    return u;
  }

  async function logout() {
    const { auth, authM } = await MDB.fbAuth();
    await authM.signOut(auth);
    return { ok: true };
  }

  /* ---------- كاش بيانات الأدمن (بيتصفّر بعد أي تعديل) ---------- */
  const cache = {};
  function cached(key, fn) {
    if (!cache[key]) cache[key] = fn().catch(e => { delete cache[key]; throw e; });
    return cache[key];
  }
  function invalidate(...keys) { (keys.length ? keys : Object.keys(cache)).forEach(k => delete cache[k]); }

  async function fetchAllProducts() {
    const { fs, db } = await MDB.fb();
    const snap = await fs.getDocs(fs.collection(db, 'products'));
    return snap.docs.map(MDB.mapProduct)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function fetchCats() {
    const { fs, db } = await MDB.fb();
    const snap = await fs.getDocs(fs.collection(db, 'categories'));
    return snap.docs.map(d => ({ slug: d.id, ...d.data() }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  async function fetchOrders() {
    const { fs, db } = await MDB.fb();
    const snap = await fs.getDocs(fs.query(
      fs.collection(db, 'orders'), fs.orderBy('createdAt', 'desc'), fs.limit(1000)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function fetchSettings() {
    const { fs, db } = await MDB.fb();
    const snap = await fs.getDoc(fs.doc(db, 'settings', 'store'));
    return snap.exists() ? snap.data() : { shipping: [] };
  }

  /* ---------- الطلبات ---------- */
  async function listOrders({ status, q, page }) {
    let list = await cached('orders', fetchOrders);
    if (status && status !== 'all') list = list.filter(o => o.status === status);
    if (q) {
      const needle = String(q).trim();
      const upper = needle.toUpperCase();
      list = list.filter(o => o.id.toUpperCase().includes(upper)
        || (o.customer.name || '').includes(needle)
        || (o.customer.phone || '').includes(needle));
    }
    page = Math.max(1, page || 1);
    const per = 20;
    return {
      total: list.length, page, pages: Math.max(1, Math.ceil(list.length / per)),
      orders: list.slice((page - 1) * per, page * per),
    };
  }

  async function getOrder(id) {
    const orders = await cached('orders', fetchOrders);
    const found = orders.find(x => x.id === id);
    if (found) return found;
    const { fs, db } = await MDB.fb();
    const snap = await fs.getDoc(fs.doc(db, 'orders', id));
    if (!snap.exists()) throw new Error('الطلب غير موجود');
    return { id, ...snap.data() };
  }

  // تغيير حالة الطلب + ضبط المخزون في معاملة واحدة:
  // أول انتقال لحالة مؤكدة يخصم المخزون، والإلغاء (أو الرجوع لـ"جديد") يرجّعه
  async function patchOrder(id, status) {
    if (!ORDER_STATUSES.includes(status)) throw new Error('حالة غير صحيحة');
    const { fs, db } = await MDB.fb();
    const ref = fs.doc(db, 'orders', id);
    const updated = await fs.runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('الطلب غير موجود');
      const o = snap.data();
      if (o.status === status) return { id, ...o };
      const wantApplied = COUNTED.includes(status);
      const items = o.items || [];
      let stocks = null;
      const productRefs = items.map(it => fs.doc(db, 'products', String(it.productId)));
      if (wantApplied !== !!o.stockApplied) {
        stocks = [];
        for (const pr of productRefs) {
          const ps = await tx.get(pr);
          stocks.push(ps.exists() ? (Number(ps.data().stock) || 0) : null);
        }
      }
      const now = new Date().toISOString();
      if (stocks) {
        const dir = wantApplied ? -1 : 1;
        items.forEach((it, i) => {
          if (stocks[i] === null) return;
          tx.update(productRefs[i], { stock: Math.max(0, stocks[i] + dir * it.qty) });
        });
      }
      const patch = {
        status, updatedAt: now,
        statusHistory: [...(o.statusHistory || []), { status, at: now }],
        stockApplied: wantApplied,
      };
      tx.update(ref, patch);
      return { id, ...o, ...patch };
    });
    invalidate('orders', 'products');
    return updated;
  }

  async function clearDemo() {
    await requireUser();
    const { fs, db } = await MDB.fb();
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'orders'), fs.where('demo', '==', true)));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = fs.writeBatch(db);
      docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    invalidate('orders');
    return { ok: true, removed: docs.length };
  }

  /* ---------- المنتجات ---------- */
  function sanitizeProductInput(b, cats) {
    const errors = [];
    const name = String(b.name || '').trim();
    const price = Number(b.price);
    const slugs = cats.map(c => c.slug);
    if (name.length < 3) errors.push('اسم المنتج قصير');
    if (!slugs.includes(b.category)) errors.push('اختر القسم');
    if (!(price > 0)) errors.push('السعر غير صحيح');
    return {
      errors,
      data: {
        name,
        category: b.category,
        description: String(b.description || '').trim(),
        price,
        oldPrice: Math.max(0, Number(b.oldPrice) || 0),
        sizes: Array.isArray(b.sizes) ? b.sizes.map(s => String(s).trim()).filter(Boolean) : [],
        colors: Array.isArray(b.colors) ? b.colors.map(s => String(s).trim()).filter(Boolean) : [],
        images: Array.isArray(b.images)
          ? b.images.filter(u => typeof u === 'string' && (u.startsWith('/') || u.startsWith('http') || u.startsWith('img:')))
          : [],
        stock: Math.max(0, Math.floor(Number(b.stock) || 0)),
        featured: !!b.featured,
        active: b.active !== false,
      },
    };
  }

  async function listProducts() { return cached('products', fetchAllProducts); }

  async function createProduct(b) {
    const cats = await cached('categories', fetchCats);
    const { errors, data } = sanitizeProductInput(b, cats);
    if (errors.length) throw new Error(errors.join(' — '));
    const { fs, db } = await MDB.fb();
    const ref = await fs.addDoc(fs.collection(db, 'products'), { ...data, createdAt: new Date().toISOString() });
    invalidate('products');
    return { id: ref.id, ...data };
  }

  async function updateProduct(id, b) {
    const cats = await cached('categories', fetchCats);
    const { errors, data } = sanitizeProductInput(b, cats);
    if (errors.length) throw new Error(errors.join(' — '));
    const { fs, db } = await MDB.fb();
    await fs.updateDoc(fs.doc(db, 'products', String(id)), data);
    invalidate('products');
    return { id, ...data };
  }

  async function deleteProduct(id) {
    const { fs, db } = await MDB.fb();
    const orders = await cached('orders', fetchOrders);
    const ref = fs.doc(db, 'products', String(id));
    const snap = await fs.getDoc(ref);
    if (!snap.exists()) throw new Error('المنتج غير موجود');
    const hasOrders = orders.some(o => (o.items || []).some(it => String(it.productId) === String(id)));
    if (hasOrders) {
      // أرشفة بدل الحذف للحفاظ على سجل الطلبات
      await fs.updateDoc(ref, { active: false });
      invalidate('products');
      return { ok: true, archived: true };
    }
    const imgs = snap.data().images || [];
    await fs.deleteDoc(ref);
    // تنظيف اختياري لملفات الصور بعد حذف المنتج
    for (const u of imgs) {
      const s = String(u);
      try {
        if (s.includes('firebasestorage.googleapis.com') || s.startsWith('gs://')) {
          const { stM, storage } = await MDB.fbStorage();
          await stM.deleteObject(stM.ref(storage, s));
        } else if (s.startsWith('img:')) {
          await fs.deleteDoc(fs.doc(db, 'images', s.slice(4))); // صور قديمة داخل Firestore
        }
      } catch { /* تنظيف اختياري — نتجاهل أي فشل */ }
    }
    invalidate('products');
    return { ok: true, archived: false };
  }

  /* ---------- الأقسام ---------- */
  // تحويل اسم القسم العربي إلى slug لاتيني نظيف يُستخدم في الروابط
  function slugify(name, existing) {
    const map = {
      'بناطيل': 'pants', 'بنطلون': 'pants', 'كابات': 'caps', 'كاب': 'caps', 'قبعات': 'caps',
      'أحزمة': 'belts', 'حزام': 'belts', 'جزم': 'shoes', 'جزمة': 'shoes', 'أحذية': 'shoes', 'حذاء': 'shoes',
      'تيشرتات': 'tshirts', 'تيشرت': 'tshirts', 'قمصان': 'shirts', 'قميص': 'shirts',
      'جواكت': 'jackets', 'جاكيت': 'jackets', 'هوديز': 'hoodies', 'هودي': 'hoodies',
      'شنط': 'bags', 'شنطة': 'bags', 'اكسسوارات': 'accessories', 'سويت شيرت': 'sweatshirts',
      'بيسيك': 'basic', 'مطبوع': 'printed', 'سادة': 'basic',
    };
    let base = map[String(name).trim()];
    if (!base) {
      base = String(name).trim().toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }
    if (!base) base = 'cat';
    const taken = new Set((existing || []).map(c => c.slug));
    let slug = base, n = 2;
    while (taken.has(slug)) slug = base + '-' + (n++);
    return slug;
  }

  async function listCategories() {
    const [cats, products] = await Promise.all([
      cached('categories', fetchCats),
      cached('products', fetchAllProducts),
    ]);
    return cats.map(c => ({ ...c, count: products.filter(p => p.category === c.slug).length }));
  }

  async function createCategory(b) {
    const cats = await cached('categories', fetchCats);
    const name = String(b.name || '').trim();
    if (name.length < 2) throw new Error('اسم القسم قصير');
    if (cats.some(c => c.name === name)) throw new Error('يوجد قسم بنفس الاسم');
    const slug = slugify(name, cats);
    const order = Math.max(0, ...cats.map(c => c.order || 0)) + 1;
    const cat = { name, subtitle: String(b.subtitle || '').trim(), order, active: true };
    const { fs, db } = await MDB.fb();
    await fs.setDoc(fs.doc(db, 'categories', slug), cat);
    invalidate('categories');
    return { slug, ...cat };
  }

  async function updateCategory(slug, b) {
    const cats = await cached('categories', fetchCats);
    const c = cats.find(x => x.slug === slug);
    if (!c) throw new Error('القسم غير موجود');
    const patch = {};
    if (typeof b.name === 'string' && b.name.trim().length >= 2) {
      if (cats.some(x => x.slug !== slug && x.name === b.name.trim())) throw new Error('يوجد قسم بنفس الاسم');
      patch.name = b.name.trim();
    }
    if (typeof b.subtitle === 'string') patch.subtitle = b.subtitle.trim();
    if (b.active !== undefined) patch.active = !!b.active;
    if (b.order !== undefined) patch.order = Math.max(0, Number(b.order) || 0);
    const { fs, db } = await MDB.fb();
    await fs.updateDoc(fs.doc(db, 'categories', slug), patch);
    invalidate('categories');
    return { ...c, ...patch };
  }

  async function deleteCategory(slug) {
    const products = await cached('products', fetchAllProducts);
    const count = products.filter(p => p.category === slug).length;
    if (count > 0) throw new Error(`لا يمكن حذف القسم لوجود ${count} منتج فيه — انقل المنتجات لقسم آخر أولًا`);
    const { fs, db } = await MDB.fb();
    await fs.deleteDoc(fs.doc(db, 'categories', slug));
    invalidate('categories');
    return { ok: true };
  }

  /* ---------- الإحصائيات ---------- */
  function dayKey(iso) { return String(iso).slice(0, 10); }

  async function stats(days) {
    days = Math.min(365, Math.max(7, days || 30));
    const [orders, products] = await Promise.all([
      cached('orders', fetchOrders),
      cached('products', fetchAllProducts),
    ]);
    const DAY = 24 * 3600 * 1000;
    const todayKey = dayKey(new Date().toISOString());
    const since = Date.now() - (days - 1) * DAY;

    const counted = o => o.status !== 'cancelled'; // المبيعات = كل الطلبات غير الملغية
    const inRange = orders.filter(o => new Date(o.createdAt).getTime() >= since);

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY).toISOString();
      series.push({ date: dayKey(d), revenue: 0, orders: 0 });
    }
    const byDay = Object.fromEntries(series.map(s => [s.date, s]));
    for (const o of inRange) {
      const k = dayKey(o.createdAt);
      if (byDay[k] && counted(o)) { byDay[k].revenue += o.total; byDay[k].orders += 1; }
    }

    const statusCounts = Object.fromEntries(ORDER_STATUSES.map(s => [s, 0]));
    for (const o of inRange) statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;

    const topMap = {};
    for (const o of inRange) {
      if (!counted(o)) continue;
      for (const it of o.items || []) {
        topMap[it.name] = topMap[it.name] || { name: it.name, qty: 0, revenue: 0 };
        topMap[it.name].qty += it.qty;
        topMap[it.name].revenue += it.qty * it.price;
      }
    }
    const topProducts = Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 6);

    const todayOrders = orders.filter(o => dayKey(o.createdAt) === todayKey && counted(o));
    const rangeOrders = inRange.filter(counted);

    return {
      days,
      tiles: {
        todayRevenue: todayOrders.reduce((s, o) => s + o.total, 0),
        todayOrders: todayOrders.length,
        rangeRevenue: rangeOrders.reduce((s, o) => s + o.total, 0),
        rangeOrders: rangeOrders.length,
        pending: orders.filter(o => o.status === 'new' || o.status === 'confirmed').length,
        lowStock: products.filter(p => p.active && p.stock <= 5).length,
      },
      series, statusCounts, topProducts,
      latestOrders: orders.slice(0, 8)
        .map(o => ({ id: o.id, name: o.customer.name, total: o.total, status: o.status, createdAt: o.createdAt })),
      hasDemo: orders.some(o => o.demo),
    };
  }

  /* ---------- الإعدادات وكلمة المرور ---------- */
  async function getSettings() { return cached('settings', fetchSettings); }

  async function putSettings(b) {
    const s = { ...(await cached('settings', fetchSettings)) };
    const strFields = ['storeName', 'slogan', 'heroTitle', 'heroSubtitle', 'announcement',
      'phone', 'whatsapp', 'address', 'facebook', 'instagram', 'tiktok', 'walletNumber'];
    for (const f of strFields) if (typeof b[f] === 'string') s[f] = b[f].trim();
    if (Array.isArray(b.shipping)) {
      const zones = b.shipping
        .map(z => ({ name: String(z.name || '').trim(), fee: Math.max(0, Number(z.fee) || 0) }))
        .filter(z => z.name);
      if (zones.length) s.shipping = zones;
    }
    if (b.freeShippingOver !== undefined) s.freeShippingOver = Math.max(0, Number(b.freeShippingOver) || 0);
    const { fs, db } = await MDB.fb();
    await fs.setDoc(fs.doc(db, 'settings', 'store'), s);
    invalidate('settings');
    return s;
  }

  async function changePassword(current, next) {
    const u = await requireUser();
    if (String(next || '').length < 6) throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف');
    const { auth, authM } = await MDB.fbAuth();
    const cred = authM.EmailAuthProvider.credential(u.email, String(current || ''));
    try { await authM.reauthenticateWithCredential(u, cred); }
    catch { throw new Error('كلمة المرور الحالية غير صحيحة'); }
    await authM.updatePassword(u, String(next));
    await authM.signOut(auth);
    return { ok: true };
  }

  /* ---------- رفع الصور ----------
     الصور بتتضغط في المتصفح (WebP حتى ~900px) وبعدين بتترفع على Firebase Storage،
     والمنتج بيخزّن رابط التحميل المباشر (https). */
  function canvasToBlob(canvas, type, q) {
    return new Promise(res => canvas.toBlob(b => res(b), type, q));
  }

  async function compressImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('تعذر قراءة الصورة — استخدم JPG أو PNG أو WEBP'));
        i.src = url;
      });
      const canvas = document.createElement('canvas');
      for (const [dim, q] of [[1000, 0.85], [900, 0.8], [800, 0.72], [640, 0.6]]) {
        const scale = Math.min(1, dim / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let blob = await canvasToBlob(canvas, 'image/webp', q);
        let type = 'image/webp';
        if (!blob || blob.type !== 'image/webp') { // متصفحات من غير WebP (سفاري قديم)
          blob = await canvasToBlob(canvas, 'image/jpeg', q);
          type = 'image/jpeg';
        }
        if (blob && blob.size <= 800 * 1024) return { blob, type };
      }
      throw new Error('الصورة كبيرة جدًا حتى بعد الضغط — جرّب صورة أصغر');
    } finally { URL.revokeObjectURL(url); }
  }

  async function upload(files) {
    await requireUser();
    const list = [...files].slice(0, 6);
    const ok = ['.jpg', '.jpeg', '.png', '.webp'];
    const { stM, storage } = await MDB.fbStorage();
    const urls = [];
    for (const f of list) {
      const ext = ('.' + (f.name.split('.').pop() || '')).toLowerCase();
      if (!ok.includes(ext)) throw new Error('نوع الملف غير مدعوم — استخدم JPG أو PNG أو WEBP');
      const { blob, type } = await compressImage(f);
      const fileExt = type === 'image/webp' ? 'webp' : 'jpg';
      const rnd = Math.random().toString(36).slice(2, 8);
      const r = stM.ref(storage, `products/${Date.now()}-${rnd}.${fileExt}`);
      await stM.uploadBytes(r, blob, { contentType: type, cacheControl: 'public,max-age=31536000' });
      urls.push(await stM.getDownloadURL(r));
    }
    return urls;
  }

  /* ---------- الراوتر: نفس مسارات الـ API القديمة ---------- */
  async function route(method, url, body) {
    const u = new URL(url, location.origin);
    const p = u.pathname, q = u.searchParams;
    const seg = p.split('/').filter(Boolean); // مثال: ['api','admin','orders','MN-XXXXXX']
    try {
      if (p === '/api/admin/logout') return await logout();
      await requireUser();
      if (p === '/api/admin/stats') return await stats(Number(q.get('days')) || 30);
      if (p === '/api/admin/orders' && method === 'GET') {
        return await listOrders({ status: q.get('status') || 'all', q: q.get('q') || '', page: Number(q.get('page')) || 1 });
      }
      if (seg[2] === 'orders' && seg[3] && method === 'GET') return await getOrder(decodeURIComponent(seg[3]));
      if (seg[2] === 'orders' && seg[3] && method === 'PATCH') return await patchOrder(decodeURIComponent(seg[3]), (body || {}).status);
      if (p === '/api/admin/products' && method === 'GET') return await listProducts();
      if (p === '/api/admin/products' && method === 'POST') return await createProduct(body || {});
      if (seg[2] === 'products' && seg[3] && method === 'PUT') return await updateProduct(decodeURIComponent(seg[3]), body || {});
      if (seg[2] === 'products' && seg[3] && method === 'DELETE') return await deleteProduct(decodeURIComponent(seg[3]));
      if (p === '/api/admin/categories' && method === 'GET') return await listCategories();
      if (p === '/api/admin/categories' && method === 'POST') return await createCategory(body || {});
      if (seg[2] === 'categories' && seg[3] && method === 'PUT') return await updateCategory(decodeURIComponent(seg[3]), body || {});
      if (seg[2] === 'categories' && seg[3] && method === 'DELETE') return await deleteCategory(decodeURIComponent(seg[3]));
      if (p === '/api/admin/settings' && method === 'GET') return await getSettings();
      if (p === '/api/admin/settings' && method === 'PUT') return await putSettings(body || {});
      if (p === '/api/admin/password') return await changePassword((body || {}).current, (body || {}).next);
      if (p === '/api/admin/clear-demo') return await clearDemo();
      throw new Error('حدث خطأ');
    } catch (e) { throw MDB.nice(e); }
  }

  return {
    req: route,
    get(u) { return route('GET', u); },
    post(u, b) { return route('POST', u, b); },
    put(u, b) { return route('PUT', u, b); },
    patch(u, b) { return route('PATCH', u, b); },
    del(u) { return route('DELETE', u); },
    upload,
    requireUser, currentUser, invalidate,
  };
})();

function money(n) { return Number(n || 0).toLocaleString('en-EG') + ' ج.م'; }
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function fmtDay(iso) {
  return new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

const STATUS = {
  new: { label: 'جديد', color: '#2a78d6' },
  confirmed: { label: 'مؤكد', color: '#a06e00' },
  shipped: { label: 'جاري الشحن', color: '#4a3aa7' },
  delivered: { label: 'تم التوصيل', color: '#0ca30c' },
  cancelled: { label: 'ملغي', color: '#d03b3b' },
};
function statusChip(s) {
  const m = STATUS[s] || { label: s };
  return `<span class="chip ${s}">${m.label}</span>`;
}

function toast(msg, type = 'success') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 320); }, 2800);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

/* أيقونات SVG (خط رفيع) */
const NAV_ICONS = {
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="5"/><rect x="13" y="10" width="8" height="11"/><rect x="3" y="13" width="8" height="8"/></svg>',
  orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7l8-4 8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>',
  products: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4L4 7l2 4 2-1v10h8V10l2 1 2-4-5-3a3 3 0 0 1-6 0z"/></svg>',
  categories: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>',
};

/* الهيكل: السايدبار والتوب بار */
function renderShell(active, title) {
  const shell = document.getElementById('shell');
  shell.innerHTML = `
  <div class="layout">
    <div class="sb-overlay"></div>
    <aside class="sidebar">
      <div class="sb-brand">
        <div><b>MANOVA</b><small>لوحة التحكم</small></div>
      </div>
      <nav class="sb-nav">
        <a href="/admin" data-k="dash"><span class="n-icon">${NAV_ICONS.dash}</span> نظرة عامة</a>
        <a href="/admin/orders" data-k="orders"><span class="n-icon">${NAV_ICONS.orders}</span> الطلبات <span class="badge" id="pending-badge"></span></a>
        <a href="/admin/products" data-k="products"><span class="n-icon">${NAV_ICONS.products}</span> المنتجات</a>
        <a href="/admin/categories" data-k="categories"><span class="n-icon">${NAV_ICONS.categories}</span> الأقسام</a>
        <a href="/admin/settings" data-k="settings"><span class="n-icon">${NAV_ICONS.settings}</span> الإعدادات</a>
      </nav>
      <div class="sb-foot">MANOVA © ${new Date().getFullYear()}<br>TO BE A NEW MAN</div>
    </aside>
    <div class="main">
      <div class="topbar">
        <button class="burger-admin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="width:18px;height:18px"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
        <h1>${title}</h1>
        <div class="grow"></div>
        <a class="tb-link" href="/" target="_blank">عرض المتجر</a>
        <button class="tb-link" id="logout-btn">تسجيل الخروج</button>
      </div>
      <div class="content" id="content"></div>
    </div>
  </div>`;
  shell.querySelector(`[data-k="${active}"]`)?.classList.add('active');
  shell.querySelector('#logout-btn').addEventListener('click', async () => {
    await AdminAPI.post('/api/admin/logout', {});
    location.href = '/admin/login';
  });
  const sb = shell.querySelector('.sidebar');
  const ov = shell.querySelector('.sb-overlay');
  shell.querySelector('.burger-admin').addEventListener('click', () => { sb.classList.add('open'); ov.classList.add('show'); });
  ov.addEventListener('click', () => { sb.classList.remove('open'); ov.classList.remove('show'); });
  refreshPendingBadge();
  return document.getElementById('content');
}

async function refreshPendingBadge() {
  try {
    const d = await AdminAPI.get('/api/admin/orders?status=new');
    const b = document.getElementById('pending-badge');
    if (b && d.total > 0) { b.style.display = 'inline-flex'; b.textContent = d.total; }
  } catch { /* تجاهل */ }
}

/* مودال عام */
function openModal({ title, bodyHTML, wide = false, footHTML = '' }) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay show';
  ov.id = 'modal';
  ov.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><h3>${title}</h3><button class="modal-close">✕</button></div>
      <div class="modal-body">${bodyHTML}</div>
      ${footHTML ? `<div class="modal-foot">${footHTML}</div>` : ''}
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('.modal-close').addEventListener('click', closeModal);
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  return ov;
}
function closeModal() { document.getElementById('modal')?.remove(); }
