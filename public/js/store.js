/* MANOVA — منطق مشترك لكل صفحات المتجر */
const API = {
  async get(url) {
    const r = await fetch(url);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'حدث خطأ، حاول مرة أخرى');
    return d;
  },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'حدث خطأ، حاول مرة أخرى');
    return d;
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
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.35s'; setTimeout(() => t.remove(), 380); }, 2600);
}

/* ---------- الهيدر والفوتر ---------- */
let STORE = null;
async function loadStore() {
  if (STORE) return STORE;
  try { STORE = await API.get('/api/store'); } catch { STORE = {}; }
  return STORE;
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
    headerEl.innerHTML = `
    ${s.announcement ? `<div class="announce"></div>` : ''}
    <header class="site-header">
      <div class="container header-row">
        <button class="hicon burger" aria-label="القائمة">${ICONS.menu}</button>
        <a href="/" aria-label="MANOVA — الرئيسية">
          <span class="brand-name">MANOVA</span>
          <span class="brand-sub">TO BE A NEW MAN</span>
        </a>
        <nav class="main-nav">
          <a href="/" ${activeNav('/') ? 'class="active"' : ''}>الرئيسية</a>
          <a href="/shop" ${activeNav('/shop') && !location.search ? 'class="active"' : ''}>كل المنتجات</a>
          ${navCats}
          <a href="/track" ${activeNav('/track') ? 'class="active"' : ''}>تتبع طلبك</a>
        </nav>
        <div class="header-actions">
          <a href="/cart" class="hicon" aria-label="سلة التسوق">
            ${ICONS.bag}
            <span class="cart-count">0</span>
          </a>
        </div>
      </div>
    </header>`;
    if (s.announcement) headerEl.querySelector('.announce').textContent = s.announcement;
    const burger = headerEl.querySelector('.burger');
    const nav = headerEl.querySelector('.main-nav');
    burger.addEventListener('click', () => nav.classList.toggle('open'));
  }

  if (footerEl) {
    footerEl.innerHTML = `
    <footer class="site-footer">
      <div class="container">
        <div class="footer-grid">
          <div class="footer-brand">
            <span class="brand-name">MANOVA</span>
            <span class="brand-sub" style="color:var(--gold)">TO BE A NEW MAN</span>
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
          <span>اسنا، مصر</span>
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
    a.innerHTML = ICONS.wa;
    document.body.appendChild(a);
  }

  renderCartCount();
}

function renderCartCount() {
  document.querySelectorAll('.cart-count').forEach(el => { el.textContent = Cart.count(); });
}

/* ---------- كارت منتج ---------- */
function productCard(p) {
  const hasSale = p.oldPrice > p.price;
  const a = document.createElement('a');
  a.className = 'p-card';
  a.href = '/product?id=' + p.id;
  a.innerHTML = `
    <div class="p-media">
      ${!p.inStock ? '<span class="p-badge out">نفذت الكمية</span>' : hasSale ? '<span class="p-badge"></span>' : ''}
      <img loading="lazy" alt="">
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
  const img = a.querySelector('img');
  img.src = p.images[0] || '';
  img.alt = p.name;
  if (hasSale && p.inStock) {
    a.querySelector('.p-badge').textContent = 'خصم ' + Math.round((1 - p.price / p.oldPrice) * 100) + '%';
  }
  return a;
}

document.addEventListener('DOMContentLoaded', renderChrome);
