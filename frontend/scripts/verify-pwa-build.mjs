/**
 * ตรวจผลลัพธ์ของการ build ว่าตรงกับนโยบายที่ประกาศไว้ (F24-B)
 *
 * **ทำไมต้องตรวจที่ผลลัพธ์ ไม่ใช่แค่ที่ค่าตั้ง:** ค่าตั้งบอกเจตนา แต่สิ่งที่ไปอยู่บน
 * เครื่องผู้ใช้คือไฟล์ที่ Workbox สร้างออกมาจริง รูปแบบ glob ที่เขียนผิดนิดเดียว
 * หรือปลั๊กอินที่เพิ่มรายการให้เองโดยไม่ได้ขอ จะไม่ปรากฏในค่าตั้งเลย
 *
 * วิธีใช้: node scripts/verify-pwa-build.mjs   (ต้อง build ก่อน)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

// ---- ไฟล์ที่ต้องมี ----
for (const required of ['sw.js', 'manifest.webmanifest', 'index.html', 'apple-touch-icon.png',
  'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png']) {
  check(fs.existsSync(path.join(dist, required)), `ขาดไฟล์ ${required}`);
}

// ---- manifest ----
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'));
check(manifest.name === 'S2 NAS', 'ชื่อแอปใน manifest ไม่ถูกต้อง');
check(manifest.display === 'standalone', 'display ต้องเป็น standalone จึงจะติดตั้งได้');
check(manifest.start_url === '/', 'start_url ต้องเป็น /');
check(manifest.icons.some((i) => i.sizes === '192x192'), 'ขาดไอคอน 192x192');
check(manifest.icons.some((i) => i.sizes === '512x512'), 'ขาดไอคอน 512x512');
check(manifest.icons.some((i) => i.purpose === 'maskable'), 'ขาดไอคอน maskable');
for (const icon of manifest.icons) {
  check(fs.existsSync(path.join(dist, icon.src.replace(/^\//, ''))), `ไอคอนที่ประกาศไว้ไม่มีจริง: ${icon.src}`);
}

// ---- ไฟล์ที่ index.html อ้างถึงต้องมีอยู่จริง ----
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
for (const [, href] of html.matchAll(/href="(\/[^"]+\.(?:png|svg|ico|webmanifest))"/g)) {
  check(fs.existsSync(path.join(dist, href.replace(/^\//, ''))), `index.html อ้างถึงไฟล์ที่ไม่มีอยู่: ${href}`);
}

// ---- รายการที่ถูกเก็บล่วงหน้า ----
const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
const precached = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);
check(precached.length > 0, 'ไม่พบรายการเก็บล่วงหน้าใน sw.js');

const unique = new Set(precached);
check(unique.size === precached.length,
  `มีรายการซ้ำในการเก็บล่วงหน้า: ${precached.filter((u, i) => precached.indexOf(u) !== i).join(', ')}`);

/**
 * ใช้รายการอนุญาต ไม่ใช่รายการห้าม
 *
 * รายการห้ามที่จับจากชื่อไฟล์จะเข้าใจผิดได้ง่าย เช่น ก้อนโค้ดชื่อ PreviewModal.js
 * เป็นโค้ดของหน้าจอ ไม่ใช่เอกสารของใคร ส่วนรายการอนุญาตตอบคำถามที่ถูกต้องกว่าว่า
 * "สิ่งนี้เป็นไฟล์ของแอปหรือเปล่า" ซึ่งเป็นเกณฑ์จริงที่เราสนใจ
 */
const ALLOWED_FILES = new Set([
  'index.html', 'favicon.ico', 'favicon.svg', 'favicon.png',
  'favicon-32x32.png', 'favicon-16x16.png', 'apple-touch-icon.png',
  's2-nas-logo.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png',
  'manifest.webmanifest', 'registerSW.js',
]);
const ALLOWED_ASSET = /^assets\/[^/]+\.(?:js|css|woff2)$/;

for (const url of precached) {
  const allowed = ALLOWED_FILES.has(url) || ALLOWED_ASSET.test(url);
  check(allowed, `ไม่อยู่ในรายการไฟล์ของแอปที่อนุญาตให้เก็บล่วงหน้า: ${url}`);
  // ฟอนต์รุ่นเก่าและชุดอักษรที่ไม่ได้ใช้ ถูกกันด้วยเงื่อนไขเฉพาะเพื่อให้ข้อความชัดเจน
  check(!/\.woff$/.test(url), `ห้ามเก็บฟอนต์รุ่นเก่า: ${url}`);
  check(!/vietnamese/.test(url), `ห้ามเก็บชุดอักษรที่ไม่ได้ใช้: ${url}`);
  check(!/\/api\//.test(url), `ห้ามเก็บคำตอบของ API: ${url}`);
  check(fs.existsSync(path.join(dist, url)), `รายการเก็บล่วงหน้าชี้ไปยังไฟล์ที่ไม่มีอยู่: ${url}`);
}

// ---- ต้องไม่มีการตั้ง runtime caching สำหรับข้อมูลผู้ใช้ ----
check(!/registerRoute\([^)]*\/api\//.test(sw), 'sw.js มีเส้นทาง runtime cache ที่แตะ /api');

// ---- ขนาดของสิ่งที่ผู้ใช้ต้องดาวน์โหลดตอนติดตั้ง ----
let precacheBytes = 0;
for (const url of unique) {
  try { precacheBytes += fs.statSync(path.join(dist, url)).size; } catch { /* รายงานไปแล้วข้างบน */ }
}
notes.push(`รายการเก็บล่วงหน้า ${unique.size} รายการ รวม ${(precacheBytes / 1024).toFixed(1)} KiB`);

const jsFiles = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));
const largest = jsFiles
  .map((f) => ({ f, size: fs.statSync(path.join(dist, 'assets', f)).size }))
  .sort((a, b) => b.size - a.size)[0];
notes.push(`ไฟล์ JS ใหญ่ที่สุด ${largest.f} = ${(largest.size / 1024).toFixed(1)} KiB จากทั้งหมด ${jsFiles.length} ไฟล์`);

// ---- ต้องไม่มีเนื้อหาของผู้ใช้หลุดเข้าไปใน dist ----
const suspicious = fs.readdirSync(dist).filter((f) => /\.(pdf|docx?|xlsx?|csv|zip)$/i.test(f));
check(suspicious.length === 0, `พบไฟล์เอกสารใน dist: ${suspicious.join(', ')}`);

for (const note of notes) console.log('  ' + note);
if (failures.length > 0) {
  console.error('\n[PWA] ตรวจไม่ผ่าน:');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('[PWA] ตรวจผ่านทั้งหมด');
