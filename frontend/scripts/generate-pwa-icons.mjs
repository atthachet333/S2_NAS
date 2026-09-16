/**
 * สร้างไอคอน PWA จากโลโก้ต้นฉบับของ S2 NAS (F24-B)
 *
 * ทำไมต้องมีสคริปต์: โลโก้ต้นฉบับเป็นภาพ 1254x1254 ขนาดราว 1.7 MB ซึ่งใหญ่เกินกว่า
 * จะส่งให้โทรศัพท์ทุกเครื่องดาวน์โหลด ไอคอนทุกขนาดจึงถูกสร้างจากไฟล์เดียวกัน
 * เพื่อให้เอกลักษณ์ของแบรนด์เหมือนกันทุกที่ และสร้างซ้ำได้เมื่อโลโก้เปลี่ยน
 *
 * วิธีใช้: node scripts/generate-pwa-icons.mjs
 *
 * sharp ถูกใช้จาก backend ของโปรเจกต์นี้ เพื่อไม่ต้องติดตั้งไลบรารีเนทีฟซ้ำสองที่
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..');
const require = createRequire(import.meta.url);

/** หา sharp จาก frontend ก่อน แล้วค่อยถอยไปใช้ของ backend */
function loadSharp() {
  for (const id of ['sharp', path.join(frontend, '..', 'backend', 'node_modules', 'sharp', 'lib', 'index.js')]) {
    try { return require(id); } catch { /* ลองตัวถัดไป */ }
  }
  throw new Error('ไม่พบ sharp - ติดตั้งที่ frontend หรือ backend ก่อนรันสคริปต์นี้');
}

const sharp = loadSharp();
const SOURCE = path.join(frontend, 'assets-src', 's2-nas-logo-source.png');
const out = (name) => path.join(frontend, 'public', name);

/** พื้นหลังของโลโก้ต้นฉบับ ใช้เติมขอบของไอคอน maskable ให้เนียนไปกับตัวภาพ */
const BACKDROP = { r: 235, g: 235, b: 233, alpha: 1 };

const square = (size) => sharp(SOURCE).resize(size, size, { fit: 'cover' });

/**
 * ไอคอน maskable ต้องเผื่อพื้นที่ปลอดภัย เพราะระบบปฏิบัติการจะครอบภาพเป็นวงกลม
 * หรือสี่เหลี่ยมมนตามอุปกรณ์ ถ้าวางเต็มกรอบ ขอบของโลโก้จะถูกตัดทิ้ง
 * มาตรฐานกำหนดให้เนื้อหาสำคัญอยู่ในวงกลมกลางภาพขนาด 80% ของด้าน
 */
async function maskable(size) {
  const inner = Math.round(size * 0.78);
  const pad = Math.round((size - inner) / 2);
  const logo = await sharp(SOURCE).resize(inner, inner, { fit: 'cover' }).toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: BACKDROP } })
    .composite([{ input: logo, top: pad, left: pad }])
    .png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 });
}

const targets = [
  ['pwa-192x192.png', () => square(192).png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 })],
  ['pwa-512x512.png', () => square(512).png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 })],
  ['pwa-maskable-512x512.png', () => maskable(512)],
  ['apple-touch-icon.png', () => square(180).flatten({ background: BACKDROP }).png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 })],
  ['favicon-32x32.png', () => square(32).png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 })],
  ['favicon-16x16.png', () => square(16).png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 })],
  // โลโก้ที่หน้าจอใช้จริงแสดงผลที่ 36px ขนาด 256px จึงคมพอแม้บนจอความหนาแน่นสูง
  ['s2-nas-logo.png', () => square(256).png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 })],
  ['favicon.png', () => square(256).png({ compressionLevel: 9, palette: true, quality: 82, effort: 10 })],
];

const report = [];
for (const [name, build] of targets) {
  await (await build()).toFile(out(name));
  report.push({ file: name, bytes: (await fs.stat(out(name))).size });
}
console.table(report.map((r) => ({ ...r, kb: (r.bytes / 1024).toFixed(1) })));
console.log('รวม', (report.reduce((s, r) => s + r.bytes, 0) / 1024).toFixed(1), 'KB');
