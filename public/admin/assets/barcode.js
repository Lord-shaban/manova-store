/* MANOVA — باركود Code128-B كـ SVG (بدون مكتبات) + طباعة عبر iframe معزول
   المقاسات القياسية (مأكدة بالبحث):
   - ليبل باركود المنتجات: 40×25mm (ستيكر حراري للملابس)
   - بوليصة الشحن: 100×150mm (4×6 بوصة — مقاس شركات الشحن)
   - الفاتورة الحرارية: 80mm (موجودة في pos.css)
   الطباعة بتتم في iframe منفصل عشان كل نوع ليه @page بمقاسه من غير تعارض. */

/* جدول أنماط Code128 (عرض الخطوط والفراغات لكل رمز) */
const C128_PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 '
  + '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 '
  + '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 '
  + '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 '
  + '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 '
  + '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232').split(' ');
const C128_STOP = '2331112';

/**
 * توليد باركود Code128-B كعنصر SVG
 * text: نص ASCII (أكواد الفواتير/باركود المنتجات)
 */
function code128Svg(text, { height = 44, moduleWidth = 2, showText = true, fontSize = 10 } = {}) {
  text = String(text || '').replace(/[^\x20-\x7e]/g, '');
  if (!text) text = '0';
  const codes = [104]; // Start B
  for (const ch of text) codes.push(ch.charCodeAt(0) - 32);
  let checksum = 104;
  for (let i = 1; i < codes.length; i++) checksum += i * codes[i];
  codes.push(checksum % 103);

  let widths = '';
  for (const c of codes) widths += C128_PATTERNS[c];
  widths += C128_STOP;

  const quiet = 10 * moduleWidth; // هامش صامت من الجانبين
  const totalModules = [...widths].reduce((s, w) => s + Number(w), 0);
  const W = totalModules * moduleWidth + quiet * 2;
  const H = height + (showText ? fontSize + 4 : 0);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);

  let x = quiet, bar = true;
  for (const wc of widths) {
    const w = Number(wc) * moduleWidth;
    if (bar) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', 0);
      r.setAttribute('width', w); r.setAttribute('height', height);
      r.setAttribute('fill', '#000');
      svg.appendChild(r);
    }
    x += w;
    bar = !bar;
  }
  if (showText) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', W / 2);
    t.setAttribute('y', H - 2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', fontSize);
    t.setAttribute('font-family', 'monospace');
    t.setAttribute('letter-spacing', '2');
    t.textContent = text;
    svg.appendChild(t);
  }
  return svg;
}
function code128Html(text, opts) { return code128Svg(text, opts).outerHTML; }

/* باركود رقمي داخلي للمنتجات (13 رقم يبدأ بـ2 = استخدام داخلي) — بيتولد تلقائيًا */
function genBarcode() {
  return '2' + String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 900) + 100);
}

/**
 * طباعة مستند في iframe معزول بمقاس صفحة محدد
 * html: جسم الصفحة · pageCss: أنماط تشمل @page بالمقاس المطلوب
 */
