/* MANOVA — نظام الحسابات (AccAPI)
   موردين + فواتير شراء + خزن ويوميات + عملاء آجل + شيكات + أصول + حسابات خاصة + أرصدة.

   المبدأ المحاسبي: كل حركة فلوس بتعدي على خزنة وبتتسجل في دفتر اليومية `finance_log`
   (المبلغ بإشارة: + داخل للخزنة / − خارج منها) جوه نفس معاملة runTransaction اللي
   بتعدّل الأرصدة — فمفيش رصيد بيتغير من غير قيد، ومفيش قيد من غير رصيد.

   الكوليكشنز: suppliers · purchases · treasuries · customers · cheques · assets ·
   personal · finance_log — كلها للأدمن فقط (راجع firestore.rules).
   بيعتمد على MDB و AdminAPI و esc/money/fmtDate (admin.js) — حمّلهم قبله. */
const AccAPI = (() => {
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const nowISO = () => new Date().toISOString();

  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function code(prefix) {
    let s = '';
    const rnd = new Uint32Array(6);
    crypto.getRandomValues(rnd);
    for (let i = 0; i < 6; i++) s += CODE_CHARS[rnd[i] % CODE_CHARS.length];
    return prefix + '-' + s;
  }

  async function byEmail() {
    try { const u = await AdminAPI.currentUser(); return (u && u.email) || ''; }
    catch { return ''; }
  }

  /* أنواع قيود اليومية */
  const LOG_KINDS = {
    pos_sale: 'بيع كاشير', pos_refund: 'مرتجع كاشير',
    purchase_payment: 'دفع فاتورة شراء', supplier_payment: 'سداد مورد',
    customer_payment: 'تحصيل من عميل', cheque: 'شيك',
    expense: 'مصروف', deposit: 'إيداع', transfer: 'تحويل بين خزن',
    personal: 'حساب خاص',
  };

  /* ---------- كاش جلسة قصير (نفس نمط اللوحة) ---------- */
  const memo = {};
  const SC_PREFIX = 'acc1:';
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
  function cached(key, fn) {
    if (!memo[key]) {
      memo[key] = (async () => {
        const hit = scGet(key);
        if (hit !== null) return hit;
        const fresh = await fn();
        scPut(key, fresh);
        return fresh;
      })().catch(e => { delete memo[key]; throw e; });
    }
    return memo[key];
  }
  function invalidate() {
    for (const k of Object.keys(memo)) delete memo[k];
    try {
      Object.keys(sessionStorage).filter(k => k.startsWith(SC_PREFIX)).forEach(k => sessionStorage.removeItem(k));
    } catch { /* تجاهل */ }
  }

  async function fetchCol(name, orderField, lim) {
    const { fs, db } = await MDB.fb();
    let q = fs.collection(db, name);
    if (orderField) q = fs.query(q, fs.orderBy(orderField, 'desc'), fs.limit(lim || 300));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  const fetchSuppliers = () => cached('suppliers', () => fetchCol('suppliers'));
  const fetchCustomers = () => cached('customers', () => fetchCol('customers'));
  const fetchCheques = () => cached('cheques', () => fetchCol('cheques'));
  const fetchAssets = () => cached('assets', () => fetchCol('assets'));
  const fetchPersonal = () => cached('personal', () => fetchCol('personal'));
  const fetchPurchases = () => cached('purchases', () => fetchCol('purchases', 'createdAt', 300));

  /* الخزن — أول مرة بننشئ «الخزنة الرئيسية» تلقائيًا (الكاشير بيصب فيها) */
  async function fetchTreasuries() {
    return cached('treasuries', async () => {
      const { fs, db } = await MDB.fb();
      const snap = await fs.getDocs(fs.collection(db, 'treasuries'));
      let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!list.some(t => t.id === 'main')) {
        const main = { name: 'الخزنة الرئيسية', balance: 0, openingBalance: 0, note: 'بتستقبل مبيعات الكاشير تلقائيًا', createdAt: nowISO() };
        await fs.setDoc(fs.doc(db, 'treasuries', 'main'), main, { merge: true });
        list = [{ id: 'main', ...main }, ...list];
      }
      return list.sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : String(a.createdAt).localeCompare(String(b.createdAt))));
    });
  }

  /* ---------- كيانات بسيطة (إنشاء/تعديل) ---------- */
  async function saveEntity(col, id, data) {
    const { fs, db } = await MDB.fb();
    const ref = fs.doc(db, col, id);
    await fs.setDoc(ref, data, { merge: true });
    invalidate();
    return { id, ...data };
  }

  async function createSupplier(b) {
    const name = String(b.name || '').trim();
    if (name.length < 2) throw new Error('اكتب اسم المورد');
    const opening = round2(b.openingBalance);
    return saveEntity('suppliers', code('SU'), {
      name, phone: String(b.phone || '').trim(), address: String(b.address || '').trim(),
      note: String(b.note || '').trim(), openingBalance: opening, balance: opening,
      active: true, createdAt: nowISO(),
    });
  }
  async function updateSupplier(id, b) {
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.phone !== undefined) patch.phone = String(b.phone).trim();
    if (b.address !== undefined) patch.address = String(b.address).trim();
    if (b.note !== undefined) patch.note = String(b.note).trim();
    if (b.active !== undefined) patch.active = !!b.active;
    return saveEntity('suppliers', id, patch);
  }

  async function createCustomer(b) {
    const name = String(b.name || '').trim();
    if (name.length < 2) throw new Error('اكتب اسم العميل');
    const opening = round2(b.openingBalance);
    return saveEntity('customers', code('CU'), {
      name, phone: String(b.phone || '').trim(), address: String(b.address || '').trim(),
      note: String(b.note || '').trim(), openingBalance: opening, balance: opening,
      active: true, createdAt: nowISO(),
    });
  }
  async function updateCustomer(id, b) {
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.phone !== undefined) patch.phone = String(b.phone).trim();
    if (b.address !== undefined) patch.address = String(b.address).trim();
    if (b.note !== undefined) patch.note = String(b.note).trim();
    if (b.active !== undefined) patch.active = !!b.active;
    return saveEntity('customers', id, patch);
  }

  async function createTreasury(b) {
    const name = String(b.name || '').trim();
    if (name.length < 2) throw new Error('اكتب اسم الخزنة');
    const opening = round2(b.openingBalance);
    return saveEntity('treasuries', code('TR'), {
      name, note: String(b.note || '').trim(),
      openingBalance: opening, balance: opening, createdAt: nowISO(),
    });
  }

  async function saveAsset(id, b) {
    const name = String(b.name || '').trim();
    if (name.length < 2) throw new Error('اكتب اسم الأصل');
    if (!(Number(b.value) >= 0)) throw new Error('اكتب قيمة صحيحة');
    return saveEntity('assets', id || code('AS'), {
      name, value: round2(b.value),
      purchasedAt: String(b.purchasedAt || '').trim(),
      note: String(b.note || '').trim(),
      ...(id ? {} : { createdAt: nowISO() }),
    });
  }
  async function deleteAsset(id) {
    const { fs, db } = await MDB.fb();
    await fs.deleteDoc(fs.doc(db, 'assets', id));
    invalidate();
  }

  async function createPersonalAccount(b) {
    const name = String(b.name || '').trim();
    if (name.length < 2) throw new Error('اكتب اسم البند');
    return saveEntity('personal', code('PA'), {
      name, note: String(b.note || '').trim(),
      balance: 0, movements: [], createdAt: nowISO(),
    });
  }

  /* ---------- فاتورة الشراء ----------
     دي اللي بتضيف الكميات للمخزون (بدل الإدخال اليدوي من صفحة المنتجات):
     - بند لمنتج موجود: المخزون += الكمية وسعر التكلفة بيتحدث بآخر شراء
     - بند لمنتج جديد: بيتنشأ المنتج نفسه من جوه الفاتورة (اسم/قسم/سعر بيع/صورة)
     - المدفوع بيخصم من الخزنة المختارة + قيد يومية، والباقي بيزيد رصيد المورد (آجل) */
  async function createPurchase(b) {
    const items = (b.items || []).filter(it => Number(it.qty) > 0);
    if (!items.length) throw new Error('ضيف أصناف للفاتورة');
    for (const it of items) {
      if (!(Number(it.cost) >= 0)) throw new Error('سعر شراء غير صحيح في بند: ' + (it.name || ''));
      if (!it.productId && !(it.newProduct && String(it.newProduct.name || '').trim().length >= 3)) {
        throw new Error('بند غير مرتبط بمنتج');
      }
    }
    const subtotal = round2(items.reduce((s, it) => s + Number(it.cost) * Number(it.qty), 0));
    const discount = Math.min(round2(b.discount), subtotal);
    const total = round2(subtotal - discount);
    const paid = Math.min(round2(b.paid), total);
    const remaining = round2(total - paid);
    if (paid > 0 && !b.treasuryId) throw new Error('اختر الخزنة اللي هيتدفع منها');
    if (!b.supplierId && !(b.newSupplier && String(b.newSupplier.name || '').trim().length >= 2)) {
      throw new Error('اختر المورد');
    }

    const { fs, db } = await MDB.fb();
    const by = await byEmail();
    const at = nowISO();
    const invId = code('PI');
    const supplierId = b.supplierId || code('SU');

    const inv = await fs.runTransaction(db, async tx => {
      /* كل القراءات الأول (شرط معاملات Firestore) */
      const supRef = fs.doc(db, 'suppliers', supplierId);
      const supSnap = b.supplierId ? await tx.get(supRef) : null;
      if (b.supplierId && !supSnap.exists()) throw new Error('المورد غير موجود');
      const trRef = paid > 0 ? fs.doc(db, 'treasuries', b.treasuryId) : null;
      const trSnap = trRef ? await tx.get(trRef) : null;
      if (trRef && !trSnap.exists()) throw new Error('الخزنة غير موجودة');
      const prodSnaps = [];
      for (const it of items) {
        prodSnaps.push(it.productId ? await tx.get(fs.doc(db, 'products', String(it.productId))) : null);
      }

      /* الكتابات */
      const supplierName = b.supplierId ? supSnap.data().name : String(b.newSupplier.name).trim();
      if (!b.supplierId) {
        tx.set(supRef, {
          name: supplierName, phone: String(b.newSupplier.phone || '').trim(),
          address: '', note: '', openingBalance: 0, balance: 0, active: true, createdAt: at,
        });
      }

      const invItems = [];
      items.forEach((it, i) => {
        const qty = Math.floor(Number(it.qty));
        const cost = round2(it.cost);
        let pid = String(it.productId || '');
        let name = String(it.name || '');
        if (pid) {
          const ps = prodSnaps[i];
          if (!ps.exists()) throw new Error('منتج في الفاتورة اتحذف — حدّث الصفحة');
          name = ps.data().name;
          tx.update(ps.ref, { stock: (Number(ps.data().stock) || 0) + qty, cost });
        } else {
          const np = it.newProduct;
          const newRef = fs.doc(fs.collection(db, 'products'));
          pid = newRef.id;
          name = String(np.name).trim();
          tx.set(newRef, {
            name, category: String(np.category || ''), categoryMain: String(np.categoryMain || ''),
            description: '', price: round2(np.price), oldPrice: 0,
            sizes: [], colors: [], images: np.image ? [np.image] : [],
            stock: qty, cost, barcode: String(np.barcode || '').trim(),
            featured: false, active: np.active !== false, createdAt: at,
          });
        }
        invItems.push({ productId: pid, name, qty, cost, total: round2(qty * cost) });
      });

      if (remaining !== 0) {
        const cur = b.supplierId ? (Number(supSnap.data().balance) || 0) : 0;
        tx.set(supRef, { balance: round2(cur + remaining) }, { merge: true });
      }
      if (paid > 0) {
        tx.update(trRef, { balance: round2((Number(trSnap.data().balance) || 0) - paid) });
        tx.set(fs.doc(fs.collection(db, 'finance_log')), {
          at, treasuryId: b.treasuryId, amount: -paid, kind: 'purchase_payment',
          refId: invId, refName: `فاتورة شراء ${invId} — ${supplierName}`,
          note: String(b.note || '').trim(), by,
        });
      }

      const doc = {
        supplierId, supplierName, items: invItems,
        itemsCount: invItems.reduce((s, x) => s + x.qty, 0),
        subtotal, discount, total, paid, remaining,
        treasuryId: paid > 0 ? b.treasuryId : '',
        note: String(b.note || '').trim(), createdAt: at, by,
      };
      tx.set(fs.doc(db, 'purchases', invId), doc);
      return { id: invId, ...doc };
    });

    invalidate();
    AdminAPI.invalidate('products'); // المخزون والتكلفة اتغيروا — المتجر واللوحة يشوفوا فورًا
    return inv;
  }

  /* ---------- سداد مورد / تحصيل من عميل ---------- */
  async function paySupplier(supplierId, amount, treasuryId, note) {
    amount = round2(amount);
    if (!(amount > 0)) throw new Error('اكتب مبلغًا صحيحًا');
    if (!treasuryId) throw new Error('اختر الخزنة');
    const { fs, db } = await MDB.fb();
    const by = await byEmail();
    const at = nowISO();
    await fs.runTransaction(db, async tx => {
      const supRef = fs.doc(db, 'suppliers', supplierId);
      const trRef = fs.doc(db, 'treasuries', treasuryId);
      const [supSnap, trSnap] = [await tx.get(supRef), await tx.get(trRef)];
      if (!supSnap.exists()) throw new Error('المورد غير موجود');
      if (!trSnap.exists()) throw new Error('الخزنة غير موجودة');
      tx.update(supRef, { balance: round2((Number(supSnap.data().balance) || 0) - amount) });
      tx.update(trRef, { balance: round2((Number(trSnap.data().balance) || 0) - amount) });
      tx.set(fs.doc(fs.collection(db, 'finance_log')), {
        at, treasuryId, amount: -amount, kind: 'supplier_payment',
        refId: supplierId, refName: 'سداد للمورد: ' + supSnap.data().name,
        note: String(note || '').trim(), by,
      });
    });
    invalidate();
  }

  async function collectCustomer(customerId, amount, treasuryId, note) {
    amount = round2(amount);
    if (!(amount > 0)) throw new Error('اكتب مبلغًا صحيحًا');
    if (!treasuryId) throw new Error('اختر الخزنة');
    const { fs, db } = await MDB.fb();
    const by = await byEmail();
    const at = nowISO();
    await fs.runTransaction(db, async tx => {
      const cuRef = fs.doc(db, 'customers', customerId);
      const trRef = fs.doc(db, 'treasuries', treasuryId);
      const [cuSnap, trSnap] = [await tx.get(cuRef), await tx.get(trRef)];
      if (!cuSnap.exists()) throw new Error('العميل غير موجود');
      if (!trSnap.exists()) throw new Error('الخزنة غير موجودة');
      tx.update(cuRef, { balance: round2((Number(cuSnap.data().balance) || 0) - amount) });
      tx.update(trRef, { balance: round2((Number(trSnap.data().balance) || 0) + amount) });
      tx.set(fs.doc(fs.collection(db, 'finance_log')), {
        at, treasuryId, amount, kind: 'customer_payment',
        refId: customerId, refName: 'تحصيل من العميل: ' + cuSnap.data().name,
        note: String(note || '').trim(), by,
      });
    });
    invalidate();
  }

  /* ---------- حركات الخزنة: مصروف / إيداع / تحويل ---------- */
  async function treasuryMove(treasuryId, dir, amount, note) {
    amount = round2(amount);
    if (!(amount > 0)) throw new Error('اكتب مبلغًا صحيحًا');
    const signed = dir === 'in' ? amount : -amount;
    const { fs, db } = await MDB.fb();
    const by = await byEmail();
    const at = nowISO();
    await fs.runTransaction(db, async tx => {
      const trRef = fs.doc(db, 'treasuries', treasuryId);
      const trSnap = await tx.get(trRef);
      if (!trSnap.exists()) throw new Error('الخزنة غير موجودة');
      tx.update(trRef, { balance: round2((Number(trSnap.data().balance) || 0) + signed) });
      tx.set(fs.doc(fs.collection(db, 'finance_log')), {
        at, treasuryId, amount: signed, kind: dir === 'in' ? 'deposit' : 'expense',
        refId: '', refName: dir === 'in' ? 'إيداع في الخزنة' : 'مصروف',
        note: String(note || '').trim(), by,
      });
    });
    invalidate();
  }

  async function treasuryTransfer(fromId, toId, amount, note) {
    amount = round2(amount);
    if (!(amount > 0)) throw new Error('اكتب مبلغًا صحيحًا');
    if (fromId === toId) throw new Error('اختر خزنتين مختلفتين');
    const { fs, db } = await MDB.fb();
    const by = await byEmail();
    const at = nowISO();
    await fs.runTransaction(db, async tx => {
      const fromRef = fs.doc(db, 'treasuries', fromId);
      const toRef = fs.doc(db, 'treasuries', toId);
      const [fromSnap, toSnap] = [await tx.get(fromRef), await tx.get(toRef)];
      if (!fromSnap.exists() || !toSnap.exists()) throw new Error('الخزنة غير موجودة');
      tx.update(fromRef, { balance: round2((Number(fromSnap.data().balance) || 0) - amount) });
      tx.update(toRef, { balance: round2((Number(toSnap.data().balance) || 0) + amount) });
      const noteStr = String(note || '').trim();
      tx.set(fs.doc(fs.collection(db, 'finance_log')), {
        at, treasuryId: fromId, amount: -amount, kind: 'transfer',
        refId: toId, refName: 'تحويل إلى: ' + toSnap.data().name, note: noteStr, by,
      });
      tx.set(fs.doc(fs.collection(db, 'finance_log')), {
        at, treasuryId: toId, amount, kind: 'transfer',
        refId: fromId, refName: 'تحويل من: ' + fromSnap.data().name, note: noteStr, by,
      });
    });
    invalidate();
  }

  /* ---------- الحسابات الخاصة (بنود صاحب البراند) ----------
     إيداع في البند = فلوس اتحطت فيه (لو مربوط بخزنة: بتخرج من الخزنة)
     سحب من البند = فلوس خرجت منه (لو مربوط بخزنة: بترجع للخزنة) */
  async function personalMove(accountId, type, amount, treasuryId, note) {
    amount = round2(amount);
    if (!(amount > 0)) throw new Error('اكتب مبلغًا صحيحًا');
    const { fs, db } = await MDB.fb();
    const by = await byEmail();
    const at = nowISO();
    await fs.runTransaction(db, async tx => {
      const accRef = fs.doc(db, 'personal', accountId);
      const accSnap = await tx.get(accRef);
      if (!accSnap.exists()) throw new Error('البند غير موجود');
      const trRef = treasuryId ? fs.doc(db, 'treasuries', treasuryId) : null;
      const trSnap = trRef ? await tx.get(trRef) : null;
      if (trRef && !trSnap.exists()) throw new Error('الخزنة غير موجودة');
      const acc = accSnap.data();
      const signed = type === 'in' ? amount : -amount;
      tx.update(accRef, {
        balance: round2((Number(acc.balance) || 0) + signed),
        movements: [...(acc.movements || []), { type: type === 'in' ? 'in' : 'out', amount, treasuryId: treasuryId || '', note: String(note || '').trim(), at, by }],
      });
      if (trRef) {
        tx.update(trRef, { balance: round2((Number(trSnap.data().balance) || 0) - signed) });
        tx.set(fs.doc(fs.collection(db, 'finance_log')), {
          at, treasuryId, amount: -signed, kind: 'personal',
          refId: accountId, refName: (type === 'in' ? 'إيداع في بند خاص: ' : 'سحب من بند خاص: ') + acc.name,
          note: String(note || '').trim(), by,
        });
      }
    });
    invalidate();
  }

  /* ---------- الشيكات ----------
     شيك لمورد = هندفعه (بيخصم من رصيد المورد ومن الخزنة عند الصرف)
     شيك من عميل = هنقبضه (بيخصم من رصيد العميل ويدخل الخزنة عند الصرف)
     الصرف بيحصل تلقائيًا أول ما تاريخ الاستحقاق يعدي (بيتفحص مع فتح صفحات الحسابات) */
  async function addCheque(b) {
    if (!['supplier', 'customer'].includes(b.party)) throw new Error('اختر نوع الشيك');
    if (!b.partyId) throw new Error('اختر ' + (b.party === 'supplier' ? 'المورد' : 'العميل'));
    const amount = round2(b.amount);
    if (!(amount > 0)) throw new Error('اكتب مبلغًا صحيحًا');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate || ''))) throw new Error('اختر تاريخ الاستحقاق');
    if (!b.treasuryId) throw new Error('اختر الخزنة');
    const id = code('CH');
    return saveEntity('cheques', id, {
      party: b.party, partyId: b.partyId, partyName: String(b.partyName || '').trim(),
      amount, dueDate: b.dueDate, treasuryId: b.treasuryId,
      chequeNo: String(b.chequeNo || '').trim(), note: String(b.note || '').trim(),
      status: 'pending', createdAt: nowISO(), cashedAt: '',
    });
  }

  async function cashCheque(ch) {
    const { fs, db } = await MDB.fb();
    const by = await byEmail();
    const at = nowISO();
    await fs.runTransaction(db, async tx => {
      const chRef = fs.doc(db, 'cheques', ch.id);
      const chSnap = await tx.get(chRef);
      if (!chSnap.exists() || chSnap.data().status !== 'pending') return; // اتصرف قبل كده
      const c = chSnap.data();
      const partyRef = fs.doc(db, c.party === 'supplier' ? 'suppliers' : 'customers', c.partyId);
      const trRef = fs.doc(db, 'treasuries', c.treasuryId);
      const [partySnap, trSnap] = [await tx.get(partyRef), await tx.get(trRef)];
      if (!trSnap.exists()) throw new Error('خزنة الشيك غير موجودة');
      const signed = c.party === 'supplier' ? -c.amount : c.amount; // مورد: بندفع / عميل: بنقبض
      if (partySnap.exists()) {
        tx.update(partyRef, { balance: round2((Number(partySnap.data().balance) || 0) - c.amount) });
      }
      tx.update(trRef, { balance: round2((Number(trSnap.data().balance) || 0) + signed) });
      tx.update(chRef, { status: 'cashed', cashedAt: at });
      tx.set(fs.doc(fs.collection(db, 'finance_log')), {
        at, treasuryId: c.treasuryId, amount: signed, kind: 'cheque',
        refId: c.partyId, refName: `شيك ${ch.id} — ${c.partyName}`, note: c.note || '', by,
      });
    });
    invalidate();
  }

  async function cancelCheque(id) {
    const { fs, db } = await MDB.fb();
    await fs.updateDoc(fs.doc(db, 'cheques', id), { status: 'cancelled' });
    invalidate();
  }

  // بيتنده مع فتح أي صفحة حسابات: أي شيك معلّق عدى استحقاقه بيتصرف تلقائيًا
  async function processDueCheques() {
    let cheques;
    try { cheques = await fetchCheques(); } catch { return 0; }
    const today = new Date().toISOString().slice(0, 10);
    const due = cheques.filter(c => c.status === 'pending' && c.dueDate <= today);
    let done = 0;
    for (const c of due) {
      try { await cashCheque(c); done++; }
      catch { /* هيتعاد في الفتحة الجاية */ }
    }
    if (done) invalidate();
    return done;
  }

  /* ---------- اليوميات (دفتر الحركة) ---------- */
  async function fetchLog(fromISO, toISO) {
    return cached('log:' + fromISO + ':' + toISO, async () => {
      const { fs, db } = await MDB.fb();
      const snap = await fs.getDocs(fs.query(
        fs.collection(db, 'finance_log'),
        fs.where('at', '>=', fromISO), fs.where('at', '<', toISO),
        fs.orderBy('at', 'desc'), fs.limit(500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    });
  }

  // مبيعات الكاشير في يوم معيّن — لحساب ربح اليوم (إيراد − تكلفة − مصروفات)
  async function dayProfit(dayISO) {
    const from = dayISO, to = new Date(new Date(dayISO + 'T00:00:00').getTime() + 86400000).toISOString().slice(0, 10);
    const { fs, db } = await MDB.fb();
    const [salesSnap, log] = await Promise.all([
      cached('psales:' + dayISO, async () => {
        const snap = await fs.getDocs(fs.query(
          fs.collection(db, 'pos_sales'),
          fs.where('createdAt', '>=', from), fs.where('createdAt', '<', to), fs.limit(1000)));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }),
      fetchLog(from, to),
    ]);
    let revenue = 0, cogs = 0, refunds = 0;
    for (const s of salesSnap) {
      revenue += s.total;
      for (const it of s.items || []) cogs += (Number(it.cost) || 0) * it.qty;
    }
    // المرتجعات اللي حصلت اليوم ده (حتى لو فاتورتها قديمة) بتتجاب من قيود اليومية
    for (const l of log) if (l.kind === 'pos_refund') refunds += Math.abs(l.amount);
    const expenses = log.filter(l => l.kind === 'expense').reduce((s, l) => s + Math.abs(l.amount), 0);
    return {
      revenue: round2(revenue), cogs: round2(cogs), refunds: round2(refunds),
      expenses: round2(expenses),
      profit: round2(revenue - refunds - cogs - expenses),
      salesCount: salesSnap.length,
    };
  }

  /* ---------- الأرصدة (صافي ما تملكه) ---------- */
  async function balances() {
    const [products, suppliers, customers, treasuries, assets] = await Promise.all([
      AdminAPI.get('/api/admin/products'),
      fetchSuppliers(), fetchCustomers(), fetchTreasuries(), fetchAssets(),
    ]);
    let inventory = 0, inventoryNoCost = 0;
    for (const p of products) {
      if (!p.stock) continue;
      if (p.cost > 0) inventory += p.cost * p.stock;
      else { inventory += p.price * p.stock; inventoryNoCost++; } // فولباك لسعر البيع لحد ما تسجل تكلفة
    }
    const cash = treasuries.reduce((s, t) => s + (Number(t.balance) || 0), 0);
    const receivables = customers.reduce((s, c) => s + Math.max(0, Number(c.balance) || 0), 0);
    const assetsTotal = assets.reduce((s, a) => s + (Number(a.value) || 0), 0);
    const payables = suppliers.reduce((s, x) => s + Math.max(0, Number(x.balance) || 0), 0);
    return {
      inventory: round2(inventory), inventoryNoCost,
      cash: round2(cash), receivables: round2(receivables),
      assets: round2(assetsTotal), payables: round2(payables),
      net: round2(inventory + cash + receivables + assetsTotal - payables),
      counts: { products: products.filter(p => p.stock > 0).length, suppliers: suppliers.length, customers: customers.length, assets: assets.length, treasuries: treasuries.length },
    };
  }

  /* كشف حساب مورد/عميل: فواتير + سدادات + شيكات بصف رصيد تراكمي */
  async function supplierStatement(sup) {
    const [purchases, log, cheques] = await Promise.all([
      fetchPurchases(), fetchLog('2000-01-01', '2100-01-01'), fetchCheques(),
    ]);
    const rows = [];
    for (const p of purchases.filter(x => x.supplierId === sup.id)) {
      rows.push({ at: p.createdAt, label: `فاتورة شراء ${p.id}${p.paid ? ` (مدفوع ${money(p.paid)})` : ''}`, delta: p.remaining });
    }
    for (const l of log.filter(x => x.refId === sup.id && x.kind === 'supplier_payment')) {
      rows.push({ at: l.at, label: 'سداد' + (l.note ? ' — ' + l.note : ''), delta: l.amount }); // سالب
    }
    for (const c of cheques.filter(x => x.partyId === sup.id && x.status === 'cashed')) {
      rows.push({ at: c.cashedAt, label: `شيك ${c.id}`, delta: -c.amount });
    }
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    let running = Number(sup.openingBalance) || 0;
    if (running) rows.unshift({ at: sup.createdAt, label: 'رصيد افتتاحي', delta: 0, running });
    for (const r of rows) { if (r.running === undefined) { running = round2(running + r.delta); r.running = running; } }
    return rows.reverse();
  }

  return {
    round2, code, LOG_KINDS,
    fetchSuppliers, fetchCustomers, fetchTreasuries, fetchCheques,
    fetchAssets, fetchPersonal, fetchPurchases, fetchLog,
    invalidate,
    createSupplier, updateSupplier, createCustomer, updateCustomer,
    createTreasury, saveAsset, deleteAsset, createPersonalAccount,
    createPurchase, paySupplier, collectCustomer,
    treasuryMove, treasuryTransfer, personalMove,
    addCheque, cashCheque, cancelCheque, processDueCheques,
    dayProfit, balances, supplierStatement,
  };
})();
