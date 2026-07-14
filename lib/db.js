// طبقة البيانات — تخزين JSON بسيط وآمن (كتابة ذرّية عبر ملف مؤقت ثم إعادة تسمية)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// مسار البيانات قابل للتهيئة عبر متغير بيئة (مهم للاستضافة بقرص دائم مثل Render)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = null;
let saveTimer = null;

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function load() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    const seed = require('./seed');
    db = seed.buildInitialDb({ hashPassword });
    persistNow();
  }
  return db;
}

function persistNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

// حفظ مؤجّل قليلًا لتجميع التعديلات المتتالية في كتابة واحدة
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { persistNow(); } catch (e) { console.error('DB save failed:', e); }
  }, 50);
}

function nextId(kind) {
  const d = load();
  d.seq[kind] = (d.seq[kind] || 0) + 1;
  save();
  return d.seq[kind];
}

module.exports = { load, save, persistNow, nextId, hashPassword, DATA_DIR };