function printDoc(html, pageCss) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;inset-inline-start:-9999px;width:0;height:0;border:0';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Almarai','Segoe UI',Tahoma,sans-serif; color:#000; }
    ${pageCss}
  </style></head><body>${html}</body></html>`);
  d.close();
  setTimeout(() => {
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* تجاهل */ }
    setTimeout(() => f.remove(), 3000);
  }, 250);
}

/* ليبل منتج 40×25mm — اسم مختصر + سعر + باركود */
function printProductLabels(p, copies) {
  copies = Math.max(1, Math.min(100, Math.floor(copies) || 1));
  const one = `
    <div class="lbl">
      <div class="lbl-brand">MANOVA</div>
      <div class="lbl-name">${esc(String(p.name).slice(0, 34))}</div>
      <div class="lbl-price">${Number(p.price).toLocaleString('en-EG')} EGP</div>
      <div class="lbl-code">${code128Html(p.barcode, { height: 30, moduleWidth: 2, showText: true, fontSize: 8 })}</div>
    </div>`;
  printDoc(one.repeat(copies), `
    @page { size: 40mm 25mm; margin: 0; }
    .lbl { width: 40mm; height: 25mm; padding: 1mm 1.5mm; text-align: center; overflow: hidden;
           page-break-after: always; display: flex; flex-direction: column; justify-content: space-between; }
    .lbl-brand { font-size: 6.5pt; letter-spacing: .25em; font-weight: 700; }
    .lbl-name { font-size: 6pt; line-height: 1.2; max-height: 8mm; overflow: hidden; }
    .lbl-price { font-size: 8pt; font-weight: 800; }
    .lbl-code svg { width: 36mm; height: 9mm; }`);
}

/* بوليصة شحن 100×150mm (4×6") لطلبات الموقع */
function printWaybill(o, store) {
  const itemsCount = (o.items || []).reduce((s, it) => s + it.qty, 0);
  const cod = o.payment === 'wallet' ? 0 : o.total;
  printDoc(`
    <div class="wb">
      <div class="wb-head">
        <div class="wb-brand">MANOVA</div>
        <div class="wb-store">
          <div>${esc(store.storeName || 'MANOVA')}</div>
          <div dir="ltr">${esc(store.phone || '')}</div>
          <div>${esc(store.address || '')}</div>
        </div>
      </div>
      <div class="wb-code">${code128Html(o.id, { height: 52, moduleWidth: 2, showText: true, fontSize: 13 })}</div>
      <div class="wb-to">
        <div class="wb-label">المستلم</div>
        <div class="wb-name">${esc(o.customer.name)}</div>
        <div class="wb-phone" dir="ltr">${esc(o.customer.phone)}</div>
        <div class="wb-addr"><b>${esc(o.customer.zone)}</b> — ${esc(o.customer.address)}</div>
        ${o.customer.notes ? `<div class="wb-notes">ملاحظات: ${esc(o.customer.notes)}</div>` : ''}
      </div>
      <div class="wb-foot">
        <div class="wb-box"><small>عدد القطع</small><b>${itemsCount}</b></div>
        <div class="wb-box wb-cod"><small>المطلوب تحصيله</small><b>${cod === 0 ? 'مدفوع ✓' : Number(cod).toLocaleString('en-EG') + ' ج.م'}</b></div>
      </div>
      <div class="wb-tag">TO BE A NEW MAN — شكراً لطلبك من مانوفا</div>
    </div>`, `
    @page { size: 100mm 150mm; margin: 0; }
    .wb { width: 100mm; height: 150mm; padding: 5mm; display: flex; flex-direction: column; gap: 3mm; border: .4mm solid #000; }
    .wb-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: .6mm solid #000; padding-bottom: 2.5mm; }
    .wb-brand { font-size: 17pt; letter-spacing: .2em; font-weight: 700; font-family: 'Marcellus','Times New Roman',serif; }
    .wb-store { font-size: 7.5pt; text-align: start; line-height: 1.6; }
    .wb-code { text-align: center; }
    .wb-code svg { width: 80mm; height: 17mm; }
    .wb-label { font-size: 8pt; color: #444; font-weight: 700; }
    .wb-to { border: .3mm solid #000; border-radius: 2mm; padding: 3mm; flex: 1; }
    .wb-name { font-size: 15pt; font-weight: 800; }
    .wb-phone { font-size: 14pt; font-weight: 800; letter-spacing: .05em; }
    .wb-addr { font-size: 10.5pt; margin-top: 1.5mm; line-height: 1.6; }
    .wb-notes { font-size: 9pt; margin-top: 1.5mm; color: #222; }
    .wb-foot { display: flex; gap: 3mm; }
    .wb-box { flex: 1; border: .3mm solid #000; border-radius: 2mm; padding: 2mm 3mm; text-align: center; }
    .wb-box small { display: block; font-size: 7.5pt; }
    .wb-box b { font-size: 13pt; }
    .wb-cod b { font-size: 15pt; }
    .wb-tag { text-align: center; font-size: 7pt; letter-spacing: .1em; color: #333; }`);
}
