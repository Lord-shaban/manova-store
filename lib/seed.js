// البيانات المبدئية: منتجات بصور حقيقية + طلبات تجريبية للداشبورد
const crypto = require('crypto');

const TEE_SIZES = ['M', 'L', 'XL', '2XL'];
const OVER_SIZES = ['L', 'XL', '2XL'];

// الأقسام — يقدر صاحب المتجر يزوّد عليها من لوحة التحكم (بناطيل، كابات، أحزمة، جزم… إلخ)
const CATEGORY_DEFS = [
  { slug: 'basic', name: 'بيسيك', subtitle: 'تيشرتات سادة بلوجو مانوفا — ألوان متعددة بقصّة أوفرسايز', order: 1, active: true },
  { slug: 'printed', name: 'مطبوع', subtitle: 'تيشرتات أوفرسايز بطبعات جرافيك ثابتة على الصدر', order: 2, active: true },
];

const PRODUCT_DEFS = [
  // ===== مطبوع =====
  { img: 'tee-hope-maroon.jpeg',
    name: 'تيشرت أوفرسايز نبيتي — طبعة Hope Never Quits', category: 'printed', price: 390, oldPrice: 0, featured: true, stock: 22,
    sizes: OVER_SIZES, colors: ['نبيتي'],
    description: 'تيشرت أوفرسايز لونه نبيتي غامق، قدّامه طبعة كبيرة مكتوب فيها Hope Never Quits. قطن مصري تقيل، قصّة واسعة وكتف نازل، والطبعة تقيلة ومتتشققش مع الغسيل. بيجي شيك مع الكارجو أو الجينز.' },
  { img: 'tee-focus-grey.jpeg',
    name: 'تيشرت أوفرسايز رمادي — طبعة Focus', category: 'printed', price: 370, oldPrice: 0, featured: false, stock: 20,
    sizes: OVER_SIZES, colors: ['رمادي فاتح'],
    description: 'تيشرت أوفرسايز رمادي فاتح، قدّامه طبعة بسيطة مكتوب فيها Focus. خامة قطن ناعمة وقصّة واسعة مريحة، ولون هادي بيتلبس مع أي حاجة كاجوال.' },
  { img: 'tee-wanderlust-brown.jpeg',
    name: 'تيشرت أوفرسايز بني — طبعة Wanderlust', category: 'printed', price: 380, oldPrice: 0, featured: true, stock: 18,
    sizes: OVER_SIZES, colors: ['بني'],
    description: 'تيشرت أوفرسايز لونه بني ترابي دافي، قدّامه طبعة جبال ومكتوب Wanderlust. قطن تقيل وقصّة واسعة مضبوطة — قطعة تكسر روتين الألوان العادية.' },
  { img: 'tee-knocks-black.jpeg',
    name: 'تيشرت أوفرسايز أسود — طبعة I Am The One Who Knocks', category: 'printed', price: 380, oldPrice: 0, featured: false, stock: 16,
    sizes: OVER_SIZES, colors: ['أسود'],
    description: 'تيشرت أوفرسايز أسود، قدّامه طبعة بألوان متدرجة مكتوب فيها I Am The One Who Knocks. قطن أسود تقيل بلون ثابت لا يبهت — لأصحاب الستايل الجريء.' },
  { img: 'tee-brokenplanet-maroon.jpeg',
    name: 'تيشرت أوفرسايز نبيتي — طبعة Broken Planet', category: 'printed', price: 400, oldPrice: 0, featured: true, stock: 15,
    sizes: OVER_SIZES, colors: ['نبيتي غامق'],
    description: 'تيشرت أوفرسايز نبيتي غامق بغسلة فينتدج، قدّامه طبعة كوكب ومكتوب Broken Planet. قطن تقيل بملمس فخم وقصّة واسعة تدّي القطعة كاراكتر مميز.' },
  { img: 'tee-brokenplanet-brown.jpeg',
    name: 'تيشرت أوفرسايز بني — طبعة Broken Planet', category: 'printed', price: 400, oldPrice: 0, featured: false, stock: 15,
    sizes: OVER_SIZES, colors: ['بني غامق'],
    description: 'نفس طبعة Broken Planet بلون بني رمادي بغسلة فينتدج. قطن أوفرسايز تقيل وطبعة صدر ثابتة، ولون سهل تنسّقه مع الكارجو الأسود.' },
  // ===== بيسيك =====
  { img: 'tee-basic-white.jpeg',
    name: 'تيشرت بيسيك أبيض', category: 'basic', price: 290, oldPrice: 0, featured: true, stock: 30,
    sizes: TEE_SIZES, colors: ['أبيض'],
    description: 'تيشرت سادة لونه أبيض نظيف، وعليه لوجو مانوفا صغير على الصدر. قطن مصري 100% بوزن مريح وقصّة أوفرسايز مضبوطة — الأساس اللي بيتلبس مع أي حاجة.' },
  { img: 'tee-basic-black.jpeg',
    name: 'تيشرت بيسيك أسود', category: 'basic', price: 290, oldPrice: 0, featured: true, stock: 30,
    sizes: TEE_SIZES, colors: ['أسود'],
    description: 'تيشرت سادة أسود بلوجو مانوفا صغير على الصدر. خامة قطن تقيلة بلون ثابت لا يبهت وقصّة أوفرسايز نضيفة — اللون اللي بيكمّل أي لوك.' },
  { img: 'tee-basic-grey.jpeg',
    name: 'تيشرت بيسيك رمادي', category: 'basic', price: 290, oldPrice: 0, featured: false, stock: 26,
    sizes: TEE_SIZES, colors: ['رمادي'],
    description: 'تيشرت سادة لونه رمادي غامق بلوجو مانوفا صغير. قطن ناعم بقصّة أوفرسايز، ولون عملي بيتلبس في أي وقت.' },
  { img: 'tee-basic-brown.jpeg',
    name: 'تيشرت بيسيك بني', category: 'basic', price: 290, oldPrice: 0, featured: false, stock: 24,
    sizes: TEE_SIZES, colors: ['بني'],
    description: 'تيشرت سادة لونه بني قهوي دافي بلوجو مانوفا صغير. قطن مصري بقصّة أوفرسايز مريحة، ولون ترابي شيك يفرق في الستايل.' },
  { img: 'tee-basic-petrol.jpeg',
    name: 'تيشرت بيسيك أزرق بترولي', category: 'basic', price: 290, oldPrice: 0, featured: true, stock: 22,
    sizes: TEE_SIZES, colors: ['أزرق بترولي'],
    description: 'تيشرت سادة لونه أزرق بترولي مميز بلوجو مانوفا صغير. قطن تقيل بقصّة أوفرسايز، ولون مختلف يخرجك من الألوان التقليدية.' },
  { img: 'tee-basic-green.jpeg',
    name: 'تيشرت بيسيك أخضر', category: 'basic', price: 290, oldPrice: 0, featured: false, stock: 20,
    sizes: TEE_SIZES, colors: ['أخضر غامق'],
    description: 'تيشرت سادة لونه أخضر غامق (زيتي غني) بلوجو مانوفا صغير. قطن مصري ناعم بقصّة أوفرسايز، ولون هادي وشيك.' },
  { img: 'tee-basic-sand.jpeg',
    name: 'تيشرت بيسيك بيج', category: 'basic', price: 290, oldPrice: 0, featured: false, stock: 22,
    sizes: TEE_SIZES, colors: ['بيج'],
    description: 'تيشرت سادة لونه بيج رملي فاتح بلوجو مانوفا صغير. قطن بوزن مريح وقصّة أوفرسايز، ولون نيوترال بيتنسّق مع أي حاجة.' },
  { img: 'tee-basic-burgundy.jpeg',
    name: 'تيشرت بيسيك نبيتي', category: 'basic', price: 290, oldPrice: 0, featured: false, stock: 20,
    sizes: TEE_SIZES, colors: ['نبيتي'],
    description: 'تيشرت سادة لونه نبيتي (بوردو) بلوجو مانوفا صغير. قطن تقيل بلون غني ثابت وقصّة أوفرسايز، ولون دافي يكسر الروتين.' },
];

