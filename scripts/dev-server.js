// MANOVA — خادم معاينة محلي بسيط (بدون أي حزم خارجية)
// يحاكي سلوك Cloudflare Pages: روابط بدون .html + صفحة 404
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  let p = path.normalize(path.join(ROOT, clean));
  if (!p.startsWith(ROOT)) return null; // منع الخروج خارج مجلد public
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
  return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

http.createServer((req, res) => {
  const file = resolveFile(req.url);
  const target = file || path.join(ROOT, '404.html');
  res.writeHead(file ? 200 : 404, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}).listen(PORT, () => {
  console.log('');
  console.log('  ███ MANOVA Store — معاينة محلية ███');
  console.log(`  المتجر:        http://localhost:${PORT}`);
  console.log(`  لوحة التحكم:   http://localhost:${PORT}/admin`);
  console.log('');
  console.log('  (المعاينة بتتصل بقاعدة بيانات Firebase الحقيقية — لازم تكون مالي js/firebase-config.js)');
  console.log('');
});
