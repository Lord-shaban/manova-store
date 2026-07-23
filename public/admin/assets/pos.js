/* MANOVA — نظام مبيعات المحل (كاشير / POS)
   PosAPI: ورديات + مبيعات + مرتجعات + كتالوج أوفلاين + طباعة فواتير حرارية 80mm.

   فلسفة الأوفلاين (outbox): كل عملية (بيع / مرتجع / وردية) بتتسجل فورًا في طابور
   داخل localStorage وبتتنفذ على Firestore بالترتيب أول ما النت يتوفر — معاملات
   runTransaction بتخصم/بترجّع المخزون بأمان. فالكاشير شغال طبيعي والنت قاطع،
   والفاتورة بتتطبع في لحظتها، والموقع بيشوف المخزون الجديد بعد المزامنة.

   بيعتمد على MDB (js/firebase.js) و AdminAPI + esc/money (admin.js) — حمّلهم قبله. */
const PosAPI = (() => {
  const K = {
    queue: 'pos1:queue',      // طابور العمليات غير المتزامنة
    shift: 'pos1:shift',      // الوردية المفتوحة حاليًا (محلية بالكامل)
    catalog: 'pos1:catalog',  // كتالوج المنتجات والأقسام (كاش أوفلاين)
    pref: 'pos1:pref',        // تفضيلات الكاشير (طباعة تلقائية...)
  };
  const CATALOG_TTL = 5 * 60 * 1000;
  const PAY_LABELS = { cash: 'كاش', card: 'بطاقة', wallet: 'محفظة إلكترونية', credit: 'آجل' };
  // مبيعات الكاشير (غير الآجل) بتصب تلقائيًا في الخزنة الرئيسية بنظام الحسابات
  const MAIN_TREASURY = 'main';
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const fmtN = n => Number(n || 0).toLocaleString('en-EG');

  /* ---------- تخزين محلي ---------- */
  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function lsPut(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* المساحة ممتلئة */ }
  }

  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function code(prefix) {
    let s = '';
    const rnd = new Uint32Array(6);
    crypto.getRandomValues(rnd);
    for (let i = 0; i < 6; i++) s += CODE_CHARS[rnd[i] % CODE_CHARS.length];
    return prefix + '-' + s;
  }

  async function cashierEmail() {
    try { const u = await AdminAPI.currentUser(); return (u && u.email) || 'كاشير'; }
    catch { return 'كاشير'; }
  }

  /* ---------- كاش جلسة قصير لصفحات السجل والتقارير (زي كاش اللوحة) ---------- */
  const scMemo = {};
  const SC_PREFIX = 'pos1s:';
  const SC_TTL = 60 * 1000;
  function scGet(key) {
    try {
      const raw = sessionStorage.getItem(SC_PREFIX + key);
      if (!raw) return null;
      const { t, d } = JSON.parse(raw);
      if (!t || Date.now() - t > SC_TTL) return null;
      return d;
    } catch { return null; }
  }
  function scPut(key, d) {
    try { sessionStorage.setItem(SC_PREFIX + key, JSON.stringify({ t: Date.now(), d })); }
    catch { /* تجاهل */ }
  }
  function scached(key, fn) {
    if (!scMemo[key]) {
      scMemo[key] = (async () => {
        const hit = scGet(key);
        if (hit !== null) return hit;
        const fresh = await fn();
        scPut(key, fresh);
        return fresh;
      })().catch(e => { delete scMemo[key]; throw e; });
    }
    return scMemo[key];
  }
  function scacheClear() {
    for (const k of Object.keys(scMemo)) delete scMemo[k];
    try {
      Object.keys(sessionStorage).filter(k => k.startsWith(SC_PREFIX)).forEach(k => sessionStorage.removeItem(k));
    } catch { /* تجاهل */ }
  }

  /* ---------- طابور المزامنة (outbox) ---------- */
  const sync = { syncing: false, lastError: '' };
  let applyingKey = null; // مفتاح العملية اللي بتتنفذ حاليًا — عشان الدمج ما يلمسهاش

  function pending() { return (lsGet(K.queue) || []).length; }

  function emit() {
    window.dispatchEvent(new CustomEvent('pos-sync', { detail: syncState() }));
  }
  function syncState() {
    return { pending: pending(), syncing: sync.syncing, lastError: sync.lastError, online: navigator.onLine };
  }

  function qAdd(op) {
    const q = lsGet(K.queue) || [];
    // عمليات الوردية بتتدمج: آخر نسخة كافية (بتتكتب merge) — توفير كتابات كبير أوفلاين
    const out = op.coalesce ? q.filter(x => !(x.coalesce === op.coalesce && x.key !== applyingKey)) : q;
    out.push(op);
    lsPut(K.queue, out);
    emit();
    flush().catch(() => { /* هتتعاد المحاولة تلقائيًا */ });
  }

  async function applyOp(op) {
    const { fs, db } = await MDB.fb();

    if (op.op === 'shift') {
      await fs.setDoc(fs.doc(db, 'pos_shifts', op.shift.id), op.shift, { merge: true });
      return;
    }

    if (op.op === 'sale') {
      await fs.runTransaction(db, async tx => {
        const saleRef = fs.doc(db, 'pos_sales', op.sale.id);
        if ((await tx.get(saleRef)).exists()) return; // اتزامنت قبل كده (إعادة محاولة بعد نجاح)
        const stocked = op.sale.items.filter(it => it.productId); // المنتج اليدوي من غير مخزون
        const refs = stocked.map(it => fs.doc(db, 'products', String(it.productId)));
        const snaps = [];
        for (const r of refs) snaps.push(await tx.get(r));
        // آجل → على حساب العميل / غير كده → فلوس بتدخل الخزنة الرئيسية + قيد يومية
        const isCredit = op.sale.payment === 'credit';
        const cuRef = isCredit && op.sale.customerId ? fs.doc(db, 'customers', op.sale.customerId) : null;
        const cuSnap = cuRef ? await tx.get(cuRef) : null;
        const trRef = !isCredit ? fs.doc(db, 'treasuries', MAIN_TREASURY) : null;
        const trSnap = trRef ? await tx.get(trRef) : null;

        snaps.forEach((s, i) => {
          if (!s.exists()) return; // المنتج اتحذف — الفاتورة تتسجل عادي
          // الخصم بالمقاس لو المنتج متتبع بالمقاسات
          tx.update(refs[i], MDB.stockPatch(s.data(), stocked[i].size || '', -stocked[i].qty));
        });
        if (cuRef) {
          if (cuSnap.exists()) {
            tx.update(cuRef, { balance: round2((Number(cuSnap.data().balance) || 0) + op.sale.total) });
          } else {
            tx.set(cuRef, {
              name: op.sale.customerName || 'عميل', phone: (op.newCustomer || {}).phone || '',
              address: '', note: 'اتضاف من الكاشير', openingBalance: 0,
              balance: op.sale.total, active: true, createdAt: op.sale.createdAt,
            });
          }
        }
        if (trRef) {
          const cur = trSnap.exists() ? (Number(trSnap.data().balance) || 0) : 0;
          const base = trSnap.exists() ? {} : { name: 'الخزنة الرئيسية', openingBalance: 0, createdAt: op.sale.createdAt };
          tx.set(trRef, { ...base, balance: round2(cur + op.sale.total) }, { merge: true });
          tx.set(fs.doc(fs.collection(db, 'finance_log')), {
            at: op.sale.createdAt, treasuryId: MAIN_TREASURY, amount: op.sale.total,
            kind: 'pos_sale', refId: op.sale.id, refName: 'بيع كاشير ' + op.sale.id,
            note: '', by: op.sale.cashier || '',
          });
        }
        tx.set(saleRef, op.sale);
      });
      return;
    }

    if (op.op === 'refund') {
      await fs.runTransaction(db, async tx => {
        const saleRef = fs.doc(db, 'pos_sales', op.saleId);
        const snap = await tx.get(saleRef);
        if (!snap.exists()) throw new Error('فاتورة المرتجع غير موجودة: ' + op.saleId);
        const sale = snap.data();
        if ((sale.refunds || []).some(r => r.key === op.key)) return; // اتنفذ قبل كده
        const stocked = op.items.filter(it => it.productId);
        const refs = stocked.map(it => fs.doc(db, 'products', String(it.productId)));
        const snaps = [];
        for (const r of refs) snaps.push(await tx.get(r));
        // رد المبلغ: آجل → بينزل من حساب العميل / غير كده → بيخرج من الخزنة الرئيسية
        const isCredit = op.method === 'credit' && sale.customerId;
        const cuRef = isCredit ? fs.doc(db, 'customers', sale.customerId) : null;
        const cuSnap = cuRef ? await tx.get(cuRef) : null;
        const trRef = !isCredit ? fs.doc(db, 'treasuries', MAIN_TREASURY) : null;
        const trSnap = trRef ? await tx.get(trRef) : null;

        snaps.forEach((s, i) => {
          if (!s.exists()) return;
          tx.update(refs[i], MDB.stockPatch(s.data(), stocked[i].size || '', stocked[i].qty));
        });
        if (cuRef && cuSnap.exists()) {
          tx.update(cuRef, { balance: round2((Number(cuSnap.data().balance) || 0) - op.amount) });
        }
        if (trRef) {
          const cur = trSnap.exists() ? (Number(trSnap.data().balance) || 0) : 0;
          tx.set(trRef, { balance: round2(cur - op.amount) }, { merge: true });
          tx.set(fs.doc(fs.collection(db, 'finance_log')), {
            at: op.at, treasuryId: MAIN_TREASURY, amount: -op.amount,
            kind: 'pos_refund', refId: op.saleId, refName: 'مرتجع كاشير من ' + op.saleId,
            note: op.reason || '', by: op.by || '',
          });
        }
        const refundedTotal = round2((Number(sale.refundedTotal) || 0) + op.amount);
        tx.update(saleRef, {
          refunds: [...(sale.refunds || []), {
            key: op.key, items: op.items, amount: op.amount,
            reason: op.reason || '', method: op.method, at: op.at, by: op.by,
          }],
          refundedTotal,
          status: refundedTotal >= Number(sale.total) - 0.01 ? 'refunded' : 'partial',
          updatedAt: op.at,
        });
      });
      return;
    }

    // حركة درج (إيداع/مصروف) → بتتقيد على الخزنة الرئيسية في دفتر اليومية
    if (op.op === 'cashflow') {
      await fs.runTransaction(db, async tx => {
        const logRef = fs.doc(db, 'finance_log', op.key); // id ثابت = عدم تكرار لو اتعادت المحاولة
        if ((await tx.get(logRef)).exists()) return;
        const trRef = fs.doc(db, 'treasuries', MAIN_TREASURY);
        const trSnap = await tx.get(trRef);
        const cur = trSnap.exists() ? (Number(trSnap.data().balance) || 0) : 0;
        const base = trSnap.exists() ? {} : { name: 'الخزنة الرئيسية', openingBalance: 0, createdAt: op.at };
        const signed = op.type === 'in' ? op.amount : -op.amount;
        tx.set(trRef, { ...base, balance: round2(cur + signed) }, { merge: true });
        tx.set(logRef, {
          at: op.at, treasuryId: MAIN_TREASURY, amount: signed,
          kind: op.type === 'in' ? 'deposit' : 'expense',
          refId: op.shiftId || '', refName: (op.type === 'in' ? 'إيداع بالدرج' : 'مصروف من الدرج'),
          note: op.reason || '', by: op.by || '',
        });
      });
      return;
    }
  }

  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let applied = 0;
      sync.syncing = true;
      emit();
      while (navigator.onLine) {
        const q = lsGet(K.queue) || [];
        if (!q.length) break;
        const op = q[0];
        applyingKey = op.key;
        try { await applyOp(op); }
        catch (e) {
          // الترتيب مهم (المرتجع بييجي بعد فاتورته) — منعدّيش عملية فاشلة، نوقف ونحاول لاحقًا
          sync.lastError = (MDB.nice(e) || e).message || 'تعذرت المزامنة';
          break;
        } finally { applyingKey = null; }
        sync.lastError = '';
        applied++;
        lsPut(K.queue, (lsGet(K.queue) || []).filter(x => x.key !== op.key));
        emit();
      }
      sync.syncing = false;
      if (applied) {
        // المخزون الحقيقي اتغيّر — نصفّر كاش اللوحة والمتجر ونجيب كتالوج طازة
        try { AdminAPI.invalidate('products'); } catch { /* تجاهل */ }
        scacheClear();
        try { await catalog(true); } catch { /* أوفلاين تاني — عادي */ }
      }
      emit();
      return applied;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  window.addEventListener('online', () => flush().catch(() => { /* تجاهل */ }));
  setInterval(() => {
    if (navigator.onLine && pending() && !sync.syncing) flush().catch(() => { /* تجاهل */ });
  }, 45 * 1000);

  /* ---------- الكتالوج (منتجات + أقسام) بكاش أوفلاين ---------- */
  async function catalog(force) {
    const raw = lsGet(K.catalog);
    if (!force && raw && raw.t && Date.now() - raw.t < CATALOG_TTL) return raw.d;
    try {
      const { fs, db } = await MDB.fb();
      const [ps, cs] = await Promise.all([
        fs.getDocs(fs.query(fs.collection(db, 'products'), fs.where('active', '==', true))),
        fs.getDocs(fs.collection(db, 'categories')),
      ]);
      const d = {
        products: ps.docs.map(MDB.mapProduct),
        categories: cs.docs.map(x => ({ slug: x.id, ...x.data() }))
          .filter(c => c.active !== false)
          .sort((a, b) => (a.order || 0) - (b.order || 0)),
      };
      lsPut(K.catalog, { t: Date.now(), d });
      return d;
    } catch (e) {
      // النت قاطع — نسخة قديمة أفضل من شاشة فاضية
      if (raw && raw.d) return { ...raw.d, stale: true };
      throw MDB.nice(e);
    }
  }

  /* عملاء الآجل — كاش أوفلاين زي الكتالوج (للبيع الآجل من الكاشير) */
  const CUSTOMERS_KEY = 'pos1:customers';
  async function customersList(force) {
    const raw = lsGet(CUSTOMERS_KEY);
    if (!force && raw && raw.t && Date.now() - raw.t < CATALOG_TTL) return raw.d;
    try {
      const { fs, db } = await MDB.fb();
      const snap = await fs.getDocs(fs.collection(db, 'customers'));
      const d = snap.docs.map(x => {
        const c = x.data();
        return { id: x.id, name: c.name || '', phone: c.phone || '', balance: Number(c.balance) || 0 };
      });
      lsPut(CUSTOMERS_KEY, { t: Date.now(), d });
      return d;
    } catch (e) {
      if (raw && raw.d) return raw.d; // أوفلاين — النسخة المحفوظة
      throw MDB.nice(e);
    }
  }
  function bumpLocalCustomer(cust, delta) {
    const raw = lsGet(CUSTOMERS_KEY) || { t: Date.now(), d: [] };
    const hit = raw.d.find(x => x.id === cust.id);
    if (hit) hit.balance = round2(hit.balance + delta);
    else raw.d.push({ id: cust.id, name: cust.name, phone: cust.phone || '', balance: round2(delta) });
    lsPut(CUSTOMERS_KEY, raw);
  }

  // تعديل المخزون في الكاش المحلي فورًا (لحد ما المزامنة تجيب الأرقام الحقيقية)
  function adjustLocalStock(items, dir) {
    const raw = lsGet(K.catalog);
    if (!raw || !raw.d) return;
    for (const it of items) {
      if (!it.productId) continue;
      const p = raw.d.products.find(x => x.id === String(it.productId));
      if (p) {
        Object.assign(p, MDB.stockPatch(p, it.size || '', dir * it.qty));
        p.inStock = p.stock > 0;
      }
    }
    lsPut(K.catalog, raw);
  }

  /* ---------- الورديات ---------- */
  function currentShift() { return lsGet(K.shift); }

  function queueShift(sh) {
    qAdd({
      op: 'shift',
      key: 'sh:' + sh.id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6),
      coalesce: 'shift:' + sh.id,
      shift: { ...sh },
    });
  }

  async function openShift(openingCash) {
    if (currentShift()) throw new Error('فيه وردية مفتوحة بالفعل');
    openingCash = round2(openingCash);
    if (openingCash < 0) throw new Error('الرصيد الافتتاحي غير صحيح');
    const by = await cashierEmail();
    const sh = {
      id: code('SH'), status: 'open',
      openedAt: new Date().toISOString(), openedBy: by, openingCash,
      sales: 0, total: 0, refunds: 0, cashRefunds: 0,
      pay: { cash: 0, card: 0, wallet: 0, credit: 0 },
      movements: [],
    };
    lsPut(K.shift, sh);
    queueShift(sh);
    return sh;
  }

  // حركة نقدية بالدرج: إيداع (in) أو مصروف/سحب (out)
  async function cashMove(type, amount, reason) {
    const sh = currentShift();
    if (!sh) throw new Error('لا توجد وردية مفتوحة');
    amount = round2(amount);
    if (!(amount > 0)) throw new Error('اكتب مبلغًا صحيحًا');
    const by = await cashierEmail();
    const at = new Date().toISOString();
    sh.movements.push({
      type: type === 'in' ? 'in' : 'out',
      amount, reason: String(reason || '').trim(), at, by,
    });
    lsPut(K.shift, sh);
    queueShift(sh);
    // قيد موازٍ في نظام الحسابات (الخزنة الرئيسية + دفتر اليومية)
    qAdd({ op: 'cashflow', key: 'cf:' + code('CF'), type: type === 'in' ? 'in' : 'out', amount, reason: String(reason || '').trim(), shiftId: sh.id, at, by });
    return sh;
  }

  // الكاش المفروض يكون بالدرج = افتتاحي + مبيعات كاش + إيداعات − مصروفات − مرتجعات كاش
  function expectedCash(sh) {
    const inSum = (sh.movements || []).filter(m => m.type === 'in').reduce((s, m) => s + m.amount, 0);
    const outSum = (sh.movements || []).filter(m => m.type === 'out').reduce((s, m) => s + m.amount, 0);
    return round2((sh.openingCash || 0) + ((sh.pay || {}).cash || 0) + inSum - outSum - (sh.cashRefunds || 0));
  }

  async function closeShift(countedCash) {
    const sh = currentShift();
    if (!sh) throw new Error('لا توجد وردية مفتوحة');
    const by = await cashierEmail();
    const expected = expectedCash(sh);
    const closed = {
      ...sh, status: 'closed',
      closedAt: new Date().toISOString(), closedBy: by,
      expectedCash: expected,
      closingCash: round2(countedCash),
      difference: round2(round2(countedCash) - expected),
    };
    queueShift(closed);
    try { localStorage.removeItem(K.shift); } catch { /* تجاهل */ }
    scacheClear();
    return closed;
  }

  /* ---------- البيع ---------- */
  function calcTotals(items, discount) {
    const subtotal = round2((items || []).reduce((s, it) => s + it.price * it.qty, 0));
    let d = null;
    const val = discount ? Number(discount.value) : 0;
    if (val > 0) {
      const amount = discount.type === 'percent'
        ? round2(subtotal * Math.min(100, val) / 100)
        : round2(Math.min(val, subtotal));
      d = { type: discount.type === 'percent' ? 'percent' : 'fixed', value: val, amount };
    }
    return { subtotal, discount: d, total: round2(subtotal - (d ? d.amount : 0)) };
  }

  async function completeSale({ items, discount, payment, paid, customer, creditCustomer }) {
    const sh = currentShift();
    if (!sh) throw new Error('افتح وردية الأول قبل البيع');
    if (!Array.isArray(items) || !items.length) throw new Error('الفاتورة فاضية');
    payment = PAY_LABELS[payment] ? payment : 'cash';
    const t = calcTotals(items, discount);
    if (!(t.total > 0)) throw new Error('إجمالي الفاتورة غير صحيح');
    let customerId = '', customerName = '', newCustomer = null;
    if (payment === 'credit') {
      // بيع آجل: الاسم ورقم الموبايل إجباريين — بيتسجل على حسابه في نظام الحسابات
      const cc = creditCustomer || {};
      if (!cc.id && String(cc.name || '').trim().length < 2) throw new Error('اختر عميل الآجل أو ضيف عميل جديد');
      if (!cc.id && !/^01[0-9]{9}$/.test(String(cc.phone || '').trim())) throw new Error('رقم موبايل العميل إجباري للبيع الآجل (11 رقم يبدأ بـ01)');
      customerId = cc.id || code('CU');
      customerName = String(cc.name || '').trim();
      if (!cc.id) newCustomer = { id: customerId, name: customerName, phone: String(cc.phone || '').trim() };
      paid = 0;
    } else if (payment === 'cash') {
      paid = round2(paid);
      if (paid + 0.001 < t.total) throw new Error('المبلغ المدفوع أقل من الإجمالي');
    } else paid = t.total;

    const by = await cashierEmail();
    const now = new Date().toISOString();
    const sale = {
      id: code('PS'), source: 'pos', shiftId: sh.id, cashier: by,
      items: items.map(it => ({
        productId: String(it.productId || ''),
        name: String(it.name || ''), image: it.image || '',
        size: String(it.size || ''), color: String(it.color || ''),
        qty: Math.max(1, Math.floor(Number(it.qty) || 1)),
        price: round2(it.price),
        origPrice: round2(it.origPrice !== undefined ? it.origPrice : it.price),
        cost: round2(it.cost || 0),
      })),
      subtotal: t.subtotal, discount: t.discount, total: t.total,
      payment, paid, change: payment === 'credit' ? 0 : round2(paid - t.total),
      customerId, customerName,
      customer: (customer && (customer.name || customer.phone))
        ? { name: String(customer.name || '').trim(), phone: String(customer.phone || '').trim() }
        : null,
      status: 'completed', refunds: [], refundedTotal: 0,
      createdAt: now, updatedAt: now,
      offline: !navigator.onLine,
    };

    qAdd({ op: 'sale', key: sale.id, sale, newCustomer });
    adjustLocalStock(sale.items, -1);
    if (customerId) bumpLocalCustomer({ id: customerId, name: customerName, phone: (newCustomer || {}).phone || '' }, t.total);

    // تحديث عدادات الوردية المحلية
    sh.sales += 1;
    sh.total = round2(sh.total + sale.total);
    sh.pay[payment] = round2((sh.pay[payment] || 0) + sale.total);
    lsPut(K.shift, sh);
    queueShift(sh);
    scacheClear();
    return sale;
  }

  /* ---------- المرتجعات ---------- */
  // البنود القابلة للاسترجاع من فاتورة: الكمية المتبقية + سعر الاسترداد للقطعة
  // (سعر البند بعد توزيع خصم الفاتورة عليه بالنسبة والتناسب)
  function refundableItems(sale) {
    const share = sale.discount && sale.subtotal > 0 ? sale.discount.amount / sale.subtotal : 0;
    return (sale.items || []).map((it, idx) => {
      const returned = (sale.refunds || []).reduce((s, r) =>
        s + (r.items || []).filter(x => x.lineIndex === idx).reduce((a, x) => a + x.qty, 0), 0);
      return {
        lineIndex: idx, productId: it.productId,
        name: it.name, size: it.size, color: it.color,
        qty: it.qty, left: Math.max(0, it.qty - returned),
        unit: round2(it.price * (1 - share)),
      };
    });
  }

  async function refundSale(sale, lines, { reason, method } = {}) {
    lines = (lines || []).filter(l => Number(l.qty) > 0);
    if (!lines.length) throw new Error('حدد كمية للاسترجاع');
    if (!String(reason || '').trim()) throw new Error('سبب المرتجع إجباري');
    const by = await cashierEmail();
    const at = new Date().toISOString();
    const amount = round2(lines.reduce((s, l) => s + l.unit * Math.floor(l.qty), 0));
    method = PAY_LABELS[method] ? method : (sale.payment || 'cash');
    const op = {
      op: 'refund', key: code('RF'), saleId: sale.id,
      items: lines.map(l => ({
        lineIndex: l.lineIndex, productId: String(l.productId || ''),
        name: l.name, size: l.size || '', color: l.color || '',
        qty: Math.floor(l.qty), unit: l.unit,
      })),
      amount, reason: String(reason || '').trim(), method, at, by,
    };
    qAdd(op);
    adjustLocalStock(op.items, +1);
    if (method === 'credit' && sale.customerId) {
      bumpLocalCustomer({ id: sale.customerId, name: sale.customerName || '' }, -amount);
    }

    // المرتجع الكاش بيقلل درج الوردية المفتوحة حاليًا (لو فيه)
    const sh = currentShift();
    if (sh) {
      sh.refunds = round2((sh.refunds || 0) + amount);
      if (method === 'cash') sh.cashRefunds = round2((sh.cashRefunds || 0) + amount);
      lsPut(K.shift, sh);
      queueShift(sh);
    }
    scacheClear();
    return op;
  }

  /* ---------- قراءة السجل (مع دمج المعلّق في الطابور) ---------- */
  async function fetchSales(days) {
    days = Math.min(365, Math.max(1, days || 30));
    const sinceISO = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    let list;
    try {
      list = await scached('sales:' + days, async () => {
        const { fs, db } = await MDB.fb();
        const snap = await fs.getDocs(fs.query(
          fs.collection(db, 'pos_sales'),
          fs.where('createdAt', '>=', sinceISO),
          fs.orderBy('createdAt', 'desc'),
          fs.limit(3000)));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      });
    } catch { list = []; /* أوفلاين — هنعرض المعلّق من الطابور على الأقل */ }
    return overlayQueue(list, sinceISO);
  }

  // دمج عمليات الطابور غير المتزامنة: فواتير معلّقة تظهر فورًا + مرتجعات معلّقة تتطبق
  function overlayQueue(list, sinceISO) {
    const q = lsGet(K.queue) || [];
    const out = list.map(s => ({ ...s, refunds: [...(s.refunds || [])] }));
    for (const op of q) {
      if (op.op === 'sale' && op.sale.createdAt >= sinceISO && !out.some(s => s.id === op.sale.id)) {
        out.unshift({ ...op.sale, refunds: [...(op.sale.refunds || [])], pendingSync: true });
      }
    }
    for (const op of q) {
      if (op.op !== 'refund') continue;
      const s = out.find(x => x.id === op.saleId);
      if (!s || s.refunds.some(r => r.key === op.key)) continue;
      s.refunds.push({ key: op.key, items: op.items, amount: op.amount, reason: op.reason, method: op.method, at: op.at, by: op.by });
      s.refundedTotal = round2((Number(s.refundedTotal) || 0) + op.amount);
      s.status = s.refundedTotal >= Number(s.total) - 0.01 ? 'refunded' : 'partial';
      s.pendingSync = true;
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  }

  async function fetchShifts() {
    let list;
    try {
      list = await scached('shifts', async () => {
        const { fs, db } = await MDB.fb();
        const snap = await fs.getDocs(fs.query(
          fs.collection(db, 'pos_shifts'), fs.orderBy('openedAt', 'desc'), fs.limit(200)));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      });
    } catch { list = []; }
    const out = list.map(s => ({ ...s }));
    // النسخ المعلّقة في الطابور + الوردية المفتوحة محليًا بتتقدم على نسخة السيرفر
    for (const op of (lsGet(K.queue) || [])) {
      if (op.op !== 'shift') continue;
      const i = out.findIndex(x => x.id === op.shift.id);
      if (i >= 0) out[i] = { ...op.shift, pendingSync: true };
      else out.unshift({ ...op.shift, pendingSync: true });
    }
    const cur = currentShift();
    if (cur) {
      const i = out.findIndex(x => x.id === cur.id);
      const view = { ...cur, live: true };
      if (i >= 0) out[i] = view; else out.unshift(view);
    }
    out.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
    return out;
  }

  /* ---------- الفواتير الحرارية (80mm) ---------- */
  async function storeInfo() {
    try { return await MDB.getStoreInfo(); }
    catch { return { storeName: 'MANOVA', phone: '', address: '' }; }
  }

  function rcHead(store) {
    return `
      <div class="rc-head">
        <div class="rc-logo latin">MANOVA</div>
        <div class="rc-slogan latin">TO BE A NEW MAN</div>
        ${store.address ? `<div class="rc-meta">${esc(store.address)}</div>` : ''}
        ${store.phone ? `<div class="rc-meta" dir="ltr">${esc(store.phone)}</div>` : ''}
      </div>`;
  }
  const rcRow = (label, value, cls) =>
    `<div class="rc-row ${cls || ''}"><span>${label}</span><b>${value}</b></div>`;

  function receiptHTML(sale, store) {
    const dt = new Date(sale.createdAt);
    const when = dt.toLocaleDateString('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric' })
      + ' ' + dt.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });
    const items = (sale.items || []).map(it => `
      <div class="rc-item">
        <div class="rc-item-name">${esc(it.name)}${it.size ? ' — ' + esc(it.size) : ''}${it.color ? ' / ' + esc(it.color) : ''}</div>
        <div class="rc-row"><span>${it.qty} × ${fmtN(it.price)}${it.origPrice > it.price ? ` <s>${fmtN(it.origPrice)}</s>` : ''}</span><b>${fmtN(it.qty * it.price)}</b></div>
      </div>`).join('');
    return `
    <div class="rc">
      ${rcHead(store)}
      <div class="rc-sep"></div>
      ${rcRow('فاتورة بيع', `<span class="latin" dir="ltr">${esc(sale.id)}</span>`)}
      ${rcRow('التاريخ', `<span dir="ltr">${when}</span>`)}
      ${rcRow('كاشير', `<span class="latin" dir="ltr">${esc(sale.cashier || '')}</span>`)}
      ${sale.customer ? rcRow('العميل', esc([sale.customer.name, sale.customer.phone].filter(Boolean).join(' — '))) : ''}
      <div class="rc-sep"></div>
      ${items}
      <div class="rc-sep"></div>
      ${rcRow('الإجمالي الفرعي', fmtN(sale.subtotal))}
      ${sale.discount ? rcRow('الخصم' + (sale.discount.type === 'percent' ? ' ' + sale.discount.value + '%' : ''), '-' + fmtN(sale.discount.amount)) : ''}
      ${rcRow('الإجمالي', fmtN(sale.total) + ' ج.م', 'rc-total')}
      ${sale.payment === 'credit'
        ? rcRow('الدفع', 'آجل — على الحساب') + (sale.customerName ? rcRow('العميل', esc(sale.customerName)) : '')
        : rcRow('المدفوع (' + (PAY_LABELS[sale.payment] || sale.payment) + ')', fmtN(sale.paid))
          + (sale.change > 0 ? rcRow('الباقي', fmtN(sale.change)) : '')}
      ${sale.refundedTotal > 0 ? rcRow('مرتجع', '-' + fmtN(sale.refundedTotal)) : ''}
      <div class="rc-sep"></div>
      <div class="rc-foot">
        <div>شكرًا لزيارتكم 🖤</div>
        <div>الاستبدال خلال 14 يوم بالفاتورة وبحالة القطعة الأصلية</div>
      </div>
    </div>`;
  }

  function shiftReportHTML(sh, store) {
    const inSum = (sh.movements || []).filter(m => m.type === 'in').reduce((s, m) => s + m.amount, 0);
    const outSum = (sh.movements || []).filter(m => m.type === 'out').reduce((s, m) => s + m.amount, 0);
    const expected = sh.expectedCash !== undefined ? sh.expectedCash : expectedCash(sh);
    const moves = (sh.movements || []).map(m => `
      <div class="rc-row">
        <span>${m.type === 'in' ? 'إيداع' : 'مصروف'}${m.reason ? ' — ' + esc(m.reason) : ''}</span>
        <b>${m.type === 'in' ? '+' : '-'}${fmtN(m.amount)}</b>
      </div>`).join('');
    return `
    <div class="rc">
      ${rcHead(store)}
      <div class="rc-title">تقرير وردية ${sh.status === 'closed' ? '(إقفال)' : '(مفتوحة)'}</div>
      <div class="rc-sep"></div>
      ${rcRow('الوردية', `<span class="latin" dir="ltr">${esc(sh.id)}</span>`)}
      ${rcRow('فتحت', `<span dir="ltr">${fmtDate(sh.openedAt)}</span>`)}
      ${sh.closedAt ? rcRow('قفلت', `<span dir="ltr">${fmtDate(sh.closedAt)}</span>`) : ''}
      ${rcRow('بواسطة', `<span class="latin" dir="ltr">${esc(sh.openedBy || '')}</span>`)}
      <div class="rc-sep"></div>
      ${rcRow('عدد الفواتير', fmtN(sh.sales))}
      ${rcRow('إجمالي المبيعات', fmtN(sh.total) + ' ج.م', 'rc-total')}
      ${rcRow('— كاش', fmtN((sh.pay || {}).cash || 0))}
      ${rcRow('— بطاقة', fmtN((sh.pay || {}).card || 0))}
      ${rcRow('— محفظة', fmtN((sh.pay || {}).wallet || 0))}
      ${sh.refunds ? rcRow('المرتجعات', '-' + fmtN(sh.refunds) + (sh.cashRefunds ? ' (كاش ' + fmtN(sh.cashRefunds) + ')' : '')) : ''}
      <div class="rc-sep"></div>
      ${rcRow('رصيد افتتاحي', fmtN(sh.openingCash))}
      ${inSum ? rcRow('إيداعات', '+' + fmtN(inSum)) : ''}
      ${outSum ? rcRow('مصروفات', '-' + fmtN(outSum)) : ''}
      ${rcRow('المتوقع بالدرج', fmtN(expected) + ' ج.م', 'rc-total')}
      ${sh.closingCash !== undefined ? rcRow('المعدود فعليًا', fmtN(sh.closingCash)) : ''}
      ${sh.difference !== undefined && sh.difference !== 0 ? rcRow(sh.difference > 0 ? 'زيادة' : 'عجز', fmtN(Math.abs(sh.difference)) + ' ج.م') : ''}
      ${moves ? `<div class="rc-sep"></div><div class="rc-title">حركات الدرج</div>${moves}` : ''}
      <div class="rc-sep"></div>
      <div class="rc-foot"><div class="latin">MANOVA POS</div></div>
    </div>`;
  }

  function printHTML(html) {
    let area = document.getElementById('receipt-area');
    if (!area) {
      area = document.createElement('div');
      area.id = 'receipt-area';
      document.body.appendChild(area);
    }
    area.innerHTML = html;
    document.body.classList.add('print-receipt');
    window.print();
    document.body.classList.remove('print-receipt');
  }

  async function printReceipt(sale) { printHTML(receiptHTML(sale, await storeInfo())); }
  async function printShiftReport(sh) { printHTML(shiftReportHTML(sh, await storeInfo())); }

  /* ---------- تفضيلات الكاشير ---------- */
  function pref(key, val) {
    const p = lsGet(K.pref) || {};
    if (val === undefined) return p[key];
    p[key] = val;
    lsPut(K.pref, p);
    return val;
  }

  return {
    PAY_LABELS, round2, code,
    catalog, adjustLocalStock, customersList,
    currentShift, openShift, cashMove, closeShift, expectedCash,
    calcTotals, completeSale,
    refundableItems, refundSale,
    fetchSales, fetchShifts, scacheClear,
    pending, flush, syncState,
    receiptHTML, shiftReportHTML, printReceipt, printShiftReport,
    pref,
  };
})();

/* حالات فاتورة الكاشير — نفس شكل chips اللوحة */
const POS_STATUS = {
  completed: { label: 'مكتملة', chip: 'delivered' },
  partial: { label: 'مرتجع جزئي', chip: 'confirmed' },
  refunded: { label: 'مرتجعة', chip: 'cancelled' },
};
function posStatusChip(s) {
  const m = POS_STATUS[s] || { label: s, chip: 'new' };
  return `<span class="chip ${m.chip}">${m.label}</span>`;
}
