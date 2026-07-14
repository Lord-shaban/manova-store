// MANOVA — سيرفر المتجر ولوحة التحكم
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { load, save, nextId, hashPassword } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin-ui');
// مجلد الصور المرفوعة — قابل للتهيئة ليعيش على قرص دائم في الاستضافة
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json({ limit: '2mb' }));

// ================= أدوات مساعدة =================
const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function getSession(req) {
  const token = getCookie(req, 'manova_admin');
  if (!token) return null;
  const db = load();
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > 30 * 24 * 3600 * 1000) { delete db.sessions[token]; save(); return null; }
  return { token };
}

function requireAdmin(req, res, next) {
  if (!getSession(req)) return res.status(401).json({ error: 'غير مصرح — سجّل الدخول أولًا' });
  next();
}

function publicProduct(p) {
  return { ...p, inStock: p.stock > 0 };
}

function dayKey(iso) { return iso.slice(0, 10); }

// ---- الأقسام ----
// لو الداتا قديمة من غير أقسام، نبنيها من أقسام المنتجات الموجودة
function ensureCategories(db) {
  if (!Array.isArray(db.categories) || !db.categories.length) {
    const slugs = [...new Set(db.products.map(p => p.category).filter(Boolean))];
    db.categories = slugs.map((slug, i) => ({ slug, name: slug, subtitle: '', order: i + 1, active: true }));
    save();
  }
  return db.categories;
}

