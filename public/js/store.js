/* MANOVA — منطق مشترك لكل صفحات المتجر */
/* الـ API بيتوجّه مباشرة لـ Firestore (عبر طبقة MDB في firebase.js) —
   نفس المسارات القديمة محفوظة عشان كود الصفحات ما يتغيرش */
const API = {
  async get(url) {
    const u = new URL(url, location.origin);
    const p = u.pathname, q = u.searchParams;
    try {
      if (p === '/api/store') return await MDB.getStoreInfo();
      if (p === '/api/categories') return (await MDB.getStoreInfo()).categories;
      if (p === '/api/products') {
        return await MDB.getProducts({
          category: q.get('category'), q: q.get('q'), sort: q.get('sort'), featured: q.get('featured'),
        });
      }
      if (p.startsWith('/api/products/')) return await MDB.getProduct(decodeURIComponent(p.slice('/api/products/'.length)));
      if (p === '/api/track') return await MDB.trackOrder(q.get('q') || q.get('code') || q.get('phone'));
      throw new Error('حدث خطأ، حاول مرة أخرى');
    } catch (e) { throw MDB.nice(e); }
  },
  async post(url, body) {
    const p = new URL(url, location.origin).pathname;
    try {
      if (p === '/api/orders') return await MDB.createOrder(body);
      throw new Error('حدث خطأ، حاول مرة أخرى');
    } catch (e) { throw MDB.nice(e); }
  },
};

function money(n) {
  return Number(n || 0).toLocaleString('en-EG') + ' ج.م';
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

// خريطة الأقسام (slug → الاسم) — تُملأ من /api/store لعرض اسم القسم في كروت المنتجات
window.CATS = window.CATS || {};
function catName(slug) {
  if (window.CATS && window.CATS[slug]) return window.CATS[slug];
  if (STORE && Array.isArray(STORE.categories)) {
    const c = STORE.categories.find(x => x.slug === slug);
    if (c) return c.name;
  }
  return slug || '';
}

/* أيقونات SVG (خط رفيع 1.5) */
const ICONS = {
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 8h12l-1 13H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor"><path d="M1 5h14v11H1z"/><path d="M15 9h4l3 3v4h-7"/><circle cx="6" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor"><rect x="2" y="6" width="20" height="12"/><circle cx="12" cy="12" r="2.6"/><path d="M5.5 9.5h.01M18.5 14.5h.01"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke="currentColor"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  wa: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.2 14.8l-.5-.3-2.9.8.8-2.8-.3-.5A8 8 0 0 1 12 4zm-3 4c-.2 0-.5 0-.7.3-.2.3-.9.9-.9 2.1 0 1.2.9 2.4 1 2.6.1.2 1.8 2.8 4.3 3.8 2.1.8 2.6.7 3 .6.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2l-.4-.3-1.5-.7c-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1-.2-.1-.9-.3-1.8-1.1-.7-.6-1.1-1.3-1.2-1.5-.1-.2 0-.3.1-.5l.4-.5c.1-.2.1-.3.2-.5v-.5L10 8.5c-.2-.4-.4-.4-.6-.4H9z"/></svg>',
};

/* ---------- السلة (localStorage) ---------- */
const Cart = {
  key: 'manova_cart',
  get() {
    try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; }
  },
  set(items) {
    localStorage.setItem(this.key, JSON.stringify(items));
    renderCartCount();
  },
  add(item) {
    const items = this.get();
    const same = items.find(x => x.id === item.id && x.size === item.size && x.color === item.color);
    if (same) same.qty += item.qty; else items.push(item);
    this.set(items);
  },
  update(index, qty) {
    const items = this.get();
    if (!items[index]) return;
    items[index].qty = Math.max(1, qty);
    this.set(items);
  },
  remove(index) {
    const items = this.get();
    items.splice(index, 1);
    this.set(items);
  },
  clear() { this.set([]); },
  count() { return this.get().reduce((s, x) => s + x.qty, 0); },
};

/* ---------- Toast ---------- */
function toast(msg, type = 'success') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const ic = document.createElement('span');
  ic.style.cssText = 'flex-shrink:0;display:inline-flex;width:17px;height:17px';
  ic.innerHTML = type === 'error'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="#ff6b5e" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="#E9B32C" stroke-width="2"><path d="M4.5 12.5l5 5 10-11"/></svg>';
  const tx = document.createElement('span');
  tx.textContent = msg;
  t.append(ic, tx);
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.35s'; setTimeout(() => t.remove(), 380); }, 2600);
}

/* ---------- أنيميشن الظهور عند السكرول ---------- */
const _revealIO = ('IntersectionObserver' in window)
  ? new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add('in'); _revealIO.unobserve(en.target); }
      });
    }, { threshold: .12, rootMargin: '0px 0px -6% 0px' })
  : null;
function revealScan(root) {
  const els = (root || document).querySelectorAll('.rv:not(.in)');
  if (!_revealIO) { els.forEach(el => el.classList.add('in')); return; }
  els.forEach(el => _revealIO.observe(el));
}