const DEMO_NAMES = ['أحمد محمود', 'محمد عبدالله', 'مصطفى حسن', 'كريم السيد', 'عمر خالد', 'يوسف علي',
  'إبراهيم فتحي', 'حسين عادل', 'طارق رمضان', 'شريف جمال', 'محمود صابر', 'علي حمدي', 'أنس صلاح', 'زياد ناصر'];
const DEMO_STREETS = ['شارع المحطة', 'شارع البحر', 'شارع المعبد', 'حي السلام', 'شارع الجمهورية', 'المنشية', 'شارع السوق', 'حي الزهور'];

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rndInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

function buildDemoOrders(products, shipping) {
  const orders = [];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  let seq = 1000;
  for (let i = 0; i < 48; i++) {
    const ageDays = Math.pow(Math.random(), 1.4) * 35; // أحدث أكثر كثافة
    const created = new Date(now - ageDays * DAY - rndInt(0, 12) * 3600 * 1000);
    const nItems = rndInt(1, 3);
    const items = [];
    const used = new Set();
    for (let j = 0; j < nItems; j++) {
      const p = rnd(products);
      if (used.has(p.id)) continue;
      used.add(p.id);
      items.push({
        productId: p.id, name: p.name, price: p.price, image: p.images[0],
        size: rnd(p.sizes), color: rnd(p.colors), qty: rndInt(1, 2),
      });
    }
    const zone = rnd(shipping);
    const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    let status;
    if (ageDays > 7) status = Math.random() < 0.72 ? 'delivered' : (Math.random() < 0.6 ? 'shipped' : 'cancelled');
    else if (ageDays > 3) status = rnd(['shipped', 'confirmed', 'delivered']);
    else status = rnd(['new', 'new', 'confirmed']);
    seq += 1;
    const createdIso = created.toISOString();
    orders.push({
      id: 'MN-' + seq,
      demo: true,
      customer: {
        name: rnd(DEMO_NAMES),
        phone: '01' + rnd(['0', '1', '2', '5']) + String(rndInt(10000000, 99999999)),
        address: rnd(DEMO_STREETS) + '، بجوار ' + rnd(['المسجد', 'المدرسة', 'الصيدلية', 'الموقف']),
        zone: zone.name,
        notes: '',
      },
      payment: rnd(['cod', 'cod', 'cod', 'wallet']),
      items,
      subtotal,
      shippingFee: zone.fee,
      total: subtotal + zone.fee,
      status,
      createdAt: createdIso,
      updatedAt: createdIso,
      statusHistory: [{ status: 'new', at: createdIso }],
    });
  }
  orders.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  return { orders, lastSeq: seq };
}