function sortedCategories(db) {
  return ensureCategories(db).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

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

// قائمة الأقسام للعرض في المتجر (النشطة فقط) مع صورة غلاف وعدد المنتجات
function storeCategories(db) {
  return sortedCategories(db).filter(c => c.active !== false).map(c => {
    const cover = db.products.find(p => p.active && p.category === c.slug && p.images[0]);
    const count = db.products.filter(p => p.active && p.category === c.slug).length;
    return { slug: c.slug, name: c.name, subtitle: c.subtitle || '', cover: cover ? cover.images[0] : '', count };
  });
}

// ================= API المتجر (عام) =================
app.get('/api/store', (req, res) => {
  const db = load();
  const s = db.settings;
  res.json({
    storeName: s.storeName, slogan: s.slogan, heroTitle: s.heroTitle, heroSubtitle: s.heroSubtitle,
    announcement: s.announcement, phone: s.phone, whatsapp: s.whatsapp, address: s.address,
    facebook: s.facebook, instagram: s.instagram, tiktok: s.tiktok,
    shipping: s.shipping, freeShippingOver: s.freeShippingOver, walletNumber: s.walletNumber,
    categories: storeCategories(db),
  });
});

app.get('/api/categories', (req, res) => {
  res.json(storeCategories(load()));
});

app.get('/api/products', (req, res) => {
  const db = load();
  let list = db.products.filter(p => p.active);
  const { category, q, sort, featured } = req.query;
  if (category && category !== 'all') list = list.filter(p => p.category === category);
  if (featured === '1') list = list.filter(p => p.featured);
  if (q) {
    const needle = String(q).trim();
    list = list.filter(p => p.name.includes(needle) || p.description.includes(needle));
  }
  if (sort === 'price_asc') list = [...list].sort((a, b) => a.price - b.price);
  else if (sort === 'price_desc') list = [...list].sort((a, b) => b.price - a.price);
  else list = [...list].sort((a, b) => b.id - a.id);
  res.json(list.map(publicProduct));
});

app.get('/api/products/:id', (req, res) => {
  const db = load();
  const p = db.products.find(x => x.id === Number(req.params.id) && x.active);
  if (!p) return res.status(404).json({ error: 'المنتج غير موجود' });
  const related = db.products
    .filter(x => x.active && x.id !== p.id && x.category === p.category)
    .slice(0, 4).map(publicProduct);
  res.json({ product: publicProduct(p), related });
});

app.post('/api/orders', (req, res) => {
  const db = load();
  const b = req.body || {};
  const c = b.customer || {};
  if (!c.name || String(c.name).trim().length < 3) return res.status(400).json({ error: 'اكتب الاسم بالكامل' });
  if (!/^01[0125][0-9]{8}$/.test(String(c.phone || '').trim())) return res.status(400).json({ error: 'رقم الموبايل غير صحيح (11 رقم يبدأ بـ 01)' });
  if (!c.address || String(c.address).trim().length < 5) return res.status(400).json({ error: 'اكتب العنوان بالتفصيل' });
  const zone = db.settings.shipping.find(z => z.name === c.zone);
  if (!zone) return res.status(400).json({ error: 'اختر منطقة التوصيل' });
  if (!Array.isArray(b.items) || b.items.length === 0) return res.status(400).json({ error: 'السلة فارغة' });
  const payment = b.payment === 'wallet' ? 'wallet' : 'cod';

  // التحقق من المنتجات والمخزون، والأسعار تُحسب من السيرفر دائمًا
  const items = [];
  for (const it of b.items) {
    const p = db.products.find(x => x.id === Number(it.id) && x.active);
    if (!p) return res.status(400).json({ error: 'منتج في السلة لم يعد متاحًا — حدّث السلة' });
    const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
    if (p.stock < qty) return res.status(400).json({ error: `الكمية المتاحة من "${p.name}" هي ${p.stock} فقط` });
    if (p.sizes.length && !p.sizes.includes(String(it.size))) return res.status(400).json({ error: `اختر مقاس "${p.name}"` });
    items.push({
      productId: p.id, name: p.name, price: p.price, image: p.images[0] || '',
      size: String(it.size || ''), color: String(it.color || p.colors[0] || ''), qty,
    });
  }
  for (const it of items) {
    const p = db.products.find(x => x.id === it.productId);
    p.stock -= it.qty;
  }

  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const free = db.settings.freeShippingOver > 0 && subtotal >= db.settings.freeShippingOver;
  const shippingFee = free ? 0 : zone.fee;
  const now = new Date().toISOString();
  const order = {
    id: 'MN-' + nextId('order'),
    customer: {
      name: String(c.name).trim(), phone: String(c.phone).trim(),
      address: String(c.address).trim(), zone: zone.name,
      notes: String(c.notes || '').trim().slice(0, 500),
    },
    payment, items, subtotal, shippingFee, total: subtotal + shippingFee,
    status: 'new', createdAt: now, updatedAt: now,
    statusHistory: [{ status: 'new', at: now }],
  };
  db.orders.push(order);
  save();
  res.json({ ok: true, orderId: order.id, total: order.total });
});

app.get('/api/track', (req, res) => {
  const db = load();
  const code = String(req.query.code || '').trim().toUpperCase();
  const phone = String(req.query.phone || '').trim();
  const order = db.orders.find(o => o.id.toUpperCase() === code && o.customer.phone === phone);
  if (!order) return res.status(404).json({ error: 'لا يوجد طلب بهذا الكود ورقم الموبايل' });
  res.json({
    id: order.id, status: order.status, createdAt: order.createdAt,
    statusHistory: order.statusHistory, items: order.items,
    subtotal: order.subtotal, shippingFee: order.shippingFee, total: order.total, zone: order.customer.zone,
  });
});

// ================= API الإدارة =================
app.post('/api/admin/login', (req, res) => {
  const db = load();
  const { username, password } = req.body || {};
  const a = db.admin;
  if (username !== a.username || hashPassword(String(password || ''), a.salt) !== a.hash) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { createdAt: Date.now() };
  save();
  res.setHeader('Set-Cookie', `manova_admin=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const db = load();
  const token = getCookie(req, 'manova_admin');
  if (token) { delete db.sessions[token]; save(); }
  res.setHeader('Set-Cookie', 'manova_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  const db = load();
  res.json({ username: db.admin.username, storeName: db.settings.storeName });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db = load();
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
  const DAY = 24 * 3600 * 1000;
  const todayKey = dayKey(new Date().toISOString());
  const since = Date.now() - (days - 1) * DAY;

  const counted = o => o.status !== 'cancelled'; // المبيعات = كل الطلبات غير الملغية
  const inRange = db.orders.filter(o => new Date(o.createdAt).getTime() >= since);

  // سلسلة يومية
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
    for (const it of o.items) {
      topMap[it.name] = topMap[it.name] || { name: it.name, qty: 0, revenue: 0 };
      topMap[it.name].qty += it.qty;
      topMap[it.name].revenue += it.qty * it.price;
    }
  }
  const topProducts = Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 6);

  const todayOrders = db.orders.filter(o => dayKey(o.createdAt) === todayKey && counted(o));
  const rangeOrders = inRange.filter(counted);

  res.json({
    days,
    tiles: {
      todayRevenue: todayOrders.reduce((s, o) => s + o.total, 0),
      todayOrders: todayOrders.length,
      rangeRevenue: rangeOrders.reduce((s, o) => s + o.total, 0),
      rangeOrders: rangeOrders.length,
      pending: db.orders.filter(o => o.status === 'new' || o.status === 'confirmed').length,
      lowStock: db.products.filter(p => p.active && p.stock <= 5).length,
    },
    series, statusCounts, topProducts,
    latestOrders: [...db.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8)
      .map(o => ({ id: o.id, name: o.customer.name, total: o.total, status: o.status, createdAt: o.createdAt })),
    hasDemo: db.orders.some(o => o.demo),
  });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const db = load();
  let list = [...db.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { status, q } = req.query;
  if (status && status !== 'all') list = list.filter(o => o.status === status);
  if (q) {
    const needle = String(q).trim().toUpperCase();
    list = list.filter(o => o.id.toUpperCase().includes(needle)
      || o.customer.name.includes(String(q).trim())
      || o.customer.phone.includes(String(q).trim()));
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const per = 20;
  res.json({
    total: list.length, page, pages: Math.max(1, Math.ceil(list.length / per)),
    orders: list.slice((page - 1) * per, page * per),
  });
});

app.get('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const db = load();
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json(o);
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const db = load();
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'الطلب غير موجود' });
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });
  if (status === o.status) return res.json(o);
  // إرجاع المخزون عند الإلغاء، وخصمه مرة أخرى لو رجع الطلب من الإلغاء
  if (status === 'cancelled' && o.status !== 'cancelled') {
    for (const it of o.items) {
      const p = db.products.find(x => x.id === it.productId);
      if (p) p.stock += it.qty;
    }
  } else if (o.status === 'cancelled' && status !== 'cancelled') {
    for (const it of o.items) {
      const p = db.products.find(x => x.id === it.productId);
      if (p) p.stock = Math.max(0, p.stock - it.qty);
    }
  }
  o.status = status;
  o.updatedAt = new Date().toISOString();
  o.statusHistory.push({ status, at: o.updatedAt });
  save();
  res.json(o);
});

// ----- المنتجات -----
function sanitizeProductInput(b, db) {
  const errors = [];
  const name = String(b.name || '').trim();
  const price = Number(b.price);
  const slugs = ensureCategories(db).map(c => c.slug);
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
      images: Array.isArray(b.images) ? b.images.filter(u => typeof u === 'string' && (u.startsWith('/uploads/') || u.startsWith('/images/'))) : [],
      stock: Math.max(0, Math.floor(Number(b.stock) || 0)),
      featured: !!b.featured,
      active: b.active !== false,
    },
  };
}

app.get('/api/admin/products', requireAdmin, (req, res) => {
  const db = load();
  res.json([...db.products].sort((a, b) => b.id - a.id));
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const db = load();
  const { errors, data } = sanitizeProductInput(req.body || {}, db);
  if (errors.length) return res.status(400).json({ error: errors.join(' — ') });
  const p = { id: nextId('product'), ...data, createdAt: new Date().toISOString() };
  db.products.push(p);
  save();
  res.json(p);
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const db = load();
  const p = db.products.find(x => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'المنتج غير موجود' });
  const { errors, data } = sanitizeProductInput(req.body || {}, db);
  if (errors.length) return res.status(400).json({ error: errors.join(' — ') });
  Object.assign(p, data);
  save();
  res.json(p);
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const db = load();
  const idx = db.products.findIndex(x => x.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'المنتج غير موجود' });
  const hasOrders = db.orders.some(o => o.items.some(it => it.productId === db.products[idx].id));
  if (hasOrders) {
    db.products[idx].active = false; // أرشفة بدل الحذف للحفاظ على سجل الطلبات
    save();
    return res.json({ ok: true, archived: true });
  }
  db.products.splice(idx, 1);
  save();
  res.json({ ok: true, archived: false });
});

// ----- الأقسام (إدارة) -----
app.get('/api/admin/categories', requireAdmin, (req, res) => {
  const db = load();
  const cats = sortedCategories(db).map(c => ({
    ...c, count: db.products.filter(p => p.category === c.slug).length,
  }));
  res.json(cats);
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const db = load();
  ensureCategories(db);
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'اسم القسم قصير' });
  if (db.categories.some(c => c.name === name)) return res.status(400).json({ error: 'يوجد قسم بنفس الاسم' });
  const slug = slugify(name, db.categories);
  const order = Math.max(0, ...db.categories.map(c => c.order || 0)) + 1;
  const cat = { slug, name, subtitle: String(b.subtitle || '').trim(), order, active: true };
  db.categories.push(cat);
  save();
  res.json(cat);
});

app.put('/api/admin/categories/:slug', requireAdmin, (req, res) => {
  const db = load();
  ensureCategories(db);
  const c = db.categories.find(x => x.slug === req.params.slug);
  if (!c) return res.status(404).json({ error: 'القسم غير موجود' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim().length >= 2) {
    if (db.categories.some(x => x !== c && x.name === b.name.trim())) return res.status(400).json({ error: 'يوجد قسم بنفس الاسم' });
    c.name = b.name.trim();
  }
  if (typeof b.subtitle === 'string') c.subtitle = b.subtitle.trim();
  if (b.active !== undefined) c.active = !!b.active;
  if (b.order !== undefined) c.order = Math.max(0, Number(b.order) || 0);
  save();
  res.json(c);
});

app.delete('/api/admin/categories/:slug', requireAdmin, (req, res) => {
  const db = load();
  ensureCategories(db);
  const idx = db.categories.findIndex(x => x.slug === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'القسم غير موجود' });
  const count = db.products.filter(p => p.category === req.params.slug).length;
  if (count > 0) return res.status(400).json({ error: `لا يمكن حذف القسم لوجود ${count} منتج فيه — انقل المنتجات لقسم آخر أولًا` });
  db.categories.splice(idx, 1);
  save();
  res.json({ ok: true });
});

// ----- رفع الصور -----
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, 'p' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.webp', '.svg'].includes((path.extname(file.originalname) || '').toLowerCase());
    cb(ok ? null : new Error('نوع الملف غير مدعوم — استخدم JPG أو PNG أو WEBP'), ok);
  },
});

app.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.array('images', 6)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ files: (req.files || []).map(f => '/uploads/' + f.filename) });
  });
});

// ----- الإعدادات -----
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const db = load();
  res.json(db.settings);
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const db = load();
  const b = req.body || {};
  const s = db.settings;
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
  save();
  res.json(s);
});

app.put('/api/admin/password', requireAdmin, (req, res) => {
  const db = load();
  const { current, next } = req.body || {};
  if (hashPassword(String(current || ''), db.admin.salt) !== db.admin.hash) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }
  if (String(next || '').length < 6) return res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف' });
  db.admin.salt = crypto.randomBytes(16).toString('hex');
  db.admin.hash = hashPassword(String(next), db.admin.salt);
  db.sessions = {}; // خروج من كل الجلسات الأخرى
  save();
  res.setHeader('Set-Cookie', 'manova_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.post('/api/admin/clear-demo', requireAdmin, (req, res) => {
  const db = load();
  const before = db.orders.length;
  db.orders = db.orders.filter(o => !o.demo);
  save();
  res.json({ ok: true, removed: before - db.orders.length });
});

// ================= صفحات لوحة التحكم (محمية) =================
app.get('/admin/login', (req, res) => res.sendFile(path.join(ADMIN_DIR, 'login.html')));
app.use('/admin/assets', express.static(path.join(ADMIN_DIR, 'assets')));

const ADMIN_PAGES = { '/admin': 'index.html', '/admin/orders': 'orders.html', '/admin/products': 'products.html', '/admin/categories': 'categories.html', '/admin/settings': 'settings.html' };
for (const [route, file] of Object.entries(ADMIN_PAGES)) {
  app.get(route, (req, res) => {
    if (!getSession(req)) return res.redirect('/admin/login');
    res.sendFile(path.join(ADMIN_DIR, file));
  });
}

// ================= صفحات المتجر =================
// نخدم الصور المرفوعة من مجلدها (قد يكون على قرص دائم خارج public)
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  }
  next();
});

app.listen(PORT, () => {
  load();
  console.log('');
  console.log('  ███ MANOVA Store ███');
  console.log(`  المتجر:        http://localhost:${PORT}`);
  console.log(`  لوحة التحكم:   http://localhost:${PORT}/admin`);
  console.log('');
});