/* ---------- الهيدر والفوتر ---------- */
let STORE = null;
async function loadStore() {
  if (STORE) return STORE;
  // الفشل ما بيتخزنش — أي نداء تالي يعيد المحاولة (مهم لو النت قطع لحظيًا)
  try { STORE = await API.get('/api/store'); return STORE; }
  catch { return {}; }
}

/* ---------- مزامنة السلة مع بيانات المنتجات الحالية ----------
   بتصحّح الأسعار والأسماء والصور من القاعدة (عبر الكاش — صفر قراءات إضافية)،
   وتشيل المنتجات اللي خلصت أو اتشالت، وتحدّ الكمية بالمخزون المتاح. */
async function syncCart() {
  const items = Cart.get();
  if (!items.length) return { items, changed: false };
  let products;
  try { products = await MDB.getProducts({}); } catch { return { items, changed: false }; }
  const byId = {};
  products.forEach(p => { byId[p.id] = p; });
  let changed = false;
  const next = [];
  for (const it of items) {
    const p = byId[String(it.id)];
    if (!p || !p.inStock) { changed = true; continue; } // المنتج لم يعد متاحًا
    const fixed = { ...it };
    if (fixed.price !== p.price) { fixed.price = p.price; changed = true; }
    if (fixed.name !== p.name) { fixed.name = p.name; changed = true; }
    if ((p.images[0] || '') && fixed.image !== p.images[0]) { fixed.image = p.images[0]; changed = true; }
    if (fixed.qty > p.stock) { fixed.qty = p.stock; changed = true; }
    next.push(fixed);
  }
  if (changed) Cart.set(next);
  return { items: next, changed };
}

function activeNav(page) {
  return location.pathname === page;
}

async function renderChrome() {
  const s = await loadStore();
  const headerEl = document.getElementById('site-header');
  const footerEl = document.getElementById('site-footer');

  // الأقسام الديناميكية (تُدار من لوحة التحكم)
  const cats = Array.isArray(s.categories) ? s.categories : [];
  window.CATS = {};
  cats.forEach(c => { window.CATS[c.slug] = c.name; });
  const navCats = cats.map(c => `<a href="/shop?category=${encodeURIComponent(c.slug)}">${escHtml(c.name)}</a>`).join('');
  const footCats = cats.map(c => `<li><a href="/shop?category=${encodeURIComponent(c.slug)}">${escHtml(c.name)}</a></li>`).join('');

  if (headerEl) {
    const navLinks = `
      <a href="/" ${activeNav('/') ? 'class="active"' : ''}>الرئيسية</a>
      <a href="/shop" ${activeNav('/shop') && !location.search ? 'class="active"' : ''}>كل المنتجات</a>
      ${navCats}
      <a href="/track" ${activeNav('/track') ? 'class="active"' : ''}>تتبع طلبك</a>`;
    const waNum = (s.whatsapp || '').replace(/[^0-9]/g, '');
    const socialLinks = [['FACEBOOK', s.facebook], ['INSTAGRAM', s.instagram], ['TIKTOK', s.tiktok]]
      .filter(([, u]) => u)
      .map(([l, u]) => `<a href="${escHtml(u)}" target="_blank" rel="noopener">${l}</a>`).join('');
    headerEl.innerHTML = `
    ${s.announcement ? `<div class="announce"></div>` : ''}
    <header class="site-header">
      <div class="container header-row">
        <button class="hicon burger" aria-label="فتح القائمة">${ICONS.menu}</button>
        <a href="/" aria-label="MANOVA — الرئيسية" class="brand">
          <span class="brand-name">MANOVA</span>
          <span class="brand-sub">TO BE A NEW MAN</span>
        </a>
        <nav class="main-nav">${navLinks}</nav>
        <div class="header-actions">
          <a href="/cart" class="hicon" aria-label="سلة التسوق">
            ${ICONS.bag}
            <span class="cart-count">0</span>
          </a>
        </div>
      </div>
    </header>
    <aside class="m-nav" aria-label="قائمة الموقع">
      <div class="m-nav-head">
        <span class="brand-name">MANOVA</span>
        <button class="m-nav-close" aria-label="إغلاق القائمة">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l14 14M19 5L5 19"/></svg>
        </button>
      </div>
      <div class="m-nav-label">التسوق</div>
      <nav class="m-nav-links">${navLinks}</nav>
      <div class="m-nav-foot">
        ${waNum ? `<a class="wa-btn" href="https://wa.me/${waNum}" target="_blank" rel="noopener">${ICONS.wa} تواصل معنا واتساب</a>` : ''}
        ${socialLinks ? `<div class="m-social">${socialLinks}</div>` : ''}
      </div>
    </aside>
    <div class="nav-veil"></div>`;
    if (s.announcement) headerEl.querySelector('.announce').textContent = s.announcement;

    const mnav = headerEl.querySelector('.m-nav');
    const veil = headerEl.querySelector('.nav-veil');
    const openNav = () => {
      mnav.classList.add('open'); veil.classList.add('show');
      document.body.classList.add('nav-open');
    };
    const closeNav = () => {
      mnav.classList.remove('open'); veil.classList.remove('show');
      document.body.classList.remove('nav-open');
    };
    headerEl.querySelector('.burger').addEventListener('click', openNav);
    headerEl.querySelector('.m-nav-close').addEventListener('click', closeNav);
    veil.addEventListener('click', closeNav);
    mnav.querySelectorAll('a').forEach(a => a.addEventListener('click', closeNav));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });

    // ظل خفيف للهيدر عند السكرول
    const sh = headerEl.querySelector('.site-header');
    const onScroll = () => sh.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  if (footerEl) {
    footerEl.innerHTML = `
    <footer class="site-footer">
      <div class="container">
        <div class="footer-grid">
          <div class="footer-brand">
            <span class="brand-name">MANOVA</span>
            <span class="brand-sub">TO BE A NEW MAN</span>
            <p>براند ملابس رجالي من اسنا. تيشرتات بيسيك ومطبوعة بخامات مختارة بعناية وأسعار عادلة — والتوصيل حتى باب البيت.</p>
            <div class="social-row"></div>
          </div>
          <div>
            <h5>التسوق</h5>
            <ul class="footer-links">
              <li><a href="/shop">كل المنتجات</a></li>
              ${footCats}
            </ul>
          </div>
          <div>
            <h5>خدمة العملاء</h5>
            <ul class="footer-links">
              <li><a href="/track">تتبع طلبك</a></li>
              <li><a href="/cart">سلة التسوق</a></li>
              <li><a href="/checkout">إتمام الطلب</a></li>
            </ul>
          </div>
          <div>
            <h5>تواصل معنا</h5>
            <ul class="footer-contact">
              <li class="f-address"></li>
              <li dir="ltr" style="text-align:end" class="f-phone"></li>
              <li>الدفع عند الاستلام متاح لجميع الطلبات</li>
            </ul>
          </div>
        </div>
        <div class="footer-bottom">
          <span>© ${new Date().getFullYear()} MANOVA — جميع الحقوق محفوظة</span>
          <span class="latin" style="letter-spacing:.2em">MADE IN ESNA · EGYPT</span>
        </div>
      </div>
    </footer>`;
    footerEl.querySelector('.f-address').textContent = s.address || 'اسنا — الأقصر';
    footerEl.querySelector('.f-phone').textContent = s.phone || '';
    const social = footerEl.querySelector('.social-row');
    const links = [['FACEBOOK', s.facebook], ['INSTAGRAM', s.instagram], ['TIKTOK', s.tiktok]];
    for (const [label, url] of links) {
      if (!url) continue;
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label;
      social.appendChild(a);
    }
  }

  // زر واتساب عائم
  if (s.whatsapp && !document.querySelector('.wa-float')) {
    const a = document.createElement('a');
    a.className = 'wa-float';
    a.href = 'https://wa.me/' + s.whatsapp.replace(/[^0-9]/g, '');
    a.target = '_blank'; a.rel = 'noopener'; a.title = 'تواصل واتساب';
    a.setAttribute('aria-label', 'تواصل معنا عبر واتساب');
    a.innerHTML = ICONS.wa;
    document.body.appendChild(a);
  }

  renderCartCount();
  revealScan();
}