function buildInitialDb({ hashPassword }) {
  const products = PRODUCT_DEFS.map((def, i) => ({
    id: i + 1,
    name: def.name,
    category: def.category,
    description: def.description,
    price: def.price,
    oldPrice: def.oldPrice,
    sizes: def.sizes,
    colors: def.colors,
    images: ['/images/products/' + def.img],
    stock: def.stock,
    featured: def.featured,
    active: true,
    createdAt: new Date().toISOString(),
  }));

  const shipping = [
    { name: 'اسنا وضواحيها', fee: 20 },
    { name: 'الأقصر', fee: 35 },
    { name: 'قنا / أسوان', fee: 45 },
    { name: 'باقي المحافظات', fee: 65 },
  ];

  const { orders, lastSeq } = buildDemoOrders(products, shipping);
  const salt = crypto.randomBytes(16).toString('hex');
  // بيانات دخول المدير الأولى — من متغيرات البيئة إن وُجدت (يُنصح بضبطها في الاستضافة)
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'manova123';

  return {
    seq: { order: lastSeq, product: products.length },
    categories: CATEGORY_DEFS.map(c => ({ ...c })),
    products,
    orders,
    settings: {
      storeName: 'MANOVA',
      slogan: 'TO BE A NEW MAN',
      heroTitle: 'أساسيات رجالي بمستوى مختلف',
      heroSubtitle: 'تيشرتات بيسيك ومطبوعة بخامات قطن مختارة وقصّات أوفرسايز مضبوطة — من اسنا إلى باب بيتك، والدفع عند الاستلام.',
      announcement: 'شحن لجميع المحافظات — الدفع عند الاستلام',
      phone: '01000000000',
      whatsapp: '201000000000',
      address: 'اسنا — محافظة الأقصر',
      facebook: '',
      instagram: '',
      tiktok: '',
      shipping,
      freeShippingOver: 1500,
      walletNumber: '01000000000',
    },
    admin: { username: adminUser, salt, hash: hashPassword(adminPass, salt) },
    sessions: {},
  };
}

module.exports = { buildInitialDb, buildDemoOrders, CATEGORY_DEFS };
