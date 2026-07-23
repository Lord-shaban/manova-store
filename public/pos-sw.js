/* MANOVA POS — Service Worker: تشغيل الكاشير بدون إنترنت (نطاق /admin/ فقط)
   - ملفات الموقع المحلية: النت أولًا (تحديثات فورية) مع فولباك للكاش وقت الانقطاع
   - Firebase SDK والخطوط (روابط ثابتة الإصدار): كاش أولًا
   - طلبات Firestore/Auth/Storage: بتعدي زي ما هي — بيانات حية عمرها ما تتكاش،
     والأوفلاين متظبط في طبقة PosAPI (طابور outbox في localStorage) */
const VERSION = 'manova-pos-v3';

const SHELL = [
  '/admin/pos', '/admin/pos-history', '/admin/pos-shifts', '/admin/pos-reports', '/admin/login',
  '/admin/assets/admin.css', '/admin/assets/admin.js',
  '/admin/assets/pos.css', '/admin/assets/pos.js', '/admin/assets/charts.js',
  '/js/firebase-config.js', '/js/firebase.js',
  '/images/favicon.svg', '/images/logo.jpeg', '/pos-manifest.json',
];

// روابط بتتكاش «كاش أولًا» — محتواها ثابت (SDK بإصدار محدد + خطوط جوجل)
const CDN_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
// بيانات حية — ممنوع تتكاش نهائيًا
const LIVE_HOSTS = [
  'firestore.googleapis.com', 'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com', 'firebasestorage.googleapis.com',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll بيفشل كله لو ملف واحد فشل — بنكاش واحدة واحدة ونتجاهل الفاشل
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (LIVE_HOSTS.includes(url.host)) return;

  if (CDN_HOSTS.includes(url.host)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const c = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // تنقّل لصفحة مش متكاشة والنت قاطع → نرجع شاشة الكاشير
    if (req.mode === 'navigate') {
      const pos = await c.match('/admin/pos');
      if (pos) return pos;
    }
    throw err;
  }
}
