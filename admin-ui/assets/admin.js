/* MANOVA لوحة التحكم — منطق مشترك */
const AdminAPI = {
  async req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    if (r.status === 401) { location.href = '/admin/login'; throw new Error('انتهت الجلسة'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'حدث خطأ');
    return d;
  },
  get(u) { return this.req('GET', u); },
  post(u, b) { return this.req('POST', u, b); },
  put(u, b) { return this.req('PUT', u, b); },
  patch(u, b) { return this.req('PATCH', u, b); },
  del(u) { return this.req('DELETE', u); },
  async upload(files) {
    const fd = new FormData();
    for (const f of files) fd.append('images', f);
    const r = await fetch('/api/admin/upload', { method: 'POST', body: fd });
    if (r.status === 401) { location.href = '/admin/login'; throw new Error('انتهت الجلسة'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'فشل رفع الصور');
    return d.files;
  },
};

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