function renderCartCount() {
  document.querySelectorAll('.cart-count').forEach(el => { el.textContent = Cart.count(); });
}

/* ---------- كارت منتج ---------- */
function productCard(p) {
  const hasSale = p.oldPrice > p.price;
  const hasAlt = p.images.length > 1;
  const a = document.createElement('a');
  a.className = 'p-card';
  a.href = '/product?id=' + p.id;
  a.innerHTML = `
    <div class="p-media">
      ${!p.inStock ? '<span class="p-badge out">نفذت الكمية</span>' : hasSale ? '<span class="p-badge"></span>' : ''}
      <img loading="lazy" class="img-main" alt="">
      ${hasAlt ? '<img loading="lazy" class="img-alt" alt="">' : ''}
      <span class="p-view">عرض المنتج</span>
    </div>
    <div class="p-info">
      <div class="p-cat">${escHtml(catName(p.category))}</div>
      <div class="p-name"></div>
      <div class="p-price-row">
        <span class="p-price ${hasSale ? 'sale' : ''}">${money(p.price)}</span>
        ${hasSale ? `<span class="p-old">${money(p.oldPrice)}</span>` : ''}
      </div>
    </div>`;
  a.querySelector('.p-name').textContent = p.name;
  const img = a.querySelector('.img-main');
  MDB.bindImg(img, p.images[0] || '');
  img.alt = p.name;
  if (hasAlt) MDB.bindImg(a.querySelector('.img-alt'), p.images[1]);
  if (hasSale && p.inStock) {
    a.querySelector('.p-badge').textContent = 'خصم ' + Math.round((1 - p.price / p.oldPrice) * 100) + '%';
  }
  return a;
}

document.addEventListener('DOMContentLoaded', renderChrome);
